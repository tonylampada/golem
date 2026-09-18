import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverAgents, probeExecutable, runtimeState, Session, SessionManager } from '../src/runtime/index.ts'
import { ConversationState } from '../src/runtime/state.ts'
import { mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

test('shutdown cancels a same-stack send before backend dispatch', async () => {
  const backend = new FakeBackend()
  const session = await new SessionManager().start('claude', backend)
  const send = session.send('not dispatched')
  await session.shutdown()
  await assert.rejects(send, /stopped/)
  assert.deepEqual(backend.events, [])
})

test('shutdown across startup yields cancels before backend dispatch', async () => {
  const backend = new FakeBackend()
  const session = await new SessionManager().start('claude', backend)
  const send = session.send('x')
  await Promise.resolve()
  const shutdown = session.shutdown()
  await assert.rejects(send, /stopped/)
  await shutdown
  assert.deepEqual(backend.events, [])
  assert.equal(backend.stopped, 1)
})

test('subscriber shutdown cancels before backend dispatch', async () => {
  const backend = new FakeBackend()
  const session = await new SessionManager().start('claude', backend)
  session.subscribe((event) => { if (event.type === 'user') void session.shutdown() })
  await assert.rejects(session.send('subscriber-cancelled'), /stopped/)
  assert.deepEqual(backend.events, [])
  assert.equal(backend.stopped, 1)
})

test('interruption before dispatch cancels old work before fresh resumption', async () => {
  const backend = new PendingBackend()
  const session = await new SessionManager().start('claude', backend)
  const old = session.send('old')
  backend.interrupt('cancelled')
  await assert.rejects(old, /interrupted/)
  const fresh = session.send('fresh')
  await new Promise((resolve) => setImmediate(resolve))
  backend.pending.resolve()
  await fresh
  assert.deepEqual(backend.events, ['send:fresh'])
})

test('startup failure remains terminal and shuts the backend down', async () => {
  const backend = new FakeBackend()
  const originalStart = backend.start
  backend.start = async (emit) => { await originalStart.call(backend, emit); emit({ type: 'error', message: 'start failed' }) }
  await assert.rejects(new SessionManager().start('claude', backend), /failed during startup/)
  assert.equal(backend.stopped, 1)
})

test('notifyRebuilt records a rebuilt event without disturbing status', async () => {
  const session = await new SessionManager().start('codex', new FakeBackend())
  session.notifyRebuilt()
  assert.deepEqual(session.history.map(({ type }) => type), ['status', 'rebuilt'])
  assert.equal(session.status, 'ready')
})

test('notifyBuildFailed routes through the existing error surface and stays recoverable', async () => {
  const backend = new FakeBackend()
  const session = await new SessionManager().start('codex', backend)
  session.notifyBuildFailed('syntax error in src/app.tsx')
  assert.equal(session.status, 'failed')
  assert.deepEqual(session.history.map(({ type, text }) => ({ type, text })), [
    { type: 'status', text: undefined },
    { type: 'status', text: undefined },
    { type: 'error', text: 'syntax error in src/app.tsx' },
  ])
  await session.send('repair it')
  assert.equal(session.status, 'ready')
  assert.deepEqual(backend.events, ['send:repair it'])
})

test('rebuild notifications after shutdown are dropped, not replayed', async () => {
  const session = await new SessionManager().start('codex', new FakeBackend())
  await session.shutdown()
  session.notifyRebuilt()
  session.notifyBuildFailed('too late')
  assert.deepEqual(session.history.map(({ type }) => type), ['status', 'status'])
})

test('shutdown does not wait for send and runs backend shutdown once', async () => {
  const backend = new PendingBackend()
  const session = await new SessionManager().start('claude', backend)
  const send = session.send('pending')
  await new Promise((resolve) => setImmediate(resolve))
  const shutdowns = await Promise.all([session.shutdown(), session.shutdown()])
  assert.equal(shutdowns.length, 2)
  assert.equal(backend.stopped, 1)
  await assert.rejects(session.send('after shutdown'), /stopped/)
  backend.message('late')
  assert.equal(session.history.some(({ text }) => text === 'late'), false)
  backend.pending.resolve()
  await send
})

test('cancellation while worker startup yields never dispatches the old send', async () => {
  for (const action of ['interrupt', 'shutdown']) {
    const calls = []
    const worker = { async start() { calls.push('start') }, async send() { calls.push('SEND') }, async interrupt() { calls.push('interrupt') }, async shutdown() { calls.push('shutdown') } }
    const session = Session.restore({ id: 'restored', backend: 'codex', buildMode: false, status: 'ready', active: false, history: [] }, worker)
    session.subscribe((event) => { if (event.type === 'user') queueMicrotask(() => { void session[action]() }) })
    await assert.rejects(session.send('must not execute'), /interrupted|stopped/)
    assert.ok(!calls.includes('SEND'), action)
  }
})

test('duplicate receipts wait for the original durable save and never leak uncommitted history', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let fail = false
  let hold = false
  const backend = new FakeBackend()
  const session = new Session('codex', backend, 'durable', false, async () => { if (hold) await gate; if (fail) throw new Error('disk full') })
  await session.start()
  hold = true
  const first = session.accept('one', 'same')
  await new Promise((resolve) => setImmediate(resolve))
  const replay = []
  session.subscribeFrom(-1, (event) => replay.push(event))
  assert.ok(!replay.some((event) => event.type === 'user'))
  const duplicate = session.accept('one', 'same')
  fail = true
  release()
  await assert.rejects(first, /disk full/)
  await assert.rejects(duplicate, /disk full/)
  assert.equal(backend.events.length, 0)
})

