import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startDevServer } from '../src/dev-server.ts'

test('HTTP transport validates mutations and isolates server-owned sessions', { timeout: 30000 }, async () => {
  const server = await startDevServer(3218)
  try {
    const invalid = await fetch('http://127.0.0.1:3218/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'claude' }),
    })
    assert.equal(invalid.status, 400)
    const crossOrigin = await fetch('http://127.0.0.1:3218/api/sessions', {
      method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex' }),
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal((await fetch('http://127.0.0.1:3218/api/anything/session-1/history')).status, 404)
    const malformed = await fetch('http://127.0.0.1:3218/api/sessions', { method: 'POST', body: '{' })
    assert.equal(malformed.status, 400)
    const malformedUrl = await fetch('http://127.0.0.1:3218/api/%E0%A4%A')
    assert.equal(malformedUrl.status, 400)

    const create = async () => (await (await fetch('http://127.0.0.1:3218/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex' }),
    })).json()).id
    const [one, two] = await Promise.all([create(), create()])
    assert.notEqual(one, two)
    const history = await (await fetch(`http://127.0.0.1:3218/api/sessions/${one}/history`)).json()
    assert.equal(history.backend, 'codex')
    assert.deepEqual(history.events.map((event) => event.type), ['status'])
    assert.equal((await fetch(`http://127.0.0.1:3218/api/sessions/${two}/history`)).status, 200)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

class DelayedBackend {
  async start(emit) { this.emit = emit }
  async send(text) {
    this.pending = { text, resolve: undefined }
    await new Promise((resolve) => { this.pending.resolve = resolve })
  }
  async shutdown() { this.pending?.resolve() }
  async interrupt() { this.emit({ type: 'interrupted', reason: 'user requested' }); this.pending?.resolve() }
  reply(text) { this.emit({ type: 'message', text }); this.pending?.resolve() }
}

test('SSE cursor replays a response after disconnecting during work', { timeout: 30000 }, async () => {
  const backend = new DelayedBackend()
  const server = await startDevServer(3219, () => backend)
  try {
    const created = await (await fetch('http://127.0.0.1:3219/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex' }),
    })).json()
    const first = await fetch(`http://127.0.0.1:3219/api/sessions/${created.id}/events?after=-1`)
    const reader = first.body.getReader()
    const initial = new TextDecoder().decode((await reader.read()).value)
    assert.match(initial, /id: 0/)
    const send = fetch(`http://127.0.0.1:3219/api/sessions/${created.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'delayed' }),
    })
    await new Promise((resolve) => setImmediate(resolve))
    const user = new TextDecoder().decode((await reader.read()).value)
    assert.match(user, /id: 1/)
    await reader.cancel()
    backend.reply('reconnected reply')
    await send
    const reconnect = await fetch(`http://127.0.0.1:3219/api/sessions/${created.id}/events?after=1`)
    const reconnectReader = reconnect.body.getReader()
    const replay = new TextDecoder().decode((await reconnectReader.read()).value)
    assert.match(replay, /id: 2/)
    assert.match(replay, /reconnected reply/)
    await reconnectReader.cancel()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('random session IDs make stale browser IDs safe across server restarts', { timeout: 30000 }, async () => {
  const firstServer = await startDevServer(3225)
  let stale
  try {
    stale = (await (await fetch('http://127.0.0.1:3225/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex' }),
    })).json()).id
  } finally {
    await new Promise((resolve) => firstServer.close(resolve))
  }
  const secondServer = await startDevServer(3225)
  try {
    const fresh = (await (await fetch('http://127.0.0.1:3225/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex' }),
    })).json()).id
    assert.notEqual(stale, fresh)
    assert.equal((await fetch(`http://127.0.0.1:3225/api/sessions/${stale}/history`)).status, 404)
    assert.equal((await fetch(`http://127.0.0.1:3225/api/sessions/${fresh}/history`)).status, 200)
  } finally {
    await new Promise((resolve) => secondServer.close(resolve))
  }
})
