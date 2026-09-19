import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { Session, SessionManager } from '../src/runtime/session.ts'
import { TmuxBackend, builderInstructions } from '../src/runtime/tmux.ts'

const fake = createRequire(import.meta.url)('../src/runtime/harness/fake.js')

test('tmux backend spawns once, resolves a send at turn end, restores from its ref, and detaches without killing', async () => {
  fake.reset()
  const backend = new TmuxBackend('/tmp', 'claude', undefined, { harness: fake, api: 'http://127.0.0.1:1' })
  const events = []
  const session = new Session('claude', backend, 'abc', true)
  session.subscribe((event) => events.push(event))
  await session.start()
  const ref = session.snapshot().harness
  assert.equal(ref.session, 'golem-tmp')
  assert.ok(ref.resumeId)
  assert.equal(fake.transcript(ref)[0], builderInstructions('/tmp'))
  assert.match(builderInstructions('/tmp'), /golem say/)

  await session.send('hello')
  assert.equal(fake.transcript(ref).at(-1), 'hello')
  session.receive({ type: 'message', text: 'pong' })
  assert.equal(events.at(-1).text, 'pong')

  await session.dispose()
  assert.equal(await fake.alive(ref), true, 'server stop leaves the agent running')

  const restored = Session.restore(session.snapshot(), new TmuxBackend('/tmp', 'claude', ref, { harness: fake }))
  await restored.send('again')
  assert.deepEqual(fake.transcript(ref).slice(-2), ['hello', 'again'])
  await restored.shutdown()
  assert.equal(await fake.alive(ref), false)
})

test('one agent per app: starting a second conversation parks the first, whose snapshot keeps history and resume id; a message resumes it in the same tmux session', async () => {
  fake.reset()
  const manager = new SessionManager()
  const backend = () => new TmuxBackend('/tmp/my.app', 'claude', undefined, { harness: fake, api: 'http://127.0.0.1:1' })
  const first = await manager.start('claude', backend(), true)
  await first.send('remember this')
  const ref = first.snapshot().harness
  assert.equal(ref.session, 'golem-my-app')
  await manager.parkOthers(true)
  const second = await manager.start('claude', backend(), true)
  assert.equal(second.snapshot().harness.session, ref.session, 'same tmux session, new agent')
  assert.equal(first.status, 'stopped')
  assert.equal(first.live, false)
  const snapshot = first.snapshot()
  assert.equal(snapshot.harness.resumeId, ref.resumeId)
  assert.ok(snapshot.history.some((event) => event.text === 'remember this'))
  await manager.parkOthers(true, second.id)
  assert.equal(second.live, true, 'parking others leaves the named one alone')

  await manager.parkOthers(true, first.id)
  assert.equal(second.live, false)
  await first.send('and this')
  assert.equal(first.status, 'ready')
  assert.equal(first.live, true)
  assert.equal(first.snapshot().harness.resumeId, ref.resumeId, 'resumed with its own id, not the last agent\'s')
  assert.equal(fake.transcript(ref).at(-1), 'and this')
})
