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

let sessionId: string | undefined
let messages: ChatMessage[] = []
const listeners = new Set<(messages: ChatMessage[]) => void>()
const emit = () => listeners.forEach((listener) => listener([...messages]))

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
  sessionId = result.id
  messages = []
  emit()
  return { id: result.id, backend: result.backend ?? 'codex' }
}

export function currentBrowserSession(): string | undefined { return sessionId }

export const chat: ChatAdapter = {
  history: async () => {
    if (!sessionId) return []
    const response = await fetch(`/api/sessions/${sessionId}/history`)
    if (!response.ok) throw new Error((await response.json()).error ?? 'Unable to load session history')
    messages = fromEvents((await response.json()).events)
    return [...messages]
  },
  subscribe(listener) {
    listeners.add(listener)
    if (sessionId) {
      const source = new EventSource(`/api/sessions/${sessionId}/events`)
      source.onmessage = (event) => {
        const parsed = JSON.parse(event.data)
        messages = [...messages, ...fromEvents([parsed])]
        emit()
      }
      return () => { source.close(); listeners.delete(listener) }
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
