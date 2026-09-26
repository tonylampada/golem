import { refreshIdentity, viewHandlerRegistry, type ViewEvent } from '../client.ts'
import type { ChatAdapter, ChatAttachment, ChatMessage, IdentityAdapter, NavigationAdapter, Route, User } from 'golem-ui'

const unavailable = () => Promise.reject(new Error('No agent or identity service is connected.'))

/** Anonymous means only that this host has no sign-in service; it grants no authorization. */
export const anonymousIdentity: IdentityAdapter = {
  currentUser: async () => null,
  subscribe: () => () => {},
  signIn: unavailable,
  signUp: unavailable,
  requestCode: unavailable,
  verifyCode: unavailable,
  signOut: async () => {},
  listMembers: async () => [],
  invite: unavailable,
  removeMember: unavailable,
  setRole: unavailable,
}

function route(): Route {
  return { path: window.location.pathname, params: Object.fromEntries(new URLSearchParams(window.location.search)) }
}

export const navigation: NavigationAdapter = {
  current: route,
  go(path) { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')) },
  subscribe(listener) {
    const update = () => listener(route())
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  },
}

/** Which conversation the chat column shows: the builder agent, or the app's normal-mode chat. */
export type SessionKind = 'builder' | 'chat' | 'anthropic'
// This tab remembers one conversation per kind, so the Builder switch comes back to the same one.
const storageKey = (kind: SessionKind) => `golem.browser.session.${kind}`
const outboxKey = 'golem.browser.outbox'
const kinds = ['builder', 'chat', 'anthropic'] as const
// Until the shell decides the mode, the tab's last conversation of any kind is the shown one.
let sessionId: string | undefined = (() => {
  try { return kinds.map((kind) => window.sessionStorage.getItem(storageKey(kind))).find(Boolean) ?? undefined } catch { return undefined }
})()
const sessionListeners = new Set<(id: string | undefined) => void>()
/** Fires when the shown conversation changes underneath an open Chat, e.g. after `/reset`. */
export function subscribeBrowserSession(listener: (id: string | undefined) => void): () => void {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}
type BrowserMessage = ChatMessage & { delivery?: 'pending' | 'failed'; sources?: string[] }
type OutboxMessage = { id: string; sessionId: string; text: string; attachments?: ChatAttachment[]; delivery?: 'pending' | 'failed'; at: string }
let outbox: OutboxMessage[] = (() => {
  try { return (JSON.parse(window.localStorage.getItem(outboxKey) ?? '[]') as OutboxMessage[]).map((message) => ({ ...message, delivery: message.delivery === 'pending' ? 'failed' : message.delivery })) } catch { return [] }
})()
let messages: BrowserMessage[] = []
let sessionBackend: string | undefined
let cursor = -1
let eventLog = new Map<number, { sequence: number; type: string; text?: string; status?: string; reason?: string; clientMessageId?: string; attachments?: ChatAttachment[]; sources?: string[] }>()
let status = 'starting'
let source: EventSource | undefined
const listeners = new Set<(messages: ChatMessage[]) => void>()
const statusListeners = new Set<(status: string) => void>()
const emit = () => listeners.forEach((listener) => listener([...messages]))
const setStatus = (next: string) => { status = next; statusListeners.forEach((listener) => listener(status)) }

function saveOutbox(confirmed = new Set<string>()): void {
  try {
    const stored = JSON.parse(window.localStorage.getItem(outboxKey) ?? '[]') as OutboxMessage[]
    const merged = new Map(stored.filter((message) => !confirmed.has(message.id)).map((message) => [message.id, message]))
    for (const message of outbox) if (!confirmed.has(message.id)) merged.set(message.id, message)
    outbox = [...merged.values()]
    window.localStorage.setItem(outboxKey, JSON.stringify(outbox))
  } catch { /* Delivery still works for this page. */ }
}

function mergeEvents(events: Array<{ sequence: number; type: string; text?: string; status?: string; reason?: string; clientMessageId?: string; attachments?: ChatAttachment[]; sources?: string[] }>): string | undefined {
  for (const event of events) if (!eventLog.has(event.sequence)) eventLog.set(event.sequence, event)
  const ordered = [...eventLog.values()].sort((left, right) => left.sequence - right.sequence)
  cursor = Math.max(cursor, ...ordered.map((event) => event.sequence))
  const confirmed = fromEvents(ordered)
  const ids = new Set(confirmed.map((message) => message.id))
  outbox = outbox.filter((message) => message.sessionId !== sessionId || !ids.has(message.id))
  saveOutbox(ids)
  messages = [...confirmed, ...outbox.filter((message) => message.sessionId === sessionId).map((message) => ({ ...message, role: 'user' as const }))]
  return ordered.findLast((event) => event.type === 'status')?.status
}

function fromEvents(events: Array<{ type: string; sequence: number; text?: string; ok?: boolean; status?: string; reason?: string; clientMessageId?: string; attachments?: ChatAttachment[]; sources?: string[] }>): BrowserMessage[] {
  return events.flatMap((event) => {
    if ((event.type === 'user' || event.type === 'message') && event.text) {
      return [{ id: event.type === 'user' && event.clientMessageId ? event.clientMessageId : `${event.sequence}`, role: event.type === 'user' ? 'user' : 'agent', text: event.text, attachments: event.attachments, ...(event.sources ? { sources: event.sources } : {}), at: new Date().toISOString() }]
    }
    if (event.type === 'error') return [{ id: `${event.sequence}`, role: 'agent', text: `Error: ${event.text ?? 'Agent failed.'}`, attachments: undefined, at: new Date().toISOString() }]
    if (event.type === 'tool' && event.ok === false) return [{ id: `${event.sequence}`, role: 'agent', text: `An action failed: ${event.text ?? 'unknown error'}`, attachments: undefined, at: new Date().toISOString() }]
    if (event.type === 'interrupted') return [{ id: `${event.sequence}`, role: 'agent', text: `Interrupted${event.reason ? `: ${event.reason}` : '.'}`, attachments: undefined, at: new Date().toISOString() }]
    return []
  })
}

function refresh(): void { mergeEvents([]); emit() }

type SlashCommand = { name: string; description: string; args?: Array<{ value: string; description: string }> }

/** (Re)opens the shown conversation's event stream; the previous stream, if any, is closed. */
function connect(): void {
  source?.close()
  const subscribedSession = sessionId!
  // `view=1` asks for this tab's view of the conversation; the server opens one where the app has
  // actions to offer (a terminal agent's `./golem show`, the assistant's `view.request`) and skips it otherwise.
  const nextSource = new EventSource(`/api/sessions/${subscribedSession}/events?after=${cursor}&view=1`)
  source = nextSource
  nextSource.onmessage = (event) => applyEvent(JSON.parse(event.data))
  // Optional call: a test's EventSource stand-in has onmessage and nothing else.
  nextSource.addEventListener?.('view', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as ViewStreamEvent
    if (data.type === 'view') { chatView = data.id; void publishHandlers() }
    viewListeners.forEach((listener) => listener(data))
  })
  nextSource.onopen = () => {
    void fetch(`/api/sessions/${subscribedSession}/history`).then(async (response) => {
      if (!response.ok || source !== nextSource || sessionId !== subscribedSession) return
      const result = await response.json() as { events: Array<{ sequence: number; type: string; text?: string; reason?: string; clientMessageId?: string; attachments?: ChatAttachment[]; sources?: string[] }>; status: string }
      if (source !== nextSource || sessionId !== subscribedSession) return
      setStatus(mergeEvents(result.events) ?? result.status)
      emit()
    }).catch(() => {})
  }
  nextSource.onerror = () => {
    if (source !== nextSource || nextSource.readyState !== EventSource.CLOSED || sessionId !== subscribedSession) return
    // Reconnect only while this conversation is still ours to read; a 401/403 means access
    // changed, so let identity decide instead of retrying into the same refusal.
    void fetch(`/api/sessions/${subscribedSession}/history`).then((response) => {
      if (source !== nextSource || sessionId !== subscribedSession) return
      if (response.status === 401 || response.status === 403) void refreshIdentity()
      else connect()
    }, () => { if (source === nextSource) connect() })
  }
}

