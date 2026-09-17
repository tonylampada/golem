import assert from 'node:assert/strict'
import { test } from 'node:test'

test('adapter merges live events that arrive before the delayed history snapshot', async () => {
  let resolveHistory
  const history = new Promise((resolve) => { resolveHistory = resolve })
  const sessionStorage = { getItem: () => 'tab-session', setItem() {}, removeItem() {} }
  const sources = []
  globalThis.window = { sessionStorage }
  globalThis.EventSource = class {
    constructor() { sources.push(this) }
    close() {}
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => history })
  const { chat } = await import('../src/browser/adapters.ts')
  const live = []
  const statuses = []
  const pendingHistory = chat.history()
  chat.subscribe((messages) => live.push(messages))
  const { subscribeBrowserStatus } = await import('../src/browser/adapters.ts')
  subscribeBrowserStatus((status) => statuses.push(status))
  sources[0].onmessage({ data: JSON.stringify({ sequence: 2, type: 'message', text: 'new reply' }) })
  sources[0].onmessage({ data: JSON.stringify({ sequence: 3, type: 'status', status: 'interrupted' }) })
  resolveHistory({ events: [{ sequence: 0, type: 'status', status: 'ready' }, { sequence: 1, type: 'user', text: 'old prompt' }], status: 'ready' })
  const result = await pendingHistory
  assert.deepEqual(result.map(({ text }) => text), ['old prompt', 'new reply'])
  assert.deepEqual(live.at(-1).map(({ text }) => text), ['old prompt', 'new reply'])
  assert.equal(statuses.at(-1), 'interrupted')
})

test('a live rebuilt event reloads the canvas', async () => {
  const sources = []
  const reloads = []
  globalThis.window = { sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { reload: () => reloads.push(true) } }
  globalThis.EventSource = class {
    constructor() { sources.push(this) }
    close() {}
  }
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/sessions' && options.method === 'POST') return { ok: true, json: async () => ({ id: 'reload-session', backend: 'codex' }) }
    throw new Error(`unexpected fetch ${url}`)
  }
  const { chat, startBrowserSession } = await import('../src/browser/adapters.ts')
  await startBrowserSession()
  chat.subscribe(() => {})
  sources.at(-1).onmessage({ data: JSON.stringify({ sessionId: 'reload-session', sequence: 0, type: 'rebuilt' }) })
  assert.deepEqual(reloads, [true])
})

test('a rebuilt event replayed from history/reload restoration never reloads', async () => {
  const reloads = []
  globalThis.window = { sessionStorage: { getItem: () => 'reload-session', setItem() {}, removeItem() {} }, location: { reload: () => reloads.push(true) } }
  globalThis.EventSource = class {
    constructor() {}
    close() {}
  }
  globalThis.fetch = async (url) => {
    if (url === '/api/sessions/reload-session/history') {
      return { ok: true, json: async () => ({ events: [{ sequence: 0, type: 'status', status: 'ready' }, { sequence: 1, type: 'rebuilt' }], status: 'ready' }) }
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  // This is the same restoration path a page reload takes: bulk history merge, never through applyEvent.
  const { restoreBrowserSession } = await import('../src/browser/adapters.ts')
  const restored = await restoreBrowserSession()
  assert.equal(restored, true)
  assert.deepEqual(reloads, [])
})

test('session replacement rejects stale events and old cleanup preserves the new stream', async () => {
  const sources = []
  let starts = 0
  globalThis.window = { sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } }
  globalThis.EventSource = class {
    constructor() { this.readyState = 1; sources.push(this) }
    close() { this.readyState = 2; this.closed = true }
  }
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/sessions' && options.method === 'POST') return { ok: true, json: async () => ({ id: `session-${++starts}`, backend: 'codex' }) }
    throw new Error(`unexpected fetch ${url}`)
  }
  const { chat, startBrowserSession } = await import('../src/browser/adapters.ts')
  await startBrowserSession()
  const seen = []
  const unsubscribeOld = chat.subscribe((messages) => seen.push(messages))
  await startBrowserSession()
  assert.equal(sources[0].closed, true)
  const unsubscribeNew = chat.subscribe((messages) => seen.push(messages))
  unsubscribeOld()
  assert.equal(sources[1].closed, undefined)
  sources[0].onmessage({ data: JSON.stringify({ sessionId: 'session-1', sequence: 1, type: 'message', text: 'stale' }) })
  sources[1].onmessage({ data: JSON.stringify({ sessionId: 'session-2', sequence: 1, type: 'message', text: 'current' }) })
  assert.deepEqual(seen.at(-1).map(({ text }) => text), ['current'])
  unsubscribeNew()
})