test('an accepted turn persists active work before dispatch and restores as interrupted', async () => {
  const backend = new PendingBackend()
  const session = await new SessionManager().start('codex', backend)
  await session.accept('hold', 'active')
  await new Promise((resolve) => setImmediate(resolve))
  const restored = Session.restore(session.snapshot(), new FakeBackend())
  assert.equal(restored.status, 'interrupted')
})

test('an interrupt cannot revive an acceptance that was waiting for durability', async () => {
  let hold = false
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = new FakeBackend()
  const session = new Session('codex', backend, 'generation', false, async () => { if (hold) await gate })
  await session.start()
  hold = true
  const old = session.accept('old', 'old')
  await new Promise((resolve) => setImmediate(resolve))
  await session.interrupt()
  const fresh = session.accept('fresh', 'fresh')
  release()
  await assert.rejects(old, /Session ready/)
  await fresh
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(backend.events, ['send:fresh'])
})

test('an interrupt cannot revive a turn paused while persisting active work', async () => {
  let hold = false
  let activeSaving
  let release
  const activeSave = new Promise((resolve) => { release = resolve })
  const backend = new FakeBackend()
  const session = new Session('codex', backend, 'active-generation', false, async (snapshot) => {
    if (hold && snapshot.active) { activeSaving?.(); await activeSave }
  })
  await session.start()
  hold = true
  const waiting = new Promise((resolve) => { activeSaving = resolve })
  const old = await session.accept('old', 'old-active')
  void old.completion?.catch(() => {})
  await waiting
  await session.interrupt()
  const fresh = session.accept('fresh', 'fresh-active')
  release()
  await fresh
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(backend.events, ['send:fresh'])
})

test('conversation state rejects corrupt and unwritable files without replacing them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'golem-state-'))
  await writeFile(join(directory, 'conversations.json'), '{not json')
  await assert.rejects(new ConversationState(directory).load(), /Cannot load saved conversations/)
  const blocked = join(directory, 'not-a-directory')
  await writeFile(blocked, 'file')
  await assert.rejects(new ConversationState(join(blocked, 'child')).save([]), /Cannot save conversations/)
})

test('conversation state serializes snapshots from independent sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'golem-state-'))
  const state = new ConversationState(directory)
  const originalRename = fsPromises.rename
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  let first = true
  fsPromises.rename = async (...args) => { if (first) { first = false; await blocked } return originalRename(...args) }
  syncBuiltinESMExports()
  try {
    const one = state.save([{ id: 'one', history: [] }])
    await new Promise((resolve) => setImmediate(resolve))
    const two = state.save([{ id: 'one', history: [{ sequence: 1 }] }, { id: 'two', history: [] }])
    release()
    await Promise.all([one, two])
    assert.deepEqual((await state.load()).map(({ id, history }) => [id, history.length]), [['one', 1], ['two', 0]])
  } finally {
    fsPromises.rename = originalRename
    syncBuiltinESMExports()
  }
})