// This tab's view of the open chat, from its event stream: sent with each message so the
// assistant's offers come here, and used to answer them.
let chatView: string | undefined
type ViewStreamEvent = ViewEvent | { type: 'view'; id: string }
const viewListeners = new Set<(event: ViewStreamEvent) => void>()
export function subscribeChatView(listener: (event: ViewStreamEvent) => void): () => void {
  viewListeners.add(listener)
  return () => viewListeners.delete(listener)
}
/** Tells the server which app actions this tab can apply, so an agent asking for another one is refused. */
async function publishHandlers(): Promise<void> {
  if (!chatView) return
  try {
    await fetch(`/api/app/views/${chatView}/handlers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions: viewHandlerRegistry.names() }) })
  } catch { /* The next registration or reconnect publishes again. */ }
}
// An app registering a handler after the view opened (a screen mounting) publishes the new list.
viewHandlerRegistry.watch(() => { void publishHandlers() })

export async function answerOffer(offer: string, accept: boolean): Promise<void> {
  if (!chatView) throw new Error('This tab is not connected to the chat.')
  const response = await fetch(`/api/app/views/${chatView}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offer, accept }) })
  if (!response.ok) throw new Error((await response.json()).error ?? 'Unable to answer the offer')
}
function messageId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}` }
function findOutbox(id: string): OutboxMessage | undefined { return outbox.find((message) => message.id === id && message.sessionId === sessionId) }

async function deliver(message: OutboxMessage): Promise<void> {
  try {
    const response = await fetch(`/api/sessions/${message.sessionId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message.text, attachments: message.attachments, clientMessageId: message.id, ...(chatView ? { view: chatView } : {}) }) })
    if (!response.ok) throw new Error((await response.json()).error ?? 'Message was not accepted')
    message.delivery = undefined
    saveOutbox()
    refresh()
  } catch (error) {
    message.delivery = 'failed'
    saveOutbox()
    refresh()
    throw error
  }
}

