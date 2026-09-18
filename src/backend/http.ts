import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadAppConfig } from '../config.ts'
import { build } from 'vite'
import { AppError, type RecordStore } from '../operations.ts'
import { createApp, type App, type AppServerModule } from './app.ts'
import { diskFiles } from './files.ts'
import { jsonlStore } from './jsonl.ts'

const maxJson = 1_000_000
// Uploads are buffered in memory; stream to disk if apps need files past this size.
const maxUpload = 25_000_000

export type AppBackend = {
  app: App
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>
  /** Re-reads src/server/index.ts and its local imports; on failure the running module stays. */
  reload(): Promise<void>
  close(): Promise<void>
}

/** Loads golem.config.ts storage and the optional app-owned src/server/index.ts, and serves /api/app/*. */
export async function createAppBackend(appRoot: string, dataDirectory: string): Promise<AppBackend> {
  const { storage } = await loadAppConfig(appRoot)
  const records: RecordStore = storage === 'sqlite'
    ? (await import('./sqlite.ts')).sqliteStore(join(dataDirectory, 'records.sqlite'))
    : await jsonlStore(join(dataDirectory, 'records'))
  // One load at a time: each rebuilds the same output directory.
  let loading: Promise<unknown> = Promise.resolve()
  const load = () => {
    const next = loading.then(() => loadServerModule(appRoot, join(dataDirectory, '..', 'server')))
    loading = next.catch(() => {})
    return next
  }
  // FileStore writes metadata through the app's watched store, so file changes reach subscribers.
  const app = createApp({ records, files: (watched) => diskFiles(join(dataDirectory, 'files'), watched) }, await load())
  return {
    app,
    handle: (request, response) => handle(app, request, response),
    reload: async () => app.use(await load()),
    close: () => records.close(),
  }
}

let generation = 0

/**
 * Bundles the app's own server files into one module and imports it under a fresh URL, so an edit
 * to any local file is picked up. Packages stay external and shared with the running server.
 */
async function loadServerModule(appRoot: string, outDir: string): Promise<AppServerModule> {
  const entry = join(appRoot, 'src/server/index.ts')
  if (!existsSync(entry)) return {}
  await build({
    configFile: false, root: appRoot, logLevel: 'silent',
    build: {
      ssr: entry, outDir, emptyOutDir: true, minify: false,
      rollupOptions: { external: (id) => !id.startsWith('.') && !isAbsolute(id) && !id.startsWith('\0'), output: { entryFileNames: 'index.mjs' } },
    },
  })
  const loaded = (await import(`${pathToFileURL(join(outDir, 'index.mjs')).href}?generation=${++generation}`)).default as AppServerModule | undefined
  return loaded ?? {}
}

async function handle(app: App, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' && !mutationAllowed(request)) return send(response, 403, { error: 'Cross-origin mutations are not allowed' })
    const principal = await app.resolvePrincipal(request)
    const operation = url.pathname.match(/^\/api\/app\/operations\/([A-Za-z0-9_.-]+)$/)
    if (request.method === 'POST' && operation) {
      const text = (await read(request, maxJson)).toString('utf8')
      let input: unknown
      try { input = JSON.parse(text || '{}') } catch { return send(response, 400, { error: 'Request body must be valid JSON' }) }
      return send(response, 200, { result: await app.invoke(operation[1], input, principal, 'http') })
    }
    if (request.method === 'PUT' && url.pathname === '/api/app/files') {
      const bytes = await read(request, maxUpload)
      const input = { folder: url.searchParams.get('folder') ?? '', name: url.searchParams.get('name') ?? '', contentType: request.headers['content-type'] ?? 'application/octet-stream', bytes }
      return send(response, 201, { result: await app.invoke('files.upload', input, principal, 'http') })
    }
    const file = url.pathname.match(/^\/api\/app\/files\/([^/]+)$/)
    if (request.method === 'GET' && file) {
      const { ref, bytes } = await app.invoke('files.read', { id: decodeURIComponent(file[1]) }, principal, 'http') as { ref: { name: string; contentType: string }; bytes: Uint8Array }
      response.writeHead(200, {
        'Content-Type': ref.contentType,
        'Content-Length': bytes.byteLength,
        'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(ref.name)}`,
        // Uploaded bytes are untrusted: never let them run as a page on this origin.
        'Content-Security-Policy': 'sandbox',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
      response.end(bytes)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/app/changes') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      response.flushHeaders()
      const write = (collection: string) => response.write(`data: ${JSON.stringify({ collection })}\n\n`)
      app.changes.on('change', write)
      request.on('close', () => app.changes.off('change', write))
      return
    }
    send(response, 404, { error: 'Unknown API route' })
  } catch (error) {
    const status = error instanceof Error ? statuses[error.name] ?? (error instanceof AppError && error.status === 413 ? 413 : undefined) : undefined
    if (status) {
      const { current, fields } = error as Error & { current?: unknown; fields?: unknown }
      return send(response, status, { error: (error as Error).message, name: (error as Error).name, current, fields })
    }
    console.error(error)
    send(response, 500, { error: 'The operation failed on the server; see the server log.' })
  }
}

// By name, not class: app code bundled at reload has its own copies of these error classes.
const statuses: Record<string, number> = { InvalidError: 400, ForbiddenError: 403, NotFoundError: 404, VersionConflictError: 409, RecordRefusedError: 422 }

export function mutationAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  const authority = request.headers.host
  if (!authority) return false
  try {
    return origin === new URL(origin).origin && origin === new URL(`http://${authority}`).origin
  } catch {
    return false
  }
}

async function read(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw Object.assign(new AppError(`Request body is larger than ${limit} bytes`), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) { response.destroy(); return }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  // Bytes cross JSON as base64, so an HTTP caller of files.read gets them intact.
  response.end(JSON.stringify(body, function (this: Record<string, unknown>, key, value) {
    const raw = this[key]
    return raw instanceof Uint8Array ? Buffer.from(raw).toString('base64') : value
  }))
}
