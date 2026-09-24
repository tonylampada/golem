import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fixtureApp } from './fixtures/app.mjs'

const fake = createRequire(import.meta.url)('../src/runtime/harness/fake.js')

/** `claude` and `codex` on PATH that answer `--version` and `auth status`, so discovery finds them runnable. */
function fakeCliDir() {
  const dir = mkdtempSync(join(tmpdir(), 'golem-switch-bin-'))
  for (const name of ['claude', 'codex']) {
    const path = join(dir, name)
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    chmodSync(path, 0o755)
  }
  return dir
}

test('a saved conversation whose agent the app no longer configures is retired, and the next one runs on the configured agent with its pin (MNC-220)', { timeout: 120000 }, async () => {
  fake.reset()
  const root = fixtureApp(mkdtempSync(join(tmpdir(), 'golem-switch-')))
  // The app has moved to codex, pinned, with no sandbox; the conversation on disk is yesterday's claude.
  writeFileSync(join(root, 'golem.config.ts'), `export default { title: 'Field Notes', chat: { provider: 'tmux', agent: 'codex', model: 'gpt-6-luna', sandbox: 'none' } }\n`)
  const state = join(root, '.golem')
  mkdirSync(state, { recursive: true })
  const yesterday = {
    id: 'saved-on-claude', backend: 'claude', buildMode: false, status: 'ready', active: false,
    history: [{ sequence: 1, type: 'message', text: 'hello from claude' }],
    harness: { harness: 'claude', session: 'golem-app', cwd: root, window: 'chat', resumeId: 'r1' },
  }
  writeFileSync(join(state, 'conversations.json'), JSON.stringify({ version: 1, sessions: [yesterday] }) + '\n')

  process.chdir(root)
  const path = process.env.PATH
  process.env.PATH = `${fakeCliDir()}:${path}`
  const { harnesses } = await import('../src/runtime/tmux.ts')
  const spawns = []
  for (const agent of ['claude', 'codex']) harnesses[agent] = { ...fake, spawn: (cwd, prompt, opts) => { spawns.push({ agent, opts }); return fake.spawn(cwd, prompt, opts) } }
  const { startDevServer } = await import('../src/dev-server.ts')
  const base = 'http://127.0.0.1:3245/api'
  const server = await startDevServer(3245, undefined, state)
  try {
    // Not resumed: the browser finds no conversation to restore, so it opens a fresh one.
    assert.equal((await fetch(`${base}/sessions/latest?chat=1`)).status, 404)
    const created = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex', intent: 'chat' }) })
    assert.equal(created.status, 201)
    const fresh = await created.json()
    assert.equal(spawns.at(-1).agent, 'codex')
    assert.deepEqual(spawns.at(-1).opts.extraArgs.slice(-2), ['-m', 'gpt-6-luna'], 'the pin follows the configured agent')
    assert.equal(spawns.at(-1).opts.permissions, 'bypass', "sandbox: 'none' launches on the bypass profile")

    // The claude conversation stays readable in the file, marked, beside the new one.
    const sessions = JSON.parse(readFileSync(join(state, 'conversations.json'), 'utf8')).sessions
    const old = sessions.find((one) => one.id === yesterday.id)
    assert.equal(old.retired, true)
    assert.equal(old.backend, 'claude')
    assert.ok(old.history.some((event) => event.text === 'hello from claude'))
    assert.equal(sessions.find((one) => one.id === fresh.id).retired, undefined)
  } finally {
    process.env.PATH = path
    await new Promise((resolve) => server.close(resolve))
  }
})
