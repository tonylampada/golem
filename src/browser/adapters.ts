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

const storageKey = 'golem.browser.session'
let sessionId: string | undefined = (() => {
  try { return window.sessionStorage.getItem(storageKey) ?? undefined } catch { return undefined }
})()
let messages: ChatMessage[] = []
let cursor = -1
let eventLog = new Map<number, { sequence: number; type: string; text?: string; status?: string; reason?: string }>()
let status = 'starting'
let source: EventSource | undefined
const listeners = new Set<(messages: ChatMessage[]) => void>()
const statusListeners = new Set<(status: string) => void>()
const emit = () => listeners.forEach((listener) => listener([...messages]))
const setStatus = (next: string) => { status = next; statusListeners.forEach((listener) => listener(status)) }

function mergeEvents(events: Array<{ sequence: number; type: string; text?: string; status?: string; reason?: string }>): string | undefined {
  for (const event of events) if (!eventLog.has(event.sequence)) eventLog.set(event.sequence, event)
  const ordered = [...eventLog.values()].sort((left, right) => left.sequence - right.sequence)
  cursor = Math.max(cursor, ...ordered.map((event) => event.sequence))
  messages = fromEvents(ordered)
  return ordered.findLast((event) => event.type === 'status')?.status
}

function fromEvents(events: Array<{ type: string; sequence: number; text?: string; status?: string; reason?: string }>): ChatMessage[] {
  return events.flatMap((event) => {
    if ((event.type === 'user' || event.type === 'message') && event.text) {
      return [{ id: `${event.sequence}`, role: event.type === 'user' ? 'user' : 'agent', text: event.text, at: new Date().toISOString() }]
    }
    if (event.type === 'error') return [{ id: `${event.sequence}`, role: 'agent', text: `Error: ${event.text ?? 'Agent failed.'}`, at: new Date().toISOString() }]
    if (event.type === 'interrupted') return [{ id: `${event.sequence}`, role: 'agent', text: `Interrupted${event.reason ? `: ${event.reason}` : '.'}`, at: new Date().toISOString() }]
    return []
  })
}

export async function startBrowserSession(): Promise<{ id: string; backend: string }> {
  const response = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: 'codex' }) })
  const result = await response.json() as { id?: string; backend?: string; error?: string }
  if (!response.ok || !result.id) throw new Error(result.error ?? 'Unable to start session')
  source?.close()
  source = undefined
  sessionId = result.id
  window.sessionStorage.setItem(storageKey, sessionId)
  cursor = -1
  eventLog = new Map()
  setStatus('ready')
  messages = []
  emit()
  return { id: result.id, backend: result.backend ?? 'codex' }
}

export function currentBrowserSession(): string | undefined { return sessionId }

export async function restoreBrowserSession(): Promise<boolean> {
  if (!sessionId) return false
  const response = await fetch(`/api/sessions/${sessionId}/history`)
  if (response.status === 404) {
    sessionId = undefined
    window.sessionStorage.removeItem(storageKey)
    return false
  }
  if (!response.ok) throw new Error((await response.json()).error ?? 'Unable to restore session')
  const result = await response.json() as { events: Array<{ sequence: number; type: string; text?: string; reason?: string }>; status: string }
  eventLog = new Map()
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

function applyEvent(event: { sessionId?: string; sequence: number; type: string; text?: string; status?: string; reason?: string }): void {
  if (event.sessionId && event.sessionId !== sessionId) return
  if (event.sequence <= cursor) return
  cursor = event.sequence
  if (event.status) setStatus(event.status)
  // Live-only: a replayed 'rebuilt' from history/reload restoration must never re-trigger this.
  if (event.type === 'rebuilt') { window.location.reload(); return }
  mergeEvents([event])
  emit()
}

export const chat: ChatAdapter = {
  history: async () => {
    if (!sessionId) return []
    const response = await fetch(`/api/sessions/${sessionId}/history`)
    if (!response.ok) throw new Error((await response.json()).error ?? 'Unable to load session history')
    const result = await response.json() as { events: Array<{ sequence: number; type: string; text?: string; reason?: string }>; status: string }
  setStatus(mergeEvents(result.events) ?? result.status)
    emit()
    return [...messages]
  },
  subscribe(listener) {
    listeners.add(listener)
    if (sessionId) {
      source?.close()
      const subscribedSession = sessionId
      let subscribedSource: EventSource
      const connect = () => {
        const nextSource = new EventSource(`/api/sessions/${subscribedSession}/events?after=${cursor}`)
        subscribedSource = nextSource
        source = nextSource
        nextSource.onmessage = (event) => applyEvent(JSON.parse(event.data))
        nextSource.onerror = () => {
          if (source === nextSource && nextSource.readyState === EventSource.CLOSED && sessionId === subscribedSession) {
            connect()
          }
        }
      }
      connect()
      return () => { subscribedSource.close(); if (source === subscribedSource) source = undefined; listeners.delete(listener) }
    }
    return () => listeners.delete(listener)
  },
  async send(text, attachments) {
    if (!sessionId) throw new Error('Enter build mode before sending a message')
    const response = await fetch(`/api/sessions/${sessionId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, attachments }) })
    if (!response.ok) throw new Error((await response.json()).error ?? 'Agent request failed')
  },
}

export type { ChatMessage, User }
