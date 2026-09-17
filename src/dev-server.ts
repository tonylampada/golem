import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBrowser, rebuild } from './browser-build.ts';
import { discoverAgents, runtimeState } from './runtime/discovery.ts';
import { CodexBackend } from './runtime/codex.ts';
import { SessionManager, type Session, type SessionBackend } from './runtime/session.ts';

const appRoot = resolve(process.cwd());
const root = pathToFileURL(`${process.cwd()}/dist/`);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// The CLI owns logging and signals; this server only serves the built browser shell.
export async function startDevServer(port = 3000, createBackend: () => SessionBackend = () => new CodexBackend(appRoot)): Promise<Server> {
  await buildBrowser();
  const sessions = new SessionManager();
  const server = createServer((request, response) => {
    void handleRequest(request, response, sessions, port, createBackend).catch((error) => {
      if (!response.headersSent) json(response, 400, { error: error instanceof Error ? error.message : 'Malformed request' });
      else response.destroy();
    });
  });
  server.once('close', () => { void sessions.shutdownAll() });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function handleRequest(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  sessions: SessionManager,
  port: number,
  createBackend: () => SessionBackend,
): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    decodeURIComponent(url.pathname);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url, sessions, port, createBackend);
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

function mutationAllowed(request: import('node:http').IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

async function handleApi(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  url: URL,
  sessions: SessionManager,
  port: number,
  createBackend: () => SessionBackend,
): Promise<void> {
  if (request.method === 'GET' && url.pathname === '/api/runtime') {
    const discoveries = await discoverAgents();
    json(response, 200, { discoveries, state: runtimeState(discoveries) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    if (!mutationAllowed(request, port)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
    try {
      const input = await body(request) as { backend?: string };
      if (input.backend !== 'codex') return json(response, 400, { error: 'Only the connected Codex backend can start a session' });
      const session = await sessions.start('codex', createBackend());
      json(response, 201, { id: session.id, backend: session.backend, status: session.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, message.startsWith('Request body') ? 400 : 503, { error: message });
    }
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
    if (!mutationAllowed(request, port)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
    try {
      const input = await body(request) as { text?: unknown };
      if (typeof input.text !== 'string' || !input.text.trim()) return json(response, 400, { error: 'text must be a non-empty string' });
      await session.send(input.text);
      json(response, 202, { status: session.status });
      triggerRebuild(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, message.startsWith('Request body') ? 400 : 409, { error: message, status: session.status });
    }
    return;
  }
  if (request.method === 'POST' && match[2] === 'interrupt') {
    if (!mutationAllowed(request, port)) return json(response, 403, { error: 'Cross-origin mutations are not allowed' });
    await session.interrupt();
    json(response, 200, { status: session.status });
    return;
  }
  json(response, 404, { error: 'Unknown API route' });
}
