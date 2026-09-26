import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBrowser, rebuild } from './browser-build.ts';
import { createAppBackend, type AppBackend } from './backend/http.ts';
import { anonymous } from './operations.ts';
import { ordinaryChat, type OrdinaryChat } from './chat.ts';
import { openBrain } from './brain.ts';
import { chatPermissions, serverUrl } from './config.ts';
import { discoverAgents, runtimeState, type AgentName } from './runtime/discovery.ts';
import { SessionManager, type Session, type SessionBackend, type SessionSnapshot } from './runtime/session.ts';
import { TmuxBackend, chatInstructions, type HarnessRef } from './runtime/tmux.ts';
import { ConversationState } from './runtime/state.ts';

const appRoot = resolve(process.cwd());
/** `ref` is the saved harness ref of a restored conversation; a new one has none. `buildMode` picks the window: `builder` or `chat`. */
type CreateBackend = (backend: AgentName, ref?: HarnessRef, buildMode?: boolean) => SessionBackend | Promise<SessionBackend>;
/** The app-wide Builder switch, kept in `.golem/builder.json` so a reload comes back in the same mode. */
type BuilderFlag = { get(): boolean; set(on: boolean): Promise<void> };
async function builderFlag(stateDirectory: string): Promise<BuilderFlag> {
  const file = join(stateDirectory, 'builder.json');
  let on = await readFile(file, 'utf8').then((text) => Boolean(JSON.parse(text).builder), () => false);
  return {
    get: () => on,
    async set(next) { on = next; await mkdir(stateDirectory, { recursive: true }); await writeFile(file, JSON.stringify({ builder: next }) + '\n'); },
  };
}
const root = pathToFileURL(`${process.cwd()}/dist/`);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// The CLI owns logging and signals; this server only serves the built browser shell.
export async function startDevServer(
  port = 3000,
  createBackend?: CreateBackend,
  stateDirectory = join(appRoot, '.golem'),
  host = '127.0.0.1',
): Promise<Server> {
  await buildBrowser();
  // A new session needs a runnable CLI; a restored one keeps its ref and resumes on its next message.
  createBackend ??= async (backend, ref, buildMode = true) => {
    if (!ref && !(await discoverAgents()).some((found) => found.agent === backend && found.runnable)) throw new Error(`${backend} is not runnable here`);
    const model = buildMode ? app.config.agents?.builderModel : app.config.chat?.provider === 'tmux' ? app.config.chat.model : undefined;
    return new TmuxBackend(appRoot, backend, ref, { stateDir: join(stateDirectory, 'harness'), api: serverUrl(host, port), window: buildMode ? 'builder' : 'chat', ...(model ? { model } : {}), ...(buildMode ? {} : { instructions: chatInstructions(appRoot, app.app.views.actions()), permissions: chatPermissions(app.config.chat) }) });
  };
  const builder = await builderFlag(stateDirectory);
  const state = new ConversationState(stateDirectory);
  // Retired conversations are no longer live, but they stay in the file: `save` writes them back beside the rest.
  let retired: SessionSnapshot[] = [];
  const sessions = new SessionManager((snapshots) => state.save([...retired, ...snapshots]));
  const app = await createAppBackend(appRoot, join(stateDirectory, 'data'));
  const chat = ordinaryChat(app);
  const brain = app.config.brain ? openBrain(join(appRoot, 'brain')) : undefined;
  // Views of a conversation belong to whoever owns that conversation. A terminal-agent conversation has
  // no browser cookie of its own: without accounts the single local person owns it, and with accounts its
  // owner is the account that started it.
  app.app.views.useConversations({
    owner: (request, principal) => chat.owner(request, principal) ?? (app.accounts ? null : 'local'),
    owns: (conversation, owner) => {
      const session = sessions.get(conversation);
      if (!session) return false;
      return session.backend === 'anthropic' ? session.owner === owner : (session.owner ?? 'local') === owner;
    },
  });
  // Restored conversations wait for their next message; nothing is re-run.
  const saved = await state.load();
  // A pin follows its agent: when the app changes `chat.agent` (or `agents.builder`), the conversation saved
  // on the old agent is retired rather than resumed, so the new agent's model never reaches the old CLI. It
  // stays readable in the file, marked; the browser finds no conversation and starts one on the new agent.
  const agentOf = (buildMode: boolean) => buildMode ? app.config.agents?.builder : app.config.chat?.provider === 'tmux' ? app.config.chat.agent : undefined;
  const stale = saved.filter((snapshot) => !snapshot.retired && snapshot.backend !== 'anthropic'
    && agentOf(snapshot.buildMode) !== undefined && agentOf(snapshot.buildMode) !== snapshot.backend);
  for (const snapshot of stale) console.log(`Retired the ${snapshot.buildMode ? 'builder' : 'chat'} conversation on ${snapshot.backend}: this app now runs ${agentOf(snapshot.buildMode)}.`);
  retired = saved.filter((snapshot) => snapshot.retired || stale.includes(snapshot)).map((snapshot) => ({ ...snapshot, retired: true }));
  const restored = saved.filter((snapshot) => !snapshot.retired && !stale.includes(snapshot));
  const workers = await Promise.all(restored.map((snapshot) => snapshot.backend === 'anthropic'
    ? chat.backend(snapshot.transcript)
    : createBackend(snapshot.backend, snapshot.harness as HarnessRef | undefined, snapshot.buildMode)));
  sessions.restore(restored, (snapshot: SessionSnapshot) => workers[restored.indexOf(snapshot)]);
  const { accounts } = app;
  if (accounts) {
    // Printed to the terminal that owns the data, never served: a fresh store, or a deliberate recovery.
    const invite = await accounts.managerInvite(app.origin(new URL(serverUrl(host, port)).host), process.env.GOLEM_ADMIN_INVITE === '1');
    if (invite) console.log(`Admin invite (one use, expires in 24 hours): ${invite}`);
    // A build turn runs with full file access: stop it once its owner may no longer build or has signed out everywhere.
    accounts.changes.on('change', (accountId: string) => {
      for (const session of sessions.all()) {
        if (session.owner !== accountId || !session.snapshot().active) continue;
        // A chat turn acts as the browser session that sent it; it stops once that session ends.
        if (session.backend === 'anthropic') {
          const turn = session.activeContext;
          if (turn) void app.app.refresh(turn.principal).then(() => {}, () => session.interrupt());
          continue;
        }
        void accounts.resolveAccount(accountId)
          .then(async (principal) => accounts.canBuild(principal) && await accounts.signedIn(accountId), () => false)
          .then((allowed) => { if (!allowed) return session.interrupt(); });
      }
    });
  }
  const server = createServer((request, response) => {
    void (request.url?.startsWith('/api/app/') || request.url?.startsWith('/api/auth/') ? app.handle(request, response) : request.url?.startsWith('/api/brain/') ? handleBrain(request, response, app, brain) : handleRequest(request, response, sessions, port, host, createBackend, app, chat, builder)).catch((error) => {
      if (!response.headersSent) json(response, 400, { error: error instanceof Error ? error.message : 'Malformed request' });
      else response.destroy();
    });
  });
  server.once('close', () => { void sessions.disposeAll().then(() => sessions.flushAll()).finally(() => app.close()) });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function handleRequest(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  sessions: SessionManager,
  port: number,
  host: string,
  createBackend: CreateBackend,
  app: AppBackend,
  chat: OrdinaryChat,
  builder: BuilderFlag,
): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    decodeURIComponent(url.pathname);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url, sessions, createBackend, app, chat, builder);
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Malformed URL\n');
      return;
    }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const normalized = normalize(join('.', relative));
    const file = new URL(normalized, root);
    if (!file.pathname.startsWith(root.pathname)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': types[extname(relative)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      if (extname(relative)) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found\n');
        return;
      }
      try {
        const body = await readFile(new URL('index.html', root));
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(body);
      } catch {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Run `./golem build` before starting the dev server.\n');
      }
    }
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

