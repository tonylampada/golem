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

test('a fresh browser discovers history without starting work', async () => {
  const values = new Map()
  globalThis.window = {
    sessionStorage: { getItem: () => null, setItem(key, value) { values.set(key, value) }, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {} },
  }
  let discovery = 0
  globalThis.fetch = async (url) => {
    if (url === '/api/sessions/latest') { discovery++; return { ok: true, status: 200, json: async () => ({ id: 'saved' }) } }
    if (url === '/api/sessions/saved/history') return { ok: true, status: 200, json: async () => ({ events: [{ sequence: 0, type: 'user', text: 'earlier', clientMessageId: 'old' }], status: 'ready' }) }
    throw new Error(`unexpected fetch ${url}`)
  }
  const { chat, restoreBrowserSession } = await import(`../src/browser/adapters.ts?discovery=${Date.now()}`)
  assert.equal(await restoreBrowserSession(), true)
  assert.equal(discovery, 1)
  assert.deepEqual((await chat.history()).map(({ text }) => text), ['earlier'])
  assert.equal(values.get('golem.browser.session'), 'saved')
})

test('failed optimistic messages remain retryable until matching history confirms them', async () => {
  const values = new Map()
  globalThis.window = {
    sessionStorage: { getItem: () => 'session', setItem() {}, removeItem() {} },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem(key, value) { values.set(key, value) } },
  }
  let attempts = 0
  let sentId
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/sessions/session' && options.method === 'POST') {
      sentId = JSON.parse(options.body).clientMessageId
      attempts++
      return attempts === 1 ? { ok: false, json: async () => ({ error: 'offline' }) } : { ok: true, json: async () => ({}) }
    }
    if (url === '/api/sessions/session/history') return { ok: true, json: async () => ({ events: [{ sequence: 1, type: 'user', text: 'keep me', clientMessageId: sentId }], status: 'ready' }) }
    throw new Error(`unexpected fetch ${url}`)
  }
  const { chat } = await import(`../src/browser/adapters.ts?outbox=${Date.now()}`)
  const seen = []
  chat.subscribe((messages) => seen.push(messages))
  await assert.rejects(chat.send('keep me'), /offline/)
  const failed = seen.at(-1)[0]
  assert.equal(failed.delivery, 'failed')
  await chat.retry(failed.id)
  assert.equal(seen.at(-1).filter(({ text }) => text === 'keep me').length, 1)
  assert.equal(seen.at(-1)[0].delivery, undefined)
  await chat.history()
  assert.equal(seen.at(-1).filter(({ text }) => text === 'keep me').length, 1)
})

test('restored pending messages become retryable when history has no receipt', async () => {
  const stored = JSON.stringify([{ id: 'stalled', sessionId: 'session', text: 'retry me', delivery: 'pending', at: 'now' }])
  globalThis.window = {
    sessionStorage: { getItem: () => 'session', setItem() {}, removeItem() {} },
    localStorage: { getItem: () => stored, setItem() {} },
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ events: [], status: 'ready' }) })
  const { chat } = await import(`../src/browser/adapters.ts?stalled=${Date.now()}`)
  assert.equal((await chat.history())[0].delivery, 'failed')
})

test('a stale tab history merge preserves another tab’s stored outbox message', async () => {
  const values = new Map()
  globalThis.window = {
    sessionStorage: { getItem: () => 'session', setItem() {}, removeItem() {} },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem(key, value) { values.set(key, value) } },
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ events: [], status: 'ready' }) })
  const { chat } = await import(`../src/browser/adapters.ts?stale-tab=${Date.now()}`)
  values.set('golem.browser.outbox', JSON.stringify([{ id: 'from-a', sessionId: 'session', text: 'from A', delivery: 'pending', at: 'now' }]))
  await chat.history()
  assert.equal(JSON.parse(values.get('golem.browser.outbox')).filter(({ id }) => id === 'from-a').length, 1)
})

test('a late durable receipt is merged after higher interrupt events and on reconnect replay', async () => {
  const sources = []
  globalThis.window = { sessionStorage: { getItem: () => 'session', setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {} } }
  globalThis.EventSource = class { constructor() { sources.push(this) } close() {} }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  const { chat } = await import(`../src/browser/adapters.ts?late=${Date.now()}`)
  const seen = []
  chat.subscribe((messages) => seen.push(messages))
  for (const event of [
    { sequence: 2, type: 'status', status: 'interrupted' },
    { sequence: 3, type: 'interrupted', reason: 'stopped' },
    { sequence: 1, type: 'user', text: 'durable receipt', clientMessageId: 'late-id' },
  ]) sources[0].onmessage({ data: JSON.stringify(event) })
  assert.deepEqual(seen.at(-1).map(({ text }) => text), ['durable receipt', 'Interrupted: stopped'])
  sources[0].onmessage({ data: JSON.stringify({ sequence: 1, type: 'user', text: 'durable receipt', clientMessageId: 'late-id' }) })
  assert.equal(seen.at(-1).filter(({ text }) => text === 'durable receipt').length, 1)
})

test('a reconnect refreshes late durable receipts below the SSE cursor', async () => {
  const sources = []
  globalThis.window = { sessionStorage: { getItem: () => 'session', setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {} } }
  globalThis.EventSource = class {
    static CLOSED = 2
    constructor() { this.readyState = 1; sources.push(this) }
    close() { this.readyState = 2 }
  }
  globalThis.fetch = async (url) => ({ ok: true, json: async () => url.includes('/history') ? ({ events: [{ sequence: 1, type: 'user', text: 'reconnected receipt', clientMessageId: 'reconnect-id' }, { sequence: 2, type: 'interrupted', reason: 'stopped' }], status: 'interrupted' }) : ({}) })
  const { chat } = await import(`../src/browser/adapters.ts?reconnect=${Date.now()}`)
  const seen = []
  chat.subscribe((messages) => seen.push(messages))
  sources[0].onmessage({ data: JSON.stringify({ sequence: 2, type: 'interrupted', reason: 'stopped' }) })
  sources[0].readyState = 2
  sources[0].onerror()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.at(-1).filter(({ text }) => text === 'reconnected receipt').length, 1)
})
