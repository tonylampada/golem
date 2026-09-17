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

/** MNC-137 replaces this seam with the session worker. This response never claims work ran. */
const messages: ChatMessage[] = []
const listeners = new Set<(messages: ChatMessage[]) => void>()
const emit = () => listeners.forEach((listener) => listener([...messages]))

export const chat: ChatAdapter = {
  history: async () => [...messages],
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  async send(text, attachments) {
    const at = new Date().toISOString()
    messages.push({ id: `dev-user-${messages.length}`, role: 'user', text, at, attachments })
    messages.push({ id: `dev-agent-${messages.length}`, role: 'agent', at, text: 'No agent is connected. No work was executed.' })
    emit()
  },
}

export type { ChatMessage, User }
