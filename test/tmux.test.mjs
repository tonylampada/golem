import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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
  assert.equal(claude.permissionFlags('readonly'), "--allowedTools 'Read,Grep,Glob,Bash(./golem say:*),Bash(./golem show:*)' --disallowedTools 'Edit,Write,NotebookEdit' --permission-mode dontAsk")
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

test('a pinned model rides the spawn args, in each CLI\'s own spelling (MNC-218)', async () => {
  const args = async (agent, model) => {
    fake.reset()
    let seen
    const spy = { ...fake, spawn: (cwd, prompt, opts) => { seen = opts; return fake.spawn(cwd, prompt, opts) } }
    const backend = new TmuxBackend('/tmp', agent, undefined, { harness: spy, api: 'http://127.0.0.1:1', window: 'chat', ...(model ? { model } : {}) })
    await backend.start(() => {}, 'sid')
    await backend.shutdown()
    return seen.extraArgs
  }
  assert.deepEqual(await args('claude', 'claude-opus-5-5'), ['--model', 'claude-opus-5-5'])
  assert.deepEqual((await args('codex', 'gpt-6-luna')).slice(-2), ['-m', 'gpt-6-luna'])
  assert.deepEqual(await args('claude'), [])
  assert.equal((await args('codex')).includes('-m'), false)
})

test('/reset after a restart: a restored, unresumed conversation still holds its window; the new agent takes it over (MNC-185)', async () => {
  fake.reset()
  const cwd = '/tmp/my.app'
  const backend = (ref) => new TmuxBackend(cwd, 'claude', ref, { harness: fake, api: 'http://127.0.0.1:1', window: 'chat', instructions: 'chat brief' })
  const before = new SessionManager()
  const old = await before.start('claude', backend(), false)
  await old.send('remember this')
  const ref = old.snapshot().harness
  await before.disposeAll() // server restart: tmux and the window survive, nothing is resumed yet

  const manager = new SessionManager()
  manager.restore([old.snapshot()], (snapshot) => backend(snapshot.harness))
  const restored = manager.get(old.id)
  assert.equal(restored.live, false)
  assert.equal(await fake.alive(ref), true)
  // /reset, first thing: park, then start a fresh agent in the same window.
  await manager.parkOthers(false)
  const fresh = await manager.start('claude', backend(), false)
  assert.equal(fresh.status, 'ready')
  assert.notEqual(fresh.snapshot().harness.resumeId, ref.resumeId)
  assert.deepEqual(fake.transcript(fresh.snapshot().harness), ['chat brief'], 'exactly one agent in the window, freshly launched')
  // The parked conversation still resumes with its own id when messaged.
  await manager.parkOthers(false, restored.id)
  await restored.send('and this')
  assert.equal(restored.status, 'ready')
  assert.equal(restored.snapshot().harness.resumeId, ref.resumeId, 'resumed with its own id')
  assert.equal(fake.transcript(ref).at(-1), 'and this')
})

test('installHooks leaves exactly one Stop entry for our script, whatever path the stale ones carry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-hooks-'))
  const settings = path.join(dir, '.claude', 'settings.local.json')
  fs.mkdirSync(path.dirname(settings), { recursive: true })
  fs.writeFileSync(settings, JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'node /old/pin/a/turnend-hook.js /state golem-x:builder' }] },
        { hooks: [{ type: 'command', command: 'node /old/pin/b/turnend-hook.js /state golem-x:chat' }] },
        { hooks: [{ type: 'command', command: 'node /someone/else/hook.js' }] },
      ],
    },
  }))

  const claudeTmux = createRequire(import.meta.url)('../src/runtime/harness/claude-tmux.js')
  await claudeTmux.installHooks(dir, 'golem-x:chat', '/state', '')

  const stop = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.Stop
  const ours = stop.filter((m) => m.hooks.some((h) => h.command.includes('turnend-hook.js')))
  assert.equal(ours.length, 1)
  assert.match(ours[0].hooks[0].command, /golem-x:chat/)
  assert.ok(stop.some((m) => m.hooks.some((h) => h.command === 'node /someone/else/hook.js')), 'other hooks survive')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the turn-end hook keys its file by the window it actually ran in, not the one baked in at install', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-turnend-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  // A stand-in tmux that answers for the ACTIVE window unless the caller targets a pane,
  // which is what the real one does and what sent the builder's turn ends to the chat's file.
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\ncase "$*" in *-t*%9*) echo "s:w" ;; *) echo "s:active" ;; esac\n')
  fs.chmodSync(path.join(bin, 'tmux'), 0o755)
  const hook = new URL('../src/runtime/harness/turnend-hook.js', import.meta.url).pathname

  const run = (key, env) =>
    execFileSync(process.execPath, [hook, dir, key], { input: '{}', env: { ...process.env, ...env } })

  run('s:builder', { TMUX: '/tmp/fake,1,0', TMUX_PANE: '%9', PATH: `${bin}:${process.env.PATH}` })
  assert.ok(fs.existsSync(path.join(dir, 's:w.turnend.jsonl')), 'the hook keys by its OWN pane, not the active window')
  assert.ok(!fs.existsSync(path.join(dir, 's:active.turnend.jsonl')))

  const noTmux = { ...process.env }
  delete noTmux.TMUX
  execFileSync(process.execPath, [hook, dir, 's:builder'], { input: '{}', env: noTmux })
  assert.ok(fs.existsSync(path.join(dir, 's:builder.turnend.jsonl')), 'no tmux: the argv key stands')

  run('plain-session', { TMUX: '/tmp/fake,1,0', TMUX_PANE: '%9', PATH: `${bin}:${process.env.PATH}` })
  assert.ok(fs.existsSync(path.join(dir, 'plain-session.turnend.jsonl')), 'session-granular keys are left alone')
  fs.rmSync(dir, { recursive: true, force: true })
})
