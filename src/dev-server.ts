import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBrowser, rebuild } from './browser-build.ts';
import { discoverAgents, runtimeState, type AgentName } from './runtime/discovery.ts';
import { ClaudeBackend } from './runtime/claude.ts';
import { CodexBackend, type SandboxMode } from './runtime/codex.ts';
import { SessionManager, type Session, type SessionBackend } from './runtime/session.ts';
import { ConversationState } from './runtime/state.ts';

const appRoot = resolve(process.cwd());
/** `backend` is omitted by older callers; it then means Codex. */
type CreateBackend = (mode: SandboxMode, threadId?: string, backend?: AgentName) => SessionBackend;
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
  createBackend: CreateBackend = (mode, threadId, backend = 'codex') =>
    backend === 'claude' ? new ClaudeBackend(appRoot, mode, 'claude', [], threadId) : new CodexBackend(appRoot, mode, 'codex', [], threadId),
  stateDirectory = join(appRoot, '.golem'),
  host = '127.0.0.1',
): Promise<Server> {
  await buildBrowser();
  const state = new ConversationState(stateDirectory);
  const sessions = new SessionManager((snapshots) => state.save(snapshots));
  sessions.restore(await state.load(), (snapshot) => createBackend(snapshot.buildMode ? 'danger-full-access' : 'read-only', snapshot.threadId, snapshot.backend));
  const server = createServer((request, response) => {
    void handleRequest(request, response, sessions, port, host, createBackend).catch((error) => {
      if (!response.headersSent) json(response, 400, { error: error instanceof Error ? error.message : 'Malformed request' });
      else response.destroy();
    });
  });
  server.once('close', () => { void sessions.disposeAll().then(() => sessions.flushAll()) });
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
): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    decodeURIComponent(url.pathname);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url, sessions, createBackend);
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

async function body(request: import('node:http').IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 100_000) throw new Error('Request body is too large');
  }
  try { return JSON.parse(text || '{}'); } catch { throw new Error('Request body must be valid JSON'); }
}

/** Fires once after a successful build-mode turn; never blocks the turn's own response. */
function triggerRebuild(session: Session): void {
  void rebuild().then(
    () => session.notifyRebuilt(),
    (error) => session.notifyBuildFailed(error instanceof Error ? error.message : String(error)),
  );
}

function mutationAllowed(request: import('node:http').IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const authority = request.headers.host;
  if (!authority) return false;
  try {
    return origin === new URL(origin).origin && origin === new URL(`http://${authority}`).origin;
  } catch {
    return false;
  }
}

async function handleApi(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  url: URL,
  sessions: SessionManager,
  createBackend: CreateBackend,
): Promise<void> {
  if (request.method === 'GET' && url.pathname === '/api/runtime') {
    const discoveries = await discoverAgents();
    json(response, 200, { discoveries, state: runtimeState(discoveries) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    if (!mutationAllowed(request)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
    try {
      const input = await body(request) as { backend?: string; intent?: string };
      if (input.backend !== 'codex' && input.backend !== 'claude') return json(response, 400, { error: 'backend must be claude or codex' });
      // Server-owned: only an explicit build intent grants filesystem access. Omitted intent stays read-only.
      // danger-full-access, not app-root-confined — see CodexBackend's doc comment for why.
      const buildMode = input.intent === 'build';
      const session = await sessions.start(input.backend, createBackend(buildMode ? 'danger-full-access' : 'read-only', undefined, input.backend), buildMode);
      json(response, 201, { id: session.id, backend: session.backend, status: session.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, message.startsWith('Request body') ? 400 : 503, { error: message });
    }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/sessions/latest') {
    const latest = sessions.latest();
    if (!latest) return json(response, 404, { error: 'No saved build conversation' });
    json(response, 200, { id: latest.id, backend: latest.backend, status: latest.status });
    return;
  }
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(history|events|interrupt))?$/);
  if (!match) return json(response, 404, { error: 'Unknown API route' });
  const session = sessions.get(match[1]);
  if (!session) return json(response, 404, { error: 'Unknown session' });
  if (request.method === 'GET' && match[2] === 'history') {
    json(response, 200, { events: session.history, status: session.status, backend: session.backend });
    return;
  }
  if (request.method === 'GET' && match[2] === 'events') {
    const after = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? '-1');
    if (!Number.isInteger(after)) return json(response, 400, { error: 'after must be an integer sequence' });
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.flushHeaders();
    const write = (event: { sequence: number }) => response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = session.subscribeFrom(after, write);
    request.on('close', unsubscribe);
    return;
  }
  if (request.method === 'POST' && !match[2]) {
    if (!mutationAllowed(request)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
    try {
      const input = await body(request) as { text?: unknown; clientMessageId?: unknown; attachments?: unknown };
      if (typeof input.text !== 'string' || !input.text.trim()) return json(response, 400, { error: 'text must be a non-empty string' });
      if (typeof input.clientMessageId !== 'string' || !input.clientMessageId) return json(response, 400, { error: 'clientMessageId is required' });
      const attachments = Array.isArray(input.attachments) && input.attachments.every((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && (item.size === undefined || typeof item.size === 'number')) ? input.attachments : undefined;
      if (input.attachments !== undefined && !attachments) return json(response, 400, { error: 'attachments must contain a name and id' });
      const accepted = await session.accept(input.text, input.clientMessageId, attachments);
      json(response, 202, { status: session.status, duplicate: accepted.duplicate });
      if (!accepted.duplicate && accepted.completion) void accepted.completion.then(
        () => { if (session.buildMode) triggerRebuild(session); },
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
