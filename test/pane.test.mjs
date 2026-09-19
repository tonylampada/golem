import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startDevServer } from '../src/dev-server.ts'
import { TmuxBackend } from '../src/runtime/tmux.ts'

const fake = createRequire(import.meta.url)('../src/runtime/harness/fake.js')

// Read SSE events off a fetch body until `count` events arrived, then abort the stream.
async function events(url, count) {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  const out = []
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString()
    for (const block of buffer.split('\n\n').slice(0, -1)) {
      const event = /^event: (.*)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]
      out.push({ event, data: JSON.parse(data) })
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2)
    if (out.length >= count) break
  }
  controller.abort()
  return out
}

test('pane routes: stream frames from the fake harness, validate input, and say unsupported cleanly', { timeout: 30000 }, async () => {
  fake.reset()
  process.env.BC_FAKE_PANE_MS = '50'
  let plain = false
  const server = await startDevServer(3240, () => plain
    ? { async start() {}, async send() {}, async shutdown() {} }
    : new TmuxBackend('/tmp', 'claude', undefined, { harness: fake, api: 'http://127.0.0.1:3240' }), mkdtempSync(join(tmpdir(), 'golem-state-')))
  try {
    const base = 'http://127.0.0.1:3240/api/sessions'
    const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const { id } = await (await post('', { backend: 'claude', intent: 'build' })).json()

    const got = await events(`${base}/${id}/pane/stream`, 2)
    assert.equal(got[0].event, 'frame')
    assert.match(got[0].data, /fake pane golem-/)
    assert.equal(got[1].event, 'frame')

    assert.equal((await post(`/${id}/pane/input`, { key: 'Enter' })).status, 200)
    assert.equal((await post(`/${id}/pane/input`, { text: 'hello' })).status, 200)
    assert.equal((await post(`/${id}/pane/input`, { key: 'C-c' })).status, 200)
    // validatePaneInput refusals are the harness's, forwarded as 502 like Bridge Commander
    assert.equal((await post(`/${id}/pane/input`, { key: 'Enter', text: 'x' })).status, 502)
    assert.equal((await post(`/${id}/pane/input`, {})).status, 502)
    assert.equal((await post(`/${id}/pane/input`, { key: '-x; rm' })).status, 502)
    assert.equal((await post(`/${id}/pane/input`, { key: 'Enter' }, { origin: 'https://example.invalid' })).status, 403)
    assert.equal((await post('/nope/pane/input', { key: 'Enter' })).status, 404)

    plain = true
    const other = await (await post('', { backend: 'codex', intent: 'build' })).json()
    assert.deepEqual((await events(`${base}/${other.id}/pane/stream`, 1))[0].event, 'unsupported')
    assert.equal((await post(`/${other.id}/pane/input`, { key: 'Enter' })).status, 501)
  } finally {
    delete process.env.BC_FAKE_PANE_MS
    await new Promise((resolve) => server.close(resolve))
  }
})
