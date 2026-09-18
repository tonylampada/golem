import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fixtureApp } from './fixtures/app.mjs'

const port = 3241
const base = `http://127.0.0.1:${port}`

// The fake agent turn edits a file imported by src/server/index.ts, then the dev server's own rebuild runs.
const runner = (root) => `
import { readFileSync, writeFileSync } from 'node:fs'
import { startDevServer } from ${JSON.stringify(resolve(import.meta.dirname, '../src/dev-server.ts'))}
const edits = ${JSON.stringify([
  ["message: 'Archived.'", "message: 'Moved to archive.'"],
  ["export const archive", "throw new Error('broken server module')\nexport const archive"],
])}
const file = ${JSON.stringify(join(root, 'src/server/notes.ts'))}
class EditingBackend {
  async start(emit) { this.emit = emit }
  async send(text) {
    const [from, to] = edits.shift()
    writeFileSync(file, readFileSync(file, 'utf8').replace(from, to))
    this.emit({ type: 'message', text: 'edited' })
  }
  async shutdown() {}
}
await startDevServer(${port}, () => new EditingBackend(), ${JSON.stringify(join(root, '.golem'))})
console.log('listening')
`

async function call(name, input) {
  const response = await fetch(`${base}/api/app/operations/${name}`, { method: 'POST', body: JSON.stringify(input) })
  return (await response.json()).result
}

async function turn(session, id, predicate) {
  await fetch(`${base}/api/sessions/${session}`, { method: 'POST', body: JSON.stringify({ text: 'change archive', clientMessageId: id }) })
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    const { events } = await (await fetch(`${base}/api/sessions/${session}/history`)).json()
    if (predicate(events)) return events
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('timed out waiting for the turn to finish')
}

test('a build-mode turn reloads app server code, including local imports, and keeps data', { timeout: 120_000 }, async () => {
  const root = fixtureApp(mkdtempSync(join(tmpdir(), 'golem-reload-')))
  writeFileSync(join(root, 'runner.mjs'), runner(root))
  const child = spawn(process.execPath, ['runner.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    await new Promise((done, fail) => { child.stdout.on('data', (chunk) => String(chunk).includes('listening') && done()); child.once('exit', fail) })
    const before = await call('records.create', { collection: 'notes', data: { title: 'Before' } })
    assert.equal((await call('notes.archive', { id: before.id })).message, 'Archived.')

    const session = (await (await fetch(`${base}/api/sessions`, { method: 'POST', body: JSON.stringify({ backend: 'codex', intent: 'build' }) })).json()).id
    await turn(session, 'one', (events) => events.some((event) => event.type === 'rebuilt'))
    const after = await call('records.create', { collection: 'notes', data: { title: 'After' } })
    assert.equal((await call('notes.archive', { id: after.id })).message, 'Moved to archive.')
    assert.equal((await call('records.get', { collection: 'notes', id: before.id })).archived, true)
    assert.doesNotMatch(readFileSync(join(root, '.golem/server/index.mjs'), 'utf8'), /function createApp|DatabaseSync/)

    const events = await turn(session, 'two', (events) => events.some((event) => event.type === 'error'))
    assert.match(events.findLast((event) => event.type === 'error').text, /broken server module/)
    assert.equal(events.filter((event) => event.type === 'rebuilt').length, 1)
    const third = await call('records.create', { collection: 'notes', data: { title: 'Third' } })
    assert.equal((await call('notes.archive', { id: third.id })).message, 'Moved to archive.')
  } finally {
    child.kill()
  }
})