/** The app's brain, read-only: whoever may see the app may read it. */
async function handleBrain(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, app: AppBackend, brain: ReturnType<typeof openBrain> | undefined): Promise<void> {
  if (!brain || request.method !== 'GET') return json(response, 404, { error: 'This app has no brain' });
  const principal = await app.app.resolvePrincipal(request);
  if (app.accounts && !app.accounts.config.guests && principal.kind === 'anonymous') return json(response, 401, { error: 'Sign in to read the brain.' });
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const param = (name: string) => url.searchParams.get(name) ?? '';
  switch (url.pathname) {
    case '/api/brain/index': return json(response, 200, { text: await brain.index(param('dir')) });
    case '/api/brain/list': return json(response, 200, { entries: await brain.list(param('dir')) });
    case '/api/brain/read': return json(response, 200, { text: await brain.read(param('path')) });
    case '/api/brain/search': return json(response, 200, { hits: await brain.search(param('q')) });
    case '/api/brain/events': {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.flushHeaders();
      const stop = brain.watch(() => response.write('data: {}\n\n'));
      request.on('close', stop);
      return;
    }
    default: return json(response, 404, { error: 'Unknown API route' });
  }
}

async function body(request: import('node:http').IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 100_000) throw new Error('Request body is too large');
  }
  try { return JSON.parse(text || '{}'); } catch { throw new Error('Request body must be valid JSON'); }
}

