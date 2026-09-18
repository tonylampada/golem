/**
 * golem-kit/client: the browser binding. golem-ui `Records`, `Files` and `Identity` adapters plus
 * `invoke`, all over the app server's HTTP routes — no storage driver or server module reaches the bundle.
 */
import { fileId, RecordRefusedError, VersionConflictError, type FileRef, type FilesAdapter, type IdentityAdapter, type RecordsAdapter, type User } from 'golem-ui'

/** Calls an app operation by name, as the signed-in principal the server resolves. */
export function invoke<T = unknown>(operation: string, input: unknown = {}): Promise<T> {
  return call<T>(fetch(`/api/app/operations/${encodeURIComponent(operation)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }))
}

async function call<T>(request: Promise<Response>): Promise<T> {
  const response = await request
  const body = await response.json().catch(() => ({ error: `${response.status} ${response.statusText}` })) as { result?: T; error?: string; name?: string; current?: Record<string, unknown>; fields?: Array<{ field: string; message: string }> }
  if (response.ok) return body.result as T
  if (body.name === 'VersionConflictError') throw new VersionConflictError(body.error ?? 'Changed since it was read', body.current ?? null)
  if (body.name === 'RecordRefusedError') throw new RecordRefusedError(body.error ?? 'Refused', body.fields ?? [])
  throw Object.assign(new Error(body.error ?? `Request failed (${response.status})`), { name: body.name ?? 'Error', status: response.status })
}

const listeners = new Map<string, Set<() => void>>()
let changes: EventSource | undefined

function connect(): void {
  changes?.close()
  changes = Object.assign(new EventSource('/api/app/changes'), {
    onmessage: (event: MessageEvent) => {
      const data = JSON.parse(event.data) as { collection?: string; identity?: true }
      if (data.identity) void reloadIdentity()
      else listeners.get(data.collection ?? '')?.forEach((one) => one())
    },
    // The server refused or ended the stream for good (e.g. signed out elsewhere): re-read identity
    // once. No reconnect here, so a 401 cannot loop; a new identity reconnects through reloadIdentity.
    onerror: () => {
      if (changes?.readyState === EventSource.CLOSED) void me?.then((known) => { if (known.user) void reloadIdentity(false) }, () => {})
    },
  })
}

function watch(collection: string, listener: () => void): () => void {
  const set = listeners.get(collection) ?? new Set()
  listeners.set(collection, set.add(listener))
  if (!changes) connect()
  return () => {
    set.delete(listener)
    if ([...listeners.values()].every((one) => one.size === 0)) { changes?.close(); changes = undefined }
  }
}

export const records: RecordsAdapter = {
  list: (collection, query) => invoke('records.list', { collection, query }),
  get: (collection, id) => invoke('records.get', { collection, id }),
  create: (collection, data) => invoke('records.create', { collection, data }),
  update: (collection, id, patch, options) => invoke('records.update', { collection, id, patch, ...options }),
  remove: async (collection, id) => { await invoke('records.remove', { collection, id }) },
  subscribe: watch,
}

export const files: FilesAdapter = {
  async upload(file, { folder, onProgress }) {
    const ref = await call<FileRef>(fetch(`/api/app/files?${new URLSearchParams({ folder, name: file.name })}`, {
      method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
    }))
    onProgress?.(1)
    return ref
  },
  url: async (ref) => `/api/app/files/${encodeURIComponent(fileId(ref))}`,
  remove: async (ref) => { await invoke('files.remove', { id: fileId(ref) }) },
  list: (folder) => invoke('files.list', { folder }),
  caption: (ref, caption) => invoke('files.caption', { id: fileId(ref), caption }),
  subscribe: (_folder, listener) => watch('_files', listener),
}

/** A signed-in person as the server sees them: golem-ui's `User` plus the groups app rules may check. */
export type Member = User & { email: string; groups: string[] }
export type AccountsSettings = { guests: boolean; allowSignUp: boolean; roles: Array<{ id: string; label: string; manages: boolean }> }
/** `accounts` is null when the app has no accounts; then everyone is anonymous and may build. */
export type Me = { user: Member | null; canBuild: boolean; accounts: AccountsSettings | null }

let me: Promise<Me> | undefined
const identityListeners = new Set<(user: User | null) => void>()

/** Who this browser is signed in as, and what the app's account settings are. Cached until identity changes. */
export function currentSession(): Promise<Me> {
  me ??= call<Me>(fetch('/api/auth/me')).catch((error) => { me = undefined; throw error })
  return me
}

/** Re-reads the session after sign-in, sign-out or a role change; open lists re-read what they may now see. */
async function reloadIdentity(reconnect = true): Promise<Me> {
  me = undefined
  const next = await currentSession()
  identityListeners.forEach((listener) => listener(next.user))
  if (changes && reconnect) connect()
  listeners.forEach((set) => set.forEach((listener) => listener()))
  return next
}

const auth = <T = null>(route: string, input: unknown = {}) => call<T>(fetch(`/api/auth/${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
}))
const signedIn = async () => {
  const { user } = await reloadIdentity()
  if (!user) throw new Error('Signing in did not stick. Allow cookies for this site and try again.')
  return user
}
const passwordOnly = () => Promise.reject(new Error('This app signs in with a password.'))

/** golem-ui `IdentityAdapter` over the server's local accounts. Sign-in takes the account's email and password. */
export const identity: IdentityAdapter = {
  currentUser: async () => (await currentSession()).user,
  subscribe(listener) {
    identityListeners.add(listener)
    // Keeps the change stream open, which is where the server says this account changed.
    const stop = watch('', () => {})
    return () => { identityListeners.delete(listener); stop() }
  },
  signIn: async (email, password) => { await auth('sign-in', { email, password }); return signedIn() },
  signUp: async (input) => { await auth('sign-up', input); return signedIn() },
  requestCode: passwordOnly,
  verifyCode: passwordOnly,
  signOut: async () => { await auth('sign-out'); await reloadIdentity() },
  listMembers: () => call<Member[]>(fetch('/api/auth/members')),
  invite: (role) => auth<string>('invites', { role }),
  removeMember: async (userId) => { await auth(`members/${encodeURIComponent(userId)}/remove`); await reloadIdentity() },
  setRole: async (userId, role) => { await auth(`members/${encodeURIComponent(userId)}/role`, { role }); await reloadIdentity() },
}

/** Re-reads who is signed in and tells identity subscribers; for callers that saw a 401 or 403. */
export async function refreshIdentity(): Promise<void> { await reloadIdentity() }

/** Replaces a member's groups. Accounts that manage members only. */
export async function setGroups(userId: string, groups: string[]): Promise<void> {
  await auth(`members/${encodeURIComponent(userId)}/groups`, { groups })
  await reloadIdentity()
}

/**
 * golem-ui `RecordsAdapter` over the app's knowledge roots: `collection` is the root name, `id` the
 * file path and `body` its markdown. Hand it to `Editor` (versioned saves, merged conflicts) or `RecordList`.
 */
export const knowledge: RecordsAdapter = {
  list: (root, query) => invoke('knowledge.list', { root, ...(typeof query?.filter?.folder === 'string' ? { folder: query.filter.folder } : {}) }),
  get: async (root, path) => {
    try { return await invoke('knowledge.read', { root, path }) }
    catch (error) { if ((error as Error).name === 'NotFoundError') return null; throw error }
  },
  create: (root, data) => invoke('knowledge.write', { root, path: data.path ?? data.id, body: data.body ?? '', expectedVersion: 0 }),
  update: (root, path, patch, options) => invoke('knowledge.write', { root, path, body: patch.body, expectedVersion: options?.expectedVersion ?? (patch.version as number) }),
  remove: () => Promise.reject(new Error('Knowledge files are removed in the app folder, not from the browser.')),
  subscribe: (_root, listener) => watch('_knowledge', listener),
}

/** A knowledge passage an agent offered to show; `line` and `endLine` are 1-based and inclusive. */
export type ViewOffer = { id: string; conversation: string; action: 'source.open'; input: { root: string; path: string; line: number; endLine: number } }
/** `apply` carries the file `version` its lines were counted in: show them once the editor has that version. */
export type ViewEvent = { type: 'offer'; offer: ViewOffer } | { type: 'apply'; offer: ViewOffer; version: number } | { type: 'withdrawn'; id: string }

/**
 * Opens this tab's view of one conversation. `id` is the view to send with this tab's chat messages,
 * so the agent's offers come here. An offer arrives as `offer` (or is shown by the chat); `answer` is
 * the person's choice, and only an accepted offer comes back, to this tab alone, as `apply`.
 */
export function openView(conversation: string, listener: (event: ViewEvent) => void): { id: Promise<string>; answer(offer: string, accept: boolean): Promise<void>; close(): void } {
  let source: EventSource | undefined
  let closed = false
  const id = call<{ id: string }>(fetch('/api/app/views', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation }) })).then((view) => view.id)
  void id.then((view) => {
    if (closed) return
    source = new EventSource(`/api/app/views/${view}`)
    source.onmessage = (event) => listener(JSON.parse(event.data) as ViewEvent)
  }, () => {})
  return {
    id,
    answer: async (offer, accept) => {
      await call(fetch(`/api/app/views/${await id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offer, accept }) }))
    },
    close: () => { closed = true; source?.close() },
  }
}
