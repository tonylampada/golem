import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverAgents, probeExecutable, runtimeState, SessionManager } from '../src/runtime/index.ts'

const available = (names) => async (executable) => ({ status: names.includes(executable) ? 'available' : 'missing' })

test('discovery distinguishes all four availability combinations', async () => {
  for (const [names, expected] of [
    [[], 'setup'],
    [['claude'], 'ready'],
    [['codex'], 'ready'],
    [['claude', 'codex'], 'choice-required'],
  ]) {
    const state = runtimeState(await discoverAgents(available(names)))
    assert.equal(state.kind, expected)
  }
})

test('discovery preserves failed and timed-out probes', async () => {
  const discoveries = await discoverAgents(async (executable) => ({
    status: 'failed',
    detail: executable === 'claude' ? 'exited with code 1' : 'timed out',
  }))
  assert.deepEqual(discoveries.map(({ status, detail }) => ({ status, detail })), [
    { status: 'failed', detail: 'exited with code 1' },
    { status: 'failed', detail: 'timed out' },
  ])
})

test('probeExecutable handles missing, nonzero, and SIGTERM-resistant timeout processes', async () => {
  assert.equal((await probeExecutable('/definitely/missing/golem-agent')).status, 'missing')
  assert.deepEqual(await probeExecutable(process.execPath, ['-e', 'process.exit(3)']), {
    status: 'failed', detail: 'exited with code 3',
  })
  const started = Date.now()
  const timeout = await probeExecutable(process.execPath, [
    '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
  ], 40)
  assert.deepEqual(timeout, { status: 'failed', detail: 'timed out' })
  assert.ok(Date.now() - started < 1_000)
})

class FakeBackend {
  events = []
  started = 0
  stopped = 0
  async start(emit) { this.started++; this.emit = emit }
  async send(text) { this.events.push(`send:${text}`) }
  async shutdown() { this.stopped++ }
  message(text) { this.events.push(`message:${text}`); this.emit({ type: 'message', text }) }
  interrupt(reason) { this.emit({ type: 'interrupted', reason }) }
}

class PendingBackend extends FakeBackend {
  send(text) {
    this.events.push(`send:${text}`)
    return new Promise((resolve, reject) => { this.pending = { resolve, reject } })
  }
}

test('sessions order events, retain history across subscriptions, and shut down explicitly', async () => {
  const manager = new SessionManager()
  const firstBackend = new FakeBackend()
  const first = await manager.start('claude', firstBackend)
  const seen = []
  const unsubscribe = first.subscribe((event) => seen.push(event.type))
  await first.send('one')
  firstBackend.message('answer')
  unsubscribe()
  firstBackend.message('missed live')
  const reconnect = []
  first.subscribe((event) => reconnect.push(event.text))
  assert.deepEqual(reconnect, [])
  assert.deepEqual(first.history.map(({ type }) => type), ['status', 'user', 'message', 'message'])
  assert.deepEqual(seen, ['user', 'message'])
  assert.equal(first.status, 'ready')
  firstBackend.interrupt('cancelled')
  assert.equal(first.status, 'interrupted')
  await first.send('new action')
  assert.deepEqual(firstBackend.events, ['send:one', 'message:answer', 'message:missed live', 'send:new action'])
  await manager.shutdown(first.id)
  assert.equal(first.status, 'stopped')
  assert.equal(firstBackend.stopped, 1)
})

test('sessions are independent', async () => {
  const manager = new SessionManager()
  const one = await manager.start('claude', new FakeBackend())
  const two = await manager.start('codex', new FakeBackend())
  assert.notEqual(one.id, two.id)
  await one.send('one')
  assert.deepEqual(two.history.map(({ type }) => type), ['status'])
})

test('interruption rejects queued sends and only a fresh action resumes', async () => {
  const backend = new PendingBackend()
  const session = await new SessionManager().start('claude', backend)
  const first = session.send('first')
  await new Promise((resolve) => setImmediate(resolve))
  const queued = session.send('queued')
  backend.interrupt('cancelled')
  await assert.rejects(queued, /interrupted/)
  backend.pending.resolve()
  await first
  assert.deepEqual(backend.events, ['send:first'])
  const fresh = session.send('fresh')
  await new Promise((resolve) => setImmediate(resolve))
  backend.pending.resolve()
  await fresh
  assert.deepEqual(backend.events, ['send:first', 'send:fresh'])
  assert.equal(session.status, 'ready')
})

test('startup failure remains terminal and shuts the backend down', async () => {
  const backend = new FakeBackend()
  const originalStart = backend.start
  backend.start = async (emit) => { await originalStart.call(backend, emit); emit({ type: 'error', message: 'start failed' }) }
  await assert.rejects(new SessionManager().start('claude', backend), /failed during startup/)
  assert.equal(backend.stopped, 1)
})

test('shutdown does not wait for send and runs backend shutdown once', async () => {
  const backend = new PendingBackend()
  const session = await new SessionManager().start('claude', backend)
  const send = session.send('pending')
  const shutdowns = await Promise.all([session.shutdown(), session.shutdown()])
  assert.equal(shutdowns.length, 2)
  assert.equal(backend.stopped, 1)
  await assert.rejects(session.send('after shutdown'), /stopped/)
  backend.message('late')
  assert.equal(session.history.some(({ text }) => text === 'late'), false)
  backend.pending.resolve()
  await send
})
