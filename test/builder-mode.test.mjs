import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startDevServer } from '../src/dev-server.ts'
import { TmuxBackend, chatInstructions } from '../src/runtime/tmux.ts'

const fake = createRequire(import.meta.url)('../src/runtime/harness/fake.js')

test('builder mode: one tmux session with builder and chat windows, the Builder flag persists, /reset parks and restarts in the same window', { timeout: 30000 }, async () => {
  fake.reset()
  const state = mkdtempSync(join(tmpdir(), 'golem-state-'))
  const server = await startDevServer(3241, (backend, ref, buildMode = true) => new TmuxBackend('/tmp/my.app', backend, ref, { harness: fake, api: 'http://127.0.0.1:3241', window: buildMode ? 'builder' : 'chat', ...(buildMode ? {} : { instructions: chatInstructions('/tmp/my.app') }) }), state)
  try {
    const base = 'http://127.0.0.1:3241/api'
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const get = async (path) => (await fetch(`${base}${path}`)).json()

    const builder = await (await post('/sessions', { backend: 'claude', intent: 'build' })).json()
    const chat = await (await post('/sessions', { backend: 'claude', intent: 'chat' })).json()
    // Both live: same tmux session, different windows.
    assert.equal((await get(`/sessions/${builder.id}/history`)).status, 'ready')
    assert.equal((await get(`/sessions/${chat.id}/history`)).status, 'ready')
    assert.equal((await get('/sessions/latest')).id, builder.id)
    assert.equal((await get('/sessions/latest?chat=1')).id, chat.id)
    // The chat window's agent is briefed as a non-builder.
    assert.match(chatInstructions('/tmp/my.app'), /not this app's builder/)

    // Slash commands: /reset first, then the harness's own; an unknown one is an error string.
    const { commands } = await get(`/sessions/${builder.id}/commands`)
    assert.equal(commands[0].name, '/reset')
    assert.ok(commands.some((command) => command.name === '/status'))
    assert.equal((await post(`/sessions/${builder.id}/command`, { line: '/nope' })).status, 400)
    const reset = await (await post(`/sessions/${builder.id}/command`, { line: '/reset' })).json()
    assert.ok(reset.session && reset.session !== builder.id)
    assert.match(reset.text, /previous one is parked/)
    assert.equal((await get(`/sessions/${builder.id}/history`)).status, 'stopped')
    assert.equal((await get(`/sessions/${reset.session}/history`)).status, 'ready')
    assert.equal((await get(`/sessions/${chat.id}/history`)).status, 'ready', 'a builder /reset leaves the chat window alone')
    assert.equal((await get('/sessions/latest')).id, reset.session)

    // The Builder switch persists in .golem and, turned off, parks the builder agent only.
    assert.deepEqual(await get('/builder'), { builder: false })
    assert.equal((await post('/builder', { builder: true })).status, 200)
    assert.deepEqual(JSON.parse(readFileSync(join(state, 'builder.json'), 'utf8')), { builder: true })
    await post('/builder', { builder: false })
    assert.equal((await get(`/sessions/${reset.session}/history`)).status, 'stopped')
    assert.equal((await get(`/sessions/${chat.id}/history`)).status, 'ready')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