/**
 * Fires once after a successful build-mode turn; never blocks the turn's own response.
 * The app's server module reloads before the refresh, so the new UI never talks to old operations.
 */
function triggerRebuild(session: Session, reloadServer: () => Promise<void>): void {
  void distFingerprint().then(async (before) => {
    await rebuild();
    await reloadServer();
    // Vite content-hashes asset names, so index.html changes iff the bundle did: a chat-only
    // turn (or a server-only edit) leaves the page alone instead of reloading it.
    if (await distFingerprint() !== before) session.notifyRebuilt();
  }).catch((error: unknown) => session.notifyBuildFailed(error instanceof Error ? error.message : String(error)));
}

const distFingerprint = (): Promise<string> => readFile(new URL('index.html', root))
  .then((html) => createHash('sha1').update(html).digest('hex'), () => '');

// ---------- pane hub: the Terminal popup's live agent screen ----------
// Copied from Bridge Commander's paneStream: one harness feed per session, ref-counted across
// browser tabs; the first subscriber opens it, the last disconnect closes it. Guards are clean
// SSE events then end, never a 500 (the client is an EventSource and cannot read error bodies):
//   unsupported — this backend has no screen to show
//   no-pane     — the agent has not been spawned yet, or the open failed
//   busy        — the concurrent-feed cap is hit
const PANE_MAX = 8;
type PaneHub = { clients: Set<import('node:http').ServerResponse>; handle: { close(): void } | null; last: string | null };
const panes = new Map<string, PaneHub>();
function paneWrite(response: import('node:http').ServerResponse, event: string, data: unknown = {}): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function paneStream(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, session: Session): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  response.flushHeaders();
  if (!session.worker.pane) { paneWrite(response, 'unsupported'); response.end(); return; }
  const pane = session.worker.pane();
  if (!pane) { paneWrite(response, 'no-pane', { reason: 'the agent has not started yet; send a message first' }); response.end(); return; }
  let hub = panes.get(session.id);
  if (!hub) {
    if (panes.size >= PANE_MAX) { paneWrite(response, 'busy', { max: PANE_MAX }); response.end(); return; }
    const created: PaneHub = { clients: new Set(), handle: null, last: null };
    hub = created;
    panes.set(session.id, created);
    console.log(`[pane] openPane ${session.id}`);
    Promise.resolve(pane.open((frame) => {
      created.last = String(frame);
      for (const client of created.clients) paneWrite(client, 'frame', created.last);
    })).then((handle) => {
      if (panes.get(session.id) === created) { created.handle = handle; return; }
      try { handle.close(); } catch { /* everyone left before the open resolved */ }
    }).catch((error: unknown) => {
      if (panes.get(session.id) !== created) return;
      panes.delete(session.id);
      for (const client of created.clients) { paneWrite(client, 'no-pane', { reason: `open failed: ${error instanceof Error ? error.message : String(error)}` }); client.end(); }
    });
  }
  const joined = hub;
  joined.clients.add(response);
  // Immediate paint: late joiners get the last frame, the first subscriber a one-shot snapshot.
  if (joined.last != null) paneWrite(response, 'frame', joined.last);
  else pane.snapshot().then((snap) => { if (joined.last == null && joined.clients.has(response) && snap) paneWrite(response, 'frame', snap); }, () => {});
  request.on('close', () => {
    joined.clients.delete(response);
    if (joined.clients.size) return;
    panes.delete(session.id);
    console.log(`[pane] closePane ${session.id}`);
    try { joined.handle?.close(); } catch { /* already gone */ }
  });
}

