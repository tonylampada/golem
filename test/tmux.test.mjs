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

test('a legacy ref (golem-<uuid>, no window) resumes into the app\'s fixed session and window, keeping its resume id', async () => {
  fake.reset()
  const cwd = '/tmp/my.app'
  const first = new TmuxBackend(cwd, 'claude', undefined, { harness: fake, api: 'http://127.0.0.1:1' })
  const session = new Session('claude', first, 'abc', true)
  await session.start()
  await session.send('remember this')
  const legacy = { ...session.snapshot().harness, session: 'golem-0f3e2a1c-legacy' }
  delete legacy.window
  await session.dispose()

  const restored = Session.restore({ ...session.snapshot(), harness: legacy }, new TmuxBackend(cwd, 'claude', legacy, { harness: fake, window: 'builder' }))
  await restored.send('again')
  const ref = restored.snapshot().harness
  assert.equal(ref.session, 'golem-my-app')
  assert.equal(ref.window, 'builder')
  assert.equal(ref.resumeId, legacy.resumeId)
  assert.equal(fake.transcript(ref).at(-1), 'again')
  assert.equal(await fake.alive(legacy), false, 'the stray legacy session is gone')
})

test('launch profile: the chat window runs read-only and never prompts; the builder keeps bypass; resume replays the recorded profile', async () => {
  const claude = createRequire(import.meta.url)('../src/runtime/harness/claude-tmux.js')
  const codex = createRequire(import.meta.url)('../src/runtime/harness/codex-tmux.js')
  const s = createRequire(import.meta.url)('../src/runtime/harness/tmux-session.js')
  assert.equal(claude.permissionFlags(undefined), '--dangerously-skip-permissions')
  assert.equal(claude.permissionFlags('readonly'), "--allowedTools 'Read,Grep,Glob,Bash(./golem say:*)' --disallowedTools 'Edit,Write,NotebookEdit' --permission-mode dontAsk")
  assert.equal(codex.permissionFlags('bypass'), '--dangerously-bypass-approvals-and-sandbox')
  assert.equal(codex.permissionFlags('readonly'), '--sandbox read-only --ask-for-approval never')
  assert.throws(() => claude.permissionFlags('yolo'))

  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(`${tmpdir()}/golem-profile-`)
  s.recordSpawnArgs(dir, 'k', { permissions: 'readonly' })
  assert.equal(s.recordedSpawnArgs(dir, 'k').permissions, 'readonly')
  s.recordSpawnArgs(dir, 'k', {})
  assert.equal(s.recordedSpawnArgs(dir, 'k').permissions, undefined)

  fake.reset()
  let seen
  const spy = { ...fake, spawn: (cwd, prompt, opts) => { seen = opts; return fake.spawn(cwd, prompt, opts) } }
  const backend = new TmuxBackend('/tmp', 'claude', undefined, { harness: spy, api: 'http://127.0.0.1:1', window: 'chat', permissions: 'readonly' })
  await backend.start(() => {}, 'sid')
  assert.equal(seen.permissions, 'readonly')
  await backend.shutdown()
})
