import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBrowser, rebuild } from './browser-build.ts';
import { createAppBackend, type AppBackend } from './backend/http.ts';
import { ordinaryChat, type OrdinaryChat } from './chat.ts';
import { openBrain } from './brain.ts';
import { serverUrl } from './config.ts';
import { discoverAgents, runtimeState, type AgentName } from './runtime/discovery.ts';
import { SessionManager, type Session, type SessionBackend, type SessionSnapshot } from './runtime/session.ts';
import { TmuxBackend, type HarnessRef } from './runtime/tmux.ts';
import { ConversationState } from './runtime/state.ts';

const appRoot = resolve(process.cwd());
/** `ref` is the saved harness ref of a restored conversation; a new one has none. */
type CreateBackend = (backend: AgentName, ref?: HarnessRef) => SessionBackend | Promise<SessionBackend>;
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
  createBackend ??= async (backend, ref) => {
    if (!ref && !(await discoverAgents()).some((found) => found.agent === backend && found.runnable)) throw new Error(`${backend} is not runnable here`);
    return new TmuxBackend(appRoot, backend, ref, { stateDir: join(stateDirectory, 'harness'), api: serverUrl(host, port) });
  };
  const state = new ConversationState(stateDirectory);
  const sessions = new SessionManager((snapshots) => state.save(snapshots));
  const app = await createAppBackend(appRoot, join(stateDirectory, 'data'));
  const chat = ordinaryChat(app);
  const brain = app.config.brain ? openBrain(join(appRoot, 'brain')) : undefined;
  // Source views of a chat belong to whoever owns that chat.
  app.app.views.useConversations({
    owner: (request, principal) => chat.owner(request, principal),
    owns: (conversation, owner) => { const session = sessions.get(conversation); return session?.backend === 'anthropic' && session.owner === owner; },
  });
  // Restored conversations wait for their next message; nothing is re-run.
  const restored = await state.load();
  const workers = await Promise.all(restored.map((snapshot) => snapshot.backend === 'anthropic'
    ? chat.backend(snapshot.transcript)
    : createBackend(snapshot.backend, snapshot.harness as HarnessRef | undefined)));
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
    void (request.url?.startsWith('/api/app/') || request.url?.startsWith('/api/auth/') ? app.handle(request, response) : request.url?.startsWith('/api/brain/') ? handleBrain(request, response, app, brain) : handleRequest(request, response, sessions, port, host, createBackend, app, chat)).catch((error) => {
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
): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    decodeURIComponent(url.pathname);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url, sessions, createBackend, app, chat);
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
): Promise<void> {
  const reloadServer = app.reload;
  const { accounts } = app;
  const mutationAllowed = app.mutationAllowed;
  // With accounts, every build route needs a signed-in account allowed to build, and a
  // conversation belongs to the account that started it. Ownerless (older) ones go to managers.
  const principal = await app.app.resolvePrincipal(request);
  // Ordinary chat never touches the build routes below: its conversations belong to one owner.
  const chatOwner = chat.owner(request, principal);
  const mayChat = !(accounts && !accounts.config.guests && principal.kind === 'anonymous');
  if (url.pathname === '/api/chat') {
    if (!mayChat) return json(response, 401, { error: 'Sign in to chat.' });
    if (request.method === 'GET') {
      const latest = chatOwner ? sessions.latest((session) => session.backend === 'anthropic' && session.owner === chatOwner) : undefined;
      return json(response, 200, { available: chat.available, detail: chat.detail, views: chat.views(), latest: latest && { id: latest.id, status: latest.status } });
    }
    if (request.method !== 'POST') return json(response, 404, { error: 'Unknown API route' });
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
  const chatSession = sessionMatch && sessions.get(sessionMatch[1])?.backend === 'anthropic';
  if (!chatSession && accounts && !accounts.canBuild(principal)) {
    return json(response, principal.kind === 'anonymous' ? 401 : 403, { error: principal.kind === 'anonymous' ? 'Sign in to build.' : 'Your account may not build this app.' });
  }
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
      await sessions.parkOthers(); // one agent per app: the new one takes the tmux session
      const session = await sessions.start(input.backend, await createBackend(input.backend), buildMode, owner);
      json(response, 201, { id: session.id, backend: session.backend, status: session.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, message.startsWith('Request body') ? 400 : 503, { error: message });
    }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/sessions/latest') {
    const latest = sessions.latest((session) => session.buildMode && visible(session));
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
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(history|events|interrupt))?$/);
  if (!match) return json(response, 404, { error: 'Unknown API route' });
  const session = sessions.get(match[1]);
  if (!session || !visible(session)) return json(response, 404, { error: 'Unknown session' });
  if (request.method === 'GET' && match[2] === 'history') {
    json(response, 200, { events: session.history, status: session.status, backend: session.backend });
    return;
  }
  if (request.method === 'GET' && match[2] === 'events') {
    const after = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? '-1');
    if (!Number.isInteger(after)) return json(response, 400, { error: 'after must be an integer sequence' });
    // A chat tab's source view rides on this stream (browsers allow few connections per host):
    // it opens with the tab's id as a `view` event, and closes with the stream.
    const view = session.backend === 'anthropic' && url.searchParams.get('view') === '1' && chat.views()
      ? await app.app.views.open(request, principal, session.id) : undefined;
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
        const allowed = session.backend === 'anthropic' ? now.kind === 'user' && now.id === session.owner : accounts!.canBuild(now);
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
      const context = session.backend === 'anthropic' ? { principal, owner: chatOwner!, conversation: session.id, ...(input.view === undefined ? {} : { view: input.view as string }) } : undefined;
      // A view names the tab that sent this message; it must be that person's view of this chat.
      if (input.view !== undefined && !(session.backend === 'anthropic' && typeof input.view === 'string' && await app.app.views.bound(input.view, context!))) {
        return json(response, 400, { error: 'That view does not belong to this conversation.' });
      }
      // A parked conversation takes the app's tmux session back before its agent resumes there.
      if (session.backend !== 'anthropic' && !session.live) await sessions.parkOthers(session.id);
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
