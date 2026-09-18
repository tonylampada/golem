import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadAppConfig } from '../config.ts'
import { AppError, type RecordStore } from '../operations.ts'
import { createApp, type App, type AppServerModule } from './app.ts'
import { diskFiles } from './files.ts'
import { jsonlStore } from './jsonl.ts'

const maxJson = 1_000_000
// ponytail: uploads are buffered in memory; stream to disk if apps need files past this size.
const maxUpload = 25_000_000

export type AppBackend = { app: App; handle(request: IncomingMessage, response: ServerResponse): Promise<void>; close(): Promise<void> }

/** Loads golem.config.ts storage and the optional app-owned src/server/index.ts, and serves /api/app/*. */
export async function createAppBackend(appRoot: string, dataDirectory: string): Promise<AppBackend> {
  const { storage } = await loadAppConfig(appRoot)
  const records: RecordStore = storage === 'sqlite'
    ? (await import('./sqlite.ts')).sqliteStore(join(dataDirectory, 'records.sqlite'))
    : await jsonlStore(join(dataDirectory, 'records'))
  const files = await diskFiles(join(dataDirectory, 'files'), records)
  const entry = join(appRoot, 'src/server/index.ts')
  const module = existsSync(entry) ? (await import(pathToFileURL(entry).href)).default as AppServerModule : {}
  const app = createApp({ records, files: () => files }, module)
  return { app, handle: (request, response) => handle(app, request, response), close: () => records.close() }
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
    if (error instanceof AppError) {
      const { current, fields } = error as AppError & { current?: unknown; fields?: unknown }
      return send(response, error.status, { error: error.message, name: error.name, current, fields })
    }
    send(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

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
