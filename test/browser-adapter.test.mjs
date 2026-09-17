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
  const pendingHistory = chat.history()
  chat.subscribe((messages) => live.push(messages))
  sources[0].onmessage({ data: JSON.stringify({ sequence: 2, type: 'message', text: 'new reply' }) })
  resolveHistory({ events: [{ sequence: 1, type: 'user', text: 'old prompt' }], status: 'ready' })
  const result = await pendingHistory
  assert.deepEqual(result.map(({ text }) => text), ['old prompt', 'new reply'])
  assert.deepEqual(live.at(-1).map(({ text }) => text), ['old prompt', 'new reply'])
})