/**
 * Starts a conversation of `kind`: the builder agent (the only build-starting call in the UI, declaring
 * build intent explicitly; the server decides permission), a terminal chat agent, or the API assistant.
 */
export async function startBrowserSession(backend = 'codex', kind: SessionKind = 'builder'): Promise<{ id: string; backend: string }> {
  return kind === 'anthropic' ? begin(kind, '/api/chat', {}, 'anthropic') : begin(kind, '/api/sessions', { backend, intent: kind === 'builder' ? 'build' : 'chat' }, backend)
}

async function begin(kind: SessionKind, url: string, body: object, backend: string): Promise<{ id: string; backend: string }> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json() as { id?: string; backend?: string; error?: string }
  if (!response.ok || !result.id) throw new Error(result.error ?? 'Unable to start session')
  show(kind, result.id, result.backend ?? backend)
  return { id: result.id, backend: sessionBackend! }
}

/** Makes `id` the shown conversation: remembered for its kind, stream reconnected if a Chat is listening. */
function show(kind: SessionKind, id: string, backend: string): void {
  sessionKind = kind
  sessionId = id
  sessionBackend = backend
  try { window.sessionStorage.setItem(storageKey(kind), id) } catch {}
  cursor = -1
  eventLog = new Map()
  setStatus('ready')
  messages = []
  emit()
  if (listeners.size) connect()
  sessionListeners.forEach((listener) => listener(id))
}

/** Closes the shown conversation's stream without forgetting it; the chat column is going away. */
export function leaveBrowserSession(): void {
  source?.close()
  source = undefined
  sessionId = undefined
  sessionKind = undefined
  sessionBackend = undefined
  messages = []
  emit()
}
let sessionKind: SessionKind | undefined

export function currentBrowserSession(): string | undefined { return sessionId }
export function currentBrowserBackend(): string | undefined { return sessionBackend }

/** Drops this tab's remembered conversations, e.g. when a different person signs in. */
export function forgetBrowserSession(): void {
  sessionId = undefined
  for (const kind of kinds) try { window.sessionStorage.removeItem(storageKey(kind)) } catch {}
}

/** Reopens this tab's conversation of `kind`, else the latest one of that kind on the server. */
export async function restoreBrowserSession(kind: SessionKind = 'builder'): Promise<boolean> {
  let id: string | undefined
  try { id = window.sessionStorage.getItem(storageKey(kind)) ?? undefined } catch { /* Discovery below. */ }
  if (!id) {
    const discovered = await fetch(kind === 'anthropic' ? '/api/chat' : `/api/sessions/latest${kind === 'chat' ? '?chat=1' : ''}`)
    if (discovered.status === 404) return false
    if (!discovered.ok) throw new Error((await discovered.json()).error ?? 'Unable to discover a saved session')
    const found = await discovered.json() as { id?: string; latest?: { id: string } }
    id = kind === 'anthropic' ? found.latest?.id : found.id
    if (!id) return false
  }
  const response = await fetch(`/api/sessions/${id}/history`)
  if (response.status === 404) {
    try { window.sessionStorage.removeItem(storageKey(kind)) } catch {}
    return restoreBrowserSession(kind)
  }
  if (!response.ok) throw new Error((await response.json()).error ?? 'Unable to restore session')
  const result = await response.json() as { events: Array<{ sequence: number; type: string; text?: string; reason?: string; clientMessageId?: string; attachments?: ChatAttachment[]; sources?: string[] }>; status: string; backend?: string }
  show(kind, id, result.backend ?? (kind === 'anthropic' ? 'anthropic' : 'codex'))
  setStatus(mergeEvents(result.events) ?? result.status)
  emit()
  return true
}

export function subscribeBrowserStatus(listener: (status: string) => void): () => void {
  statusListeners.add(listener)
  listener(status)
  return () => statusListeners.delete(listener)
}

