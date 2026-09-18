import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startDevServer } from '../src/dev-server.ts'

const start = (port, backend) => startDevServer(port, backend, mkdtempSync(join(tmpdir(), 'golem-state-')))

function postWithAuthority(address, port, authority, origin) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: address, port, path: '/api/sessions', method: 'POST', headers: { host: authority, origin, 'content-type': 'application/json' } }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    request.once('error', reject)
    request.end(JSON.stringify({ backend: 'invalid' }))
  })
}

test('HTTP transport validates mutations and isolates server-owned sessions', { timeout: 30000 }, async () => {
  const server = await start(3218)
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

test('a configured bind address accepts the request hostname origin and rejects unrelated origins', { timeout: 30000 }, async () => {
  const port = 3217
  const host = '127.0.0.2'
  const server = await startDevServer(port, () => { throw new Error('backend must not start') }, mkdtempSync(join(tmpdir(), 'golem-state-')), host)
  try {
    const hostname = `builder.example.test:${port}`
    assert.equal(await postWithAuthority(host, port, hostname, `http://${hostname}`), 400)
    const rejected = await fetch(`http://${host}:${port}/api/sessions`, {
      method: 'POST',
      headers: { origin: 'https://example.invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'invalid' }),
    })
    assert.equal(rejected.status, 403)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

class InstantBackend {
  async start(emit) { this.started = true; this.emit = emit }
  async send(text) { this.emit({ type: 'message', text: `echo:${text}` }) }
  async shutdown() {}
}

async function waitForHistory(port, id, predicate, timeout = 20_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const history = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/history`)).json()
    if (predicate(history.events)) return history
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('timed out waiting for history')
}

test('a successful build-mode turn triggers a rebuild and notifies the browser', { timeout: 30000 }, async () => {
  const server = await start(3230, () => new InstantBackend())
  try {
    const created = await (await fetch('http://127.0.0.1:3230/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex', intent: 'build' }),
    })).json()
    const send = await fetch(`http://127.0.0.1:3230/api/sessions/${created.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'edit it', clientMessageId: 'edit-it' }),
    })
    assert.equal(send.status, 202)
    const history = await waitForHistory(3230, created.id, (events) => events.some((event) => event.type === 'rebuilt'))
    assert.deepEqual(history.events.map((event) => event.type), ['status', 'user', 'message', 'rebuilt'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('back-to-back build-mode turns coalesce their rebuilds instead of racing', { timeout: 30000 }, async () => {
  const server = await start(3231, () => new InstantBackend())
  try {
    const created = await (await fetch('http://127.0.0.1:3231/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex', intent: 'build' }),
    })).json()
    const send = (text) => fetch(`http://127.0.0.1:3231/api/sessions/${created.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, clientMessageId: text }),
    })
    const [first, second] = await Promise.all([send('one'), send('two')])
    assert.equal(first.status, 202)
    assert.equal(second.status, 202)
    const history = await waitForHistory(3231, created.id, (events) => events.filter((event) => event.type === 'rebuilt').length >= 1 && events.filter((event) => event.type === 'user').length === 2)
    assert.ok(!history.events.some((event) => event.type === 'error'))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('build intent is server-owned: omitted intent stays read-only and never rebuilds; explicit build intent is writable and rebuilds', { timeout: 30000 }, async () => {
  const modes = []
  const createBackend = (mode) => { modes.push(mode); return new InstantBackend() }
  const server = await start(3232, createBackend)
  try {
    const readOnly = await (await fetch('http://127.0.0.1:3232/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex' }),
    })).json()
    const build = await (await fetch('http://127.0.0.1:3232/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex', intent: 'build' }),
    })).json()
    assert.deepEqual(modes, ['read-only', 'danger-full-access'])

    await fetch(`http://127.0.0.1:3232/api/sessions/${readOnly.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', clientMessageId: 'read-only-hi' }),
    })
    await fetch(`http://127.0.0.1:3232/api/sessions/${build.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', clientMessageId: 'build-hi' }),
    })

    const buildHistory = await waitForHistory(3232, build.id, (events) => events.some((event) => event.type === 'rebuilt'))
    assert.ok(buildHistory.events.some((event) => event.type === 'rebuilt'))

    // Give a stray rebuild a chance to land on the read-only session if the server-side gate were missing.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const readOnlyHistory = await (await fetch(`http://127.0.0.1:3232/api/sessions/${readOnly.id}/history`)).json()
    assert.ok(!readOnlyHistory.events.some((event) => event.type === 'rebuilt'))
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
  const server = await start(3219, () => backend)
  try {
    const created = await (await fetch('http://127.0.0.1:3219/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex' }),
    })).json()
    const first = await fetch(`http://127.0.0.1:3219/api/sessions/${created.id}/events?after=-1`)
    const reader = first.body.getReader()
    const initial = new TextDecoder().decode((await reader.read()).value)
    assert.match(initial, /id: 0/)
    const send = fetch(`http://127.0.0.1:3219/api/sessions/${created.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'delayed', clientMessageId: 'delayed' }),
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

test('a receipt is durable and idempotent before a delayed backend turn completes', { timeout: 30000 }, async () => {
  const backend = new DelayedBackend()
  const server = await start(3228, () => backend)
  try {
    const created = await (await fetch('http://127.0.0.1:3228/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex', intent: 'build' }),
    })).json()
    const request = (id) => fetch(`http://127.0.0.1:3228/api/sessions/${created.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'keep this', clientMessageId: id }),
    })
    const first = await request('stable-message')
    assert.equal(first.status, 202)
    assert.equal((await first.json()).duplicate, false)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(backend.pending.text, 'keep this')
    const repeated = await request('stable-message')
    assert.equal(repeated.status, 202)
    assert.equal((await repeated.json()).duplicate, true)
    assert.equal(backend.pending.text, 'keep this')
    const history = await (await fetch(`http://127.0.0.1:3228/api/sessions/${created.id}/history`)).json()
    assert.deepEqual(history.events.filter((event) => event.type === 'user').map((event) => event.clientMessageId), ['stable-message'])
    backend.reply('done')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('saved sessions survive restart without starting a backend, and resume their saved thread', { timeout: 30000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'golem-state-'))
  const backends = []
  class ThreadBackend extends InstantBackend {
    constructor(threadId) { super(); this.savedThread = threadId; this.currentThread = threadId }
    async send(text) { this.currentThread ??= 'native-thread'; await super.send(`${this.currentThread}:${text}`) }
    threadId() { return this.currentThread }
  }
  const makeBackend = (_mode, threadId) => { const backend = new ThreadBackend(threadId); backends.push(backend); return backend }
  const firstServer = await startDevServer(3225, makeBackend, state)
  let stale
  try {
    stale = (await (await fetch('http://127.0.0.1:3225/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex', intent: 'build' }),
    })).json()).id
    await fetch(`http://127.0.0.1:3225/api/sessions/${stale}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'first', clientMessageId: 'first' }) })
  } finally {
    await new Promise((resolve) => firstServer.close(resolve))
  }
  const secondServer = await startDevServer(3225, makeBackend, state)
  try {
    assert.equal(backends.at(-1).started, undefined, 'recovery must not start an agent')
    const latest = await (await fetch('http://127.0.0.1:3225/api/sessions/latest')).json()
    assert.equal(latest.id, stale, 'fresh browsers discover the persisted build conversation without starting it')
    assert.equal(backends.at(-1).started, undefined, 'discovery must not start an agent')
    const history = await (await fetch(`http://127.0.0.1:3225/api/sessions/${stale}/history`)).json()
    assert.equal(history.status, 'ready')
    assert.deepEqual(history.events.filter((event) => event.type === 'user' || event.type === 'message').map((event) => event.text), ['first', 'echo:native-thread:first'])
    const followup = await fetch(`http://127.0.0.1:3225/api/sessions/${stale}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'followup', clientMessageId: 'followup' }) })
    assert.equal(followup.status, 202)
    assert.equal(backends.at(-1).savedThread, 'native-thread')
    assert.equal(backends.at(-1).started, true)
  } finally {
    await new Promise((resolve) => secondServer.close(resolve))
  }
})
