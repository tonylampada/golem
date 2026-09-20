import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadAppConfig, type AppConfig } from '../config.ts'
import { build } from 'vite'
import { AppError, InvalidError, UnauthorizedError, type Principal, type RecordStore } from '../operations.ts'
import { createAccounts, type Accounts } from './accounts.ts'
import { createApp, type App, type AppServerModule } from './app.ts'
import { diskFiles } from './files.ts'
import { jsonlStore } from './jsonl.ts'
import { resolveSourceModule } from '../source-mode.ts'

const maxJson = 1_000_000
// Uploads are buffered in memory; stream to disk if apps need files past this size.
const maxUpload = 25_000_000

export type AppBackend = {
  app: App
  config: AppConfig
  /** Present when golem.config.ts turns on local accounts. */
  accounts?: Accounts
  /** Serves /api/app/* and /api/auth/*. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>
  /** The configured `origin` when set, else same-origin by Host; requests without Origin are not from a browser page. */
  mutationAllowed(request: IncomingMessage): boolean
  /** Where links handed out by this server point: the configured origin, else this Host authority. */
  origin(authority?: string): string
  /** Re-reads src/server/index.ts and its local imports; on failure the running module stays. */
  reload(): Promise<void>
  close(): Promise<void>
}

/** Loads golem.config.ts storage and the optional app-owned src/server/index.ts, and serves /api/app/*. */
export async function createAppBackend(appRoot: string, dataDirectory: string): Promise<AppBackend> {
  const config = await loadAppConfig(appRoot)
  const { storage } = config
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
  // Accounts write the raw store, so nothing about them reaches the public change stream.
  const accounts = config.accounts ? createAccounts(records, config.accounts) : undefined
  const cookie = `${config.origin?.startsWith('https:') ? '__Host-' : ''}golem-session-${config.port}`
  const identity = accounts && {
    requireUser: !accounts.config.guests,
    resolve: (request: IncomingMessage) => accounts.fromToken(readCookie(request, cookie)),
    refresh: accounts.refresh,
    resolveAccount: accounts.resolveAccount,
  }
  // FileStore writes metadata through the app's watched store, so file changes reach subscribers.
  const app = createApp({ records, files: (watched) => diskFiles(join(dataDirectory, 'files'), watched), root: appRoot }, await load(), identity)
  const server = { app, accounts, config, cookie }
  return {
    app,
    config,
    accounts,
    handle: (request, response) => handle(server, request, response),
    mutationAllowed: (request) => mutationAllowed(request, config.origin),
    origin: (authority) => originOf(config, authority),
    reload: async () => app.use(await load()),
    close: () => { app.close(); return records.close() },
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
    // Source mode: the app's `golem-kit/server` is the checkout's file, and stays external so the
    // app and the running server share one module instance and `instanceof` still holds. A plugin
    // rather than `resolve.alias` because rollup asks `external` about a bare specifier first.
    plugins: [{ name: 'golem-source-modules', enforce: 'pre', resolveId: (source: string) => {
      const file = resolveSourceModule(source)
      return file ? { id: file, external: true } : undefined
    } }],
    build: {
      ssr: entry, outDir, emptyOutDir: true, minify: false,
      rollupOptions: { external: (id) => !resolveSourceModule(id) && !id.startsWith('.') && !isAbsolute(id) && !id.startsWith('\0'), output: { entryFileNames: 'index.mjs' } },
    },
  })
  const loaded = (await import(`${pathToFileURL(join(outDir, 'index.mjs')).href}?generation=${++generation}`)).default as unknown
  if (!loaded || typeof loaded !== 'object') throw new Error('src/server/index.ts must default-export an object')
  return loaded as AppServerModule
}

type Server = { app: App; accounts?: Accounts; config: AppConfig; cookie: string }