export async function interruptBrowserSession(): Promise<void> {
  if (!sessionId) return
  const response = await fetch(`/api/sessions/${sessionId}/interrupt`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  if (!response.ok) throw new Error((await response.json()).error ?? 'Unable to interrupt session')
}

function applyEvent(event: { sessionId?: string; sequence: number; type: string; text?: string; status?: string; reason?: string; clientMessageId?: string; attachments?: ChatAttachment[]; sources?: string[] }): void {
  if (event.sessionId && event.sessionId !== sessionId) return
  if (eventLog.has(event.sequence)) return
  cursor = Math.max(cursor, event.sequence)
  if (event.status) setStatus(event.status)
  // Live-only: a replayed 'rebuilt' from history/reload restoration must never re-trigger this.
  if (event.type === 'rebuilt') { window.location.reload(); return }
  mergeEvents([event])
  emit()
}

// interrupt, commands and runCommand are declared here too so the object still typechecks against a golem-ui whose ChatAdapter predates them (0.1.1).
export const chat: ChatAdapter & { retry(messageId: string): Promise<void>; interrupt(): Promise<void>; openSource(location: string): void; commands(): Promise<SlashCommand[]>; runCommand(line: string): Promise<string> } = {
  interrupt: interruptBrowserSession,
  // A source chip: the Brain panel opens on the cited lines, and on a phone the canvas tab comes forward.
  openSource: (location) => navigation.go(`${window.location.pathname}?brain=${encodeURIComponent(location)}`),
  history: async () => {
    if (!sessionId) return []
    const response = await fetch(`/api/sessions/${sessionId}/history`)
    if (!response.ok) throw new Error((await response.json()).error ?? 'Unable to load session history')
    const result = await response.json() as { events: Array<{ sequence: number; type: string; text?: string; reason?: string; clientMessageId?: string; attachments?: ChatAttachment[]; sources?: string[] }>; status: string }
  setStatus(mergeEvents(result.events) ?? result.status)
    emit()
    return [...messages]
  },
  subscribe(listener) {
    listeners.add(listener)
    if (sessionId && !source) connect()
    return () => { listeners.delete(listener); if (!listeners.size) { source?.close(); source = undefined } }
  },
  // Slash commands: `/reset` and the harness's own, from the server; a reply naming a new session switches to it.
  commands: async () => {
    if (!sessionId) return []
    const response = await fetch(`/api/sessions/${sessionId}/commands`)
    if (!response.ok) throw new Error((await response.json()).error ?? 'Unable to list commands')
    return (await response.json() as { commands: SlashCommand[] }).commands
  },
  runCommand: async (line: string) => {
    if (!sessionId || !sessionKind) throw new Error('Start a conversation before running a command')
    const response = await fetch(`/api/sessions/${sessionId}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line }) })
    const result = await response.json() as { text?: string; session?: string; error?: string }
    if (!response.ok) throw new Error(result.error ?? 'Command failed')
    if (result.session) show(sessionKind, result.session, sessionBackend ?? 'codex')
    return result.text ?? ''
  },
  async send(text, attachments) {
    if (!sessionId) throw new Error('Start a conversation before sending a message')
    const message: OutboxMessage = { id: messageId(), sessionId, text, attachments, delivery: 'pending', at: new Date().toISOString() }
    outbox.push(message)
    saveOutbox()
    refresh()
    await deliver(message)
  },
  retry: async (id: string) => {
    const message = findOutbox(id)
    if (!message) return
    message.delivery = 'pending'
    saveOutbox()
    refresh()
    await deliver(message)
  },
}

export type { ChatMessage, User }

/** The app's `brain/` folder over the dev server's read-only routes; golem-ui's BrainAdapter shape. */
const brainGet = async <T,>(route: string, params: Record<string, string>): Promise<T> => {
  const response = await fetch(`/api/brain/${route}?${new URLSearchParams(params)}`)
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Cannot read the brain (${response.status})`)
  return response.json() as Promise<T>
}
export const brain = {
  index: (dir = '') => brainGet<{ text: string }>('index', { dir }).then((r) => r.text),
  list: (dir = '') => brainGet<{ entries: Array<{ path: string; kind: 'file' | 'dir' }> }>('list', { dir }).then((r) => r.entries),
  read: (path: string) => brainGet<{ text: string }>('read', { path }).then((r) => r.text),
  search: (query: string) => brainGet<{ hits: Array<{ path: string; line: number; excerpt: string }> }>('search', { q: query }).then((r) => r.hits),
  subscribe(listener: () => void) {
    const events = new EventSource('/api/brain/events')
    events.onmessage = () => listener()
    return () => events.close()
  },
}
