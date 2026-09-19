import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { Session } from '../src/runtime/session.ts'
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
  assert.equal(ref.session, 'golem-abc')
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
