import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverAgents, runtimeState, SessionManager } from '../src/runtime/index.ts'

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
