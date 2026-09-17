import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startDevServer } from '../src/dev-server.ts'

test('HTTP transport validates mutations and isolates server-owned sessions', { timeout: 30000 }, async () => {
  const server = await startDevServer(3218)
  try {
    const invalid = await fetch('http://127.0.0.1:3218/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'claude' }),
    })
    assert.equal(invalid.status, 400)
    const crossOrigin = await fetch('http://127.0.0.1:3218/api/sessions', {
      method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex' }),
    })
    assert.equal(crossOrigin.status, 403)

    const create = async () => (await (await fetch('http://127.0.0.1:3218/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex' }),
    })).json()).id
    const [one, two] = await Promise.all([create(), create()])
    assert.notEqual(one, two)
    const history = await (await fetch(`http://127.0.0.1:3218/api/sessions/${one}/history`)).json()
    assert.equal(history.backend, 'codex')
    assert.deepEqual(history.events.map((event) => event.type), ['status'])
    assert.equal((await fetch(`http://127.0.0.1:3218/api/sessions/${two}/history`)).status, 200)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