async function handleApi(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  url: URL,
  sessions: SessionManager,
  createBackend: CreateBackend,
  app: AppBackend,
  chat: OrdinaryChat,
  builder: BuilderFlag,
): Promise<void> {
  const reloadServer = app.reload;
  const { accounts } = app;
  const mutationAllowed = app.mutationAllowed;
  // With accounts, every build route needs a signed-in account allowed to build, and a
  // conversation belongs to the account that started it. Ownerless (older) ones go to managers.
  const principal = await app.app.resolvePrincipal(request);
  // Ordinary chat never touches the build routes below: its conversations belong to one owner.
  const chatOwner = chat.owner(request, principal);
  // The app's chat rule: signed in (or a guest where guests are allowed), and holding one of
  // `chat.roles` when the app names them. Builder mode is a separate permission below.
  const chatRoles = app.config.chat?.roles;
  const chats = (who: typeof principal) => !(accounts && !accounts.config.guests && who.kind === 'anonymous')
    && (!chatRoles || (who.kind === 'user' && who.roles.some((role) => chatRoles.includes(role))));
  // Without accounts the app is the local single-person mode, where everything is open.
  const mayChat = (Boolean(app.config.chat) || !accounts) && chats(principal);
  const denied = (what: 'build' | 'chat') => json(response, principal.kind === 'anonymous' ? 401 : 403,
    { error: principal.kind === 'anonymous' ? `Sign in to ${what}.` : `Your account may not ${what === 'build' ? 'build this app' : 'chat in this app'}.` });
  if (url.pathname === '/api/chat') {
    if (request.method === 'GET') {
      // Signed out with guests off, or a role the app does not let chat: this app offers you no
      // chat, so the shell shows no chat toggle. Builder mode has its own permission below.
      if (!mayChat) return json(response, 200, { provider: null, available: false });
      const latest = chatOwner ? sessions.latest((session) => session.backend === 'anthropic' && session.owner === chatOwner) : undefined;
      // `provider` is the app's rule for normal mode: null means no chat column outside builder mode.
      const provider = app.config.chat?.provider ?? null;
      return json(response, 200, { provider, agent: app.config.chat?.provider === 'tmux' ? app.config.chat.agent : undefined, available: provider === 'tmux' || chat.available, detail: provider === 'tmux' ? undefined : chat.detail, views: chat.views(), latest: latest && { id: latest.id, status: latest.status } });
    }
    if (request.method !== 'POST') return json(response, 404, { error: 'Unknown API route' });
    if (!mayChat) return denied('chat');
    if (!mutationAllowed(request)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
    if (!chat.available) return json(response, 503, { error: chat.detail });
    const issued = chatOwner ? undefined : chat.issue();
    const session = await sessions.start('anthropic', chat.backend(), false, chatOwner ?? issued!.owner);
    if (issued) response.setHeader('Set-Cookie', issued.header);
    return json(response, 201, { id: session.id, backend: session.backend, status: session.status });
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)/);
  // `golem say` from the agent's own tmux session: the reply to the user. Local-only and unauthenticated
  // on purpose, the agent has no principal; the server binds to loopback.
  if (request.method === 'POST' && sessionMatch && url.pathname === `/api/sessions/${sessionMatch[1]}/say`) {
    const said = sessions.get(sessionMatch[1]);
    if (!said || said.backend === 'anthropic') return json(response, 404, { error: 'Unknown session' });
    const input = await body(request) as { text?: unknown };
    if (typeof input.text !== 'string' || !input.text.trim()) return json(response, 400, { error: 'text must be a non-empty string' });
    said.receive({ type: 'message', text: input.text });
    await said.flush();
    return json(response, 202, { status: said.status });
  }
  // `golem show` from the agent's own tmux session: an offer to point the app at one of its screens.
  // Local-only and unauthenticated like `say`; the offer is applied only where the person accepts it.
  if (request.method === 'POST' && sessionMatch && url.pathname === `/api/sessions/${sessionMatch[1]}/show`) {
    const shown = sessions.get(sessionMatch[1]);
    if (!shown || shown.backend === 'anthropic') return json(response, 404, { error: 'Unknown session' });
    const input = await body(request) as { action?: unknown; input?: unknown };
    if (typeof input.action !== 'string' || !input.action) return json(response, 400, { error: 'action must be a view action name' });
    if (!shown.view) return json(response, 409, { error: 'Nobody has this conversation open in a browser, so there is no screen to point at.' });
    const owner = shown.owner ?? (accounts ? null : 'local');
    if (owner === null) return json(response, 409, { error: 'This conversation has no owner to act for.' });
    try {
      // The agent acts as the person whose conversation this is; their rules still decide what it may read.
      const acting = shown.owner && accounts ? await accounts.resolveAccount(shown.owner) : anonymous;
      const { offer } = await app.app.views.request({ principal: acting, owner, conversation: shown.id, view: shown.view }, input.action, input.input ?? {});
      return json(response, 202, { offered: offer.action });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  const mayBuild = !accounts || accounts.canBuild(principal);
  // The Builder switch: whoever may build flips it; everyone else reads it as off.
  if (url.pathname === '/api/builder') {
    if (request.method === 'GET') return json(response, 200, { builder: mayBuild && builder.get() });
    if (request.method !== 'POST') return json(response, 404, { error: 'Unknown API route' });
    if (!mayBuild) return json(response, principal.kind === 'anonymous' ? 401 : 403, { error: 'Your account may not build this app.' });
    if (!mutationAllowed(request)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
    const input = await body(request) as { builder?: unknown };
    if (typeof input.builder !== 'boolean') return json(response, 400, { error: 'builder must be a boolean' });
    await builder.set(input.builder);
    if (!input.builder) await sessions.parkOthers(true); // leaving builder mode parks the builder agent
    return json(response, 200, { builder: input.builder });
  }
  // The session routes below serve build mode and normal-mode chat alike, so each needs the rights
  // of the mode it belongs to: a conversation carries its own `buildMode`, `/api/sessions/latest`
  // says which it wants, and `POST /api/sessions` is judged below once its intent is parsed.
  // `/api/runtime` is which agents this computer has; a terminal-agent chat needs it to pick one too.
  const targetSession = sessionMatch ? sessions.get(sessionMatch[1]) : undefined;
  const needs: 'chat' | 'build' | 'either' | undefined = targetSession ? (targetSession.buildMode ? 'build' : 'chat')
    : url.pathname === '/api/runtime' ? (app.config.chat?.provider === 'tmux' ? 'either' : 'build')
    : url.pathname === '/api/sessions/latest' ? (url.searchParams.get('chat') === '1' ? 'chat' : 'build')
    : url.pathname === '/api/sessions' ? undefined
    : 'build';
  if (needs && !(needs === 'chat' ? mayChat : needs === 'build' ? mayBuild : mayBuild || mayChat)) return denied(needs === 'chat' ? 'chat' : 'build');
  const owner = accounts && principal.kind === 'user' ? principal.id : undefined;
  const visible = (session: Session) => session.backend === 'anthropic'
    ? mayChat && chatOwner !== null && session.owner === chatOwner
    : !accounts || session.owner === owner || (!session.owner && accounts.manages(principal));
  if (request.method === 'GET' && url.pathname === '/api/runtime') {
    const discoveries = await discoverAgents();
    json(response, 200, { discoveries, state: runtimeState(discoveries), builder: app.config.agents?.builder });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    if (!mutationAllowed(request)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
    try {
      const input = await body(request) as { backend?: string; intent?: string };
      if (input.backend !== 'codex' && input.backend !== 'claude') return json(response, 400, { error: 'backend must be claude or codex' });
      // Every agent session runs with the CLI's own bypass flags in the app root, the way Bridge Commander runs its workers.
      const buildMode = input.intent === 'build';
      if (!(buildMode ? mayBuild : mayChat)) return denied(buildMode ? 'build' : 'chat');
      await sessions.parkOthers(buildMode); // one agent per window: the new one takes it
      const session = await sessions.start(input.backend, await createBackend(input.backend, undefined, buildMode), buildMode, owner);
      json(response, 201, { id: session.id, backend: session.backend, status: session.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, message.startsWith('Request body') ? 400 : 503, { error: message });
    }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/sessions/latest') {
    // `?chat=1`: the latest normal-mode terminal-agent conversation instead of the latest build one.
    const wantChat = url.searchParams.get('chat') === '1';
    const latest = sessions.latest((session) => session.backend !== 'anthropic' && session.buildMode === !wantChat && visible(session));
    if (!latest) return json(response, 404, { error: 'No saved build conversation' });
    json(response, 200, { id: latest.id, backend: latest.backend, status: latest.status });
    return;
  }
  // The Terminal popup: the agent's live screen (SSE frames) and raw keystrokes into it.
  const paneMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/pane\/(stream|input)$/);
  if (paneMatch) {
    const target = sessions.get(paneMatch[1]);
    if (!target || !visible(target)) return json(response, 404, { error: 'Unknown session' });
    if (request.method === 'GET' && paneMatch[2] === 'stream') return paneStream(request, response, target);
    if (request.method === 'POST' && paneMatch[2] === 'input') {
      if (!mutationAllowed(request)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
      const pane = target.worker.pane?.();
      if (!target.worker.pane) return json(response, 501, { error: 'this backend cannot take pane input' });
      if (!pane) return json(response, 404, { error: 'the agent has not started yet' });
      const input = await body(request) as { key?: unknown; text?: unknown };
      // Validation (key XOR text, tmux key grammar, size cap) is the harness's validatePaneInput; a refusal is a 502 like BC.
      try { await pane.input({ key: input.key as string | undefined, text: input.text as string | undefined }); }
      catch (error) { return json(response, 502, { error: error instanceof Error ? error.message : String(error) }); }
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: 'Unknown API route' });
  }
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(history|events|interrupt|commands|command))?$/);
  if (!match) return json(response, 404, { error: 'Unknown API route' });
  const session = sessions.get(match[1]);
  if (!session || !visible(session)) return json(response, 404, { error: 'Unknown session' });
  // Slash commands: `/reset` is the server's, the rest are the harness's own (`/status`, `/compact`, …).
  if (request.method === 'GET' && match[2] === 'commands') {
    return json(response, 200, { commands: [{ name: '/reset', description: 'park this conversation and start a fresh one with the same agent' }, ...(session.worker.commands?.() ?? [])] });
  }
  if (request.method === 'POST' && match[2] === 'command') {
    if (!mutationAllowed(request)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
    const input = await body(request) as { line?: unknown };
    const line = typeof input.line === 'string' ? input.line.trim() : '';
    if (!line.startsWith('/')) return json(response, 400, { error: 'line must be a /command' });
    try {
      if (line.split(/\s+/)[0] === '/reset') {
        // Same backend, same owner, same window: the old conversation is parked (resumable), the new agent takes the window.
        await session.park();
        const fresh = session.backend === 'anthropic'
          ? await sessions.start('anthropic', chat.backend(), false, session.owner)
          : (await sessions.parkOthers(session.buildMode), await sessions.start(session.backend, await createBackend(session.backend, undefined, session.buildMode), session.buildMode, session.owner));
        return json(response, 200, { text: `New conversation ${fresh.id.slice(0, 8)} started${session.backend === 'anthropic' ? '' : ' in the same terminal window'}; the previous one is parked.`, session: fresh.id });
      }
      if (!session.worker.runCommand) throw new Error(`unknown command ${line.split(/\s+/)[0]}`);
      return json(response, 200, { text: await session.worker.runCommand(line) });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (request.method === 'GET' && match[2] === 'history') {
    json(response, 200, { events: session.history, status: session.status, backend: session.backend });
    return;
  }
  if (request.method === 'GET' && match[2] === 'events') {
    const after = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? '-1');
    if (!Number.isInteger(after)) return json(response, 400, { error: 'after must be an integer sequence' });
    // A chat tab's source view rides on this stream (browsers allow few connections per host):
    // it opens with the tab's id as a `view` event, and closes with the stream.
    // A terminal agent reaches this view through `./golem show`, the assistant through `view.request`.
    const wantsView = url.searchParams.get('view') === '1'
      && (session.backend === 'anthropic' ? chat.views() : app.app.views.actions().length > 0);
    const view = wantsView ? await app.app.views.open(request, principal, session.id).catch(() => undefined) : undefined;
    const closeView = view && await app.app.views.connect(request, principal, view.id, (event) => response.write(`event: view\ndata: ${JSON.stringify(event)}\n\n`));
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.flushHeaders();
    if (view) response.write(`event: view\ndata: ${JSON.stringify({ type: 'view', id: view.id })}\n\n`);
    request.on('close', () => closeView?.());
    const write = (event: { sequence: number }) => response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = session.subscribeFrom(after, write);
    // Re-resolve this same request when its account changes; a reader who may no longer build loses the stream.
    const recheck = (accountId: string) => {
      if (accountId !== owner) return;
      void app.app.resolvePrincipal(request).then((now) => {
        const allowed = session.backend === 'anthropic' ? chats(now) && now.kind === 'user' && now.id === session.owner
          : session.buildMode ? accounts!.canBuild(now) : chats(now);
        if (!allowed) response.end();
      }, () => response.end());
    };
    accounts?.changes.on('change', recheck);
    request.on('close', () => { unsubscribe(); accounts?.changes.off('change', recheck); });
    return;
  }
  if (request.method === 'POST' && !match[2]) {
    if (!mutationAllowed(request)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
    try {
      const input = await body(request) as { text?: unknown; clientMessageId?: unknown; attachments?: unknown; view?: unknown };
      if (typeof input.text !== 'string' || !input.text.trim()) return json(response, 400, { error: 'text must be a non-empty string' });
      if (typeof input.clientMessageId !== 'string' || !input.clientMessageId) return json(response, 400, { error: 'clientMessageId is required' });
      const attachments = Array.isArray(input.attachments) && input.attachments.every((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && (item.size === undefined || typeof item.size === 'number')) ? input.attachments : undefined;
      if (input.attachments !== undefined && !attachments) return json(response, 400, { error: 'attachments must contain a name and id' });
      // A chat message carries its sender, fixed here from this request; the turn acts as them.
      // Who owns this conversation, the way `views.useConversations` decides it.
      const owns = session.backend === 'anthropic' ? chatOwner : session.owner ?? (accounts ? null : 'local');
      const context = session.backend === 'anthropic' ? { principal, owner: chatOwner!, conversation: session.id, ...(input.view === undefined ? {} : { view: input.view as string }) } : undefined;
      // A view names the tab that sent this message; it must be that person's view of this conversation.
      // A terminal agent has no turn context, so the conversation remembers the tab for `./golem show`.
      if (input.view !== undefined) {
        const binding = context ?? (owns === null ? null : { principal, owner: owns, conversation: session.id });
        if (typeof input.view !== 'string' || !binding || !(await app.app.views.bound(input.view, binding))) {
          return json(response, 400, { error: 'That view does not belong to this conversation.' });
        }
        session.view = input.view;
      }
      // A parked conversation takes the app's tmux session back before its agent resumes there.
      if (session.backend !== 'anthropic' && !session.live) await sessions.parkOthers(session.buildMode, session.id);
      const accepted = await session.accept(input.text, input.clientMessageId, attachments, context);
      json(response, 202, { status: session.status, duplicate: accepted.duplicate });
      if (!accepted.duplicate && accepted.completion) void accepted.completion.then(
        () => { if (session.buildMode) triggerRebuild(session, reloadServer); },
        () => {},
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, message.startsWith('Request body') ? 400 : 409, { error: message, status: session.status });
    }
    return;
  }
  if (request.method === 'POST' && match[2] === 'interrupt') {
    if (!mutationAllowed(request)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
    await session.interrupt();
    await session.flush();
    json(response, 200, { status: session.status });
    return;
  }
  json(response, 404, { error: 'Unknown API route' });
}