async function handle({ app, accounts, config, cookie }: Server, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' && !mutationAllowed(request, config.origin)) return send(response, 403, { error: 'Cross-origin mutations are not allowed' })
    const principal = await app.resolvePrincipal(request)
    if (url.pathname.startsWith('/api/auth/')) return await handleAuth({ app, accounts, config, cookie }, principal, request, response, url.pathname.slice('/api/auth/'.length))
    // guests: false keeps every signed-out caller out of app data; guests: true sends them through authorize as anonymous.
    if (accounts && !accounts.config.guests && principal.kind === 'anonymous') throw new UnauthorizedError('Sign in to use this app.')
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
    if (request.method === 'POST' && url.pathname === '/api/app/views') {
      const { conversation } = await readJson(request) as { conversation?: unknown }
      return send(response, 201, { result: await app.views.open(request, principal, conversation as string) })
    }
    const view = url.pathname.match(/^\/api\/app\/views\/([A-Za-z0-9_-]+)(\/answer)?$/)
    if (view && request.method === 'POST' && view[2]) {
      const { offer, accept } = await readJson(request) as { offer?: unknown; accept?: unknown }
      if (typeof offer !== 'string' || typeof accept !== 'boolean') throw new InvalidError('An answer needs { offer, accept }')
      await app.views.answer(request, principal, view[1], offer, accept)
      return send(response, 200, { result: null })
    }
    if (view && request.method === 'GET' && !view[2]) {
      // Throws before any header when this view is not the caller's; events only arrive on later ticks.
      const close = await app.views.connect(request, principal, view[1], (event) => response.write(`data: ${JSON.stringify(event)}\n\n`))
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      response.flushHeaders()
      // A signed-out or removed reader loses the view at once.
      const recheck = (accountId: string) => {
        if (principal.kind === 'user' && accountId === principal.id) void app.refresh(principal).catch(() => response.end())
      }
      accounts?.changes.on('change', recheck)
      request.on('close', () => { close(); accounts?.changes.off('change', recheck) })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/app/changes') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      response.flushHeaders()
      const write = (collection: string) => response.write(`data: ${JSON.stringify({ collection })}\n\n`)
      // When this reader's account changes, re-resolve the same request: a signed-out reader
      // loses the stream, everyone else is told to re-read who they are and what they may see.
      const recheck = (accountId: string) => {
        if (principal.kind !== 'user' || accountId !== principal.id) return
        void app.resolvePrincipal(request).then((now) => {
          // Tell the page first, so a signed-out tab drops what it shows instead of waiting for a reload.
          response.write(`data: ${JSON.stringify({ identity: true })}\n\n`)
          if (now.kind === 'anonymous' && !accounts?.config.guests) response.end()
        }, () => response.end())
      }
      app.changes.on('change', write)
      accounts?.changes.on('change', recheck)
      request.on('close', () => { app.changes.off('change', write); accounts?.changes.off('change', recheck) })
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

async function handleAuth({ accounts, config, cookie }: Server, principal: Principal, request: IncomingMessage, response: ServerResponse, route: string): Promise<void> {
  if (request.method === 'GET' && route === 'me') {
    const settings = accounts && { guests: accounts.config.guests, allowSignUp: accounts.config.allowSignUp, roles: accounts.config.roles }
    return send(response, 200, { result: { user: accounts ? await accounts.me(principal) : null, canBuild: accounts ? accounts.canBuild(principal) : true, accounts: settings ?? null } })
  }
  if (!accounts) return send(response, 404, { error: 'This app has no accounts' })
  const secure = config.origin?.startsWith('https:') ? '; Secure' : ''
  const session = (token: string, maxAge: number) => ({ 'Set-Cookie': `${cookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}` })
  if (request.method === 'GET' && route === 'members') return send(response, 200, { result: await accounts.members(principal) })
  if (request.method !== 'POST') return send(response, 404, { error: 'Unknown API route' })
  const input = await readJson(request)
  if (route === 'sign-in' || route === 'sign-up') {
    const { user, token } = route === 'sign-in' ? await accounts.signIn(input, request.socket.remoteAddress ?? 'unknown') : await accounts.signUp(input)
    return send(response, 200, { result: user }, session(token, 14 * 86_400))
  }
  if (route === 'sign-out') {
    await accounts.signOut(principal)
    return send(response, 200, { result: null }, session('', 0))
  }
  if (route === 'invites') return send(response, 200, { result: await accounts.invite(principal, input, originOf(config, request.headers.host)) })
  const member = route.match(/^members\/([^/]+)\/(role|groups|remove)$/)
  if (!member) return send(response, 404, { error: 'Unknown API route' })
  const id = decodeURIComponent(member[1])
  if (member[2] === 'role') await accounts.setRole(principal, id, input)
  else if (member[2] === 'groups') await accounts.setGroups(principal, id, input)
  else await accounts.remove(principal, id)
  send(response, 200, { result: null })
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const text = (await read(request, maxJson)).toString('utf8')
  try { return JSON.parse(text || '{}') } catch { throw new InvalidError('Request body must be valid JSON') }
}

export function readCookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=') || undefined
  }
  return undefined
}

function originOf(config: AppConfig, authority?: string): string {
  if (config.origin) return config.origin
  try { if (authority) return new URL(`http://${authority}`).origin } catch {}
  return new URL(`http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`).origin
}

// By name, not class: app code bundled at reload has its own copies of these error classes.
const statuses: Record<string, number> = { UnauthorizedError: 401, RateLimitedError: 429, InvalidError: 400, ForbiddenError: 403, NotFoundError: 404, VersionConflictError: 409, RecordRefusedError: 422 }

export function mutationAllowed(request: IncomingMessage, configured?: string): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  // Behind a proxy the Host header is the proxy's business, so a configured origin is the only one accepted.
  if (configured) return origin === configured
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

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.headersSent) { response.destroy(); return }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  // Bytes cross JSON as base64, so an HTTP caller of files.read gets them intact.
  response.end(JSON.stringify(body, function (this: Record<string, unknown>, key, value) {
    const raw = this[key]
    return raw instanceof Uint8Array ? Buffer.from(raw).toString('base64') : value
  }))
}
