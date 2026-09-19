import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { anonymous, createApp, diskFiles, jsonlStore, sqliteStore } from '../src/backend/index.ts'
import { createAppBackend } from '../src/backend/http.ts'
import { fixtureApp } from './fixtures/app.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'golem-backend-'))
const adapters = {
  jsonl: (dir) => jsonlStore(join(dir, 'records')),
  sqlite: async (dir) => sqliteStore(join(dir, 'records.sqlite')),
}

for (const [kind, open] of Object.entries(adapters)) {
  test(`${kind} store: CRUD, query, versioned edits, validation and restart`, async () => {
    const dir = temp()
    let store = await open(dir)
    const first = await store.create('notes', { title: 'Beta', tag: 'field', rank: 2, done: false })
    const second = await store.create('notes', { title: 'alpha', tag: 'desk', rank: 1, done: true })
    await store.create('notes', { id: 'fixed-id', title: 'Gamma', tag: 'field', rank: 3, done: false })
    assert.equal(first.version, 1)
    assert.match(first.id, /^[0-9a-f-]{36}$/)
    await assert.rejects(store.create('notes', { id: 'fixed-id' }), { name: 'RecordRefusedError' })

    assert.deepEqual((await store.list('notes')).rows.map((row) => row.title), ['Beta', 'alpha', 'Gamma'])
    assert.deepEqual((await store.list('notes', { filter: { tag: 'field' } })).rows.map((row) => row.title), ['Beta', 'Gamma'])
    assert.deepEqual((await store.list('notes', { filter: { done: true } })).rows.map((row) => row.title), ['alpha'])
    assert.deepEqual((await store.list('notes', { filter: { rank: [1, 3] } })).rows.map((row) => row.title), ['alpha', 'Gamma'])
    assert.deepEqual((await store.list('notes', { search: { text: 'ALP', fields: ['title'] } })).rows.map((row) => row.title), ['alpha'])
    assert.deepEqual((await store.list('notes', { sort: { field: 'rank', direction: 'desc' } })).rows.map((row) => row.rank), [3, 2, 1])
    const page = await store.list('notes', { limit: 2 })
    assert.equal(page.rows.length, 2)
    assert.deepEqual((await store.list('notes', { limit: 2, cursor: page.nextCursor })).rows.map((row) => row.title), ['Gamma'])
    assert.equal((await store.list('notes', { limit: 2, cursor: page.nextCursor })).nextCursor, null)

    const edited = await store.update('notes', first.id, { title: 'Beta 2', version: 99, id: 'hijack' }, { expectedVersion: 1 })
    assert.equal(edited.version, 2)
    assert.equal(edited.id, first.id)
    await assert.rejects(store.update('notes', first.id, { title: 'stale' }, { expectedVersion: 1 }), (error) => error.name === 'VersionConflictError' && error.current.title === 'Beta 2')
    await assert.rejects(store.update('notes', 'missing', {}), { name: 'NotFoundError' })
    await store.remove('notes', second.id)
    assert.equal(await store.get('notes', second.id), null)
    await assert.rejects(store.remove('notes', second.id), { name: 'NotFoundError' })

    for (const bad of ['../escape', 'a/b', '', 'x'.repeat(65)]) await assert.rejects(store.list(bad), { name: 'InvalidError' })
    await assert.rejects(store.get('notes', '../../etc/passwd'), { name: 'InvalidError' })
    await assert.rejects(store.list('notes', { sort: { field: "x') OR 1=1 --", direction: 'asc' } }), { name: 'InvalidError' })

    await store.close()
    store = await open(dir)
    assert.deepEqual((await store.list('notes')).rows.map((row) => [row.title, row.version]), [['Beta 2', 2], ['Gamma', 1]])
    await store.close()
  })

  test(`${kind} store: rooted file storage survives restart and rejects traversal`, async () => {
    const dir = temp()
    let store = await open(dir)
    let files = await diskFiles(join(dir, 'files'), store)
    const ref = await files.put({ folder: 'attachments', name: 'site plan.txt', contentType: 'text/plain; charset=utf-8', bytes: Buffer.from('north gate') })
    assert.equal(ref.contentType, 'text/plain')
    await files.put({ folder: 'other', name: 'x.bin', contentType: 'bad\r\nheader', bytes: new Uint8Array([1]) })
    assert.equal((await files.caption(ref.id, 'Gate')).caption, 'Gate')
    await store.close()
    store = await open(dir)
    files = await diskFiles(join(dir, 'files'), store)
    assert.deepEqual((await files.list('attachments')).map((one) => one.name), ['site plan.txt'])
    assert.equal((await files.list('other'))[0].contentType, 'application/octet-stream')
    assert.equal(Buffer.from((await files.read(ref.id)).bytes).toString(), 'north gate')
    await assert.rejects(files.read('../records.sqlite'), { name: 'InvalidError' })
    await assert.rejects(files.list('../..'), { name: 'InvalidError' })
    await assert.rejects(files.put({ folder: 'a/../b', name: 'x', contentType: '', bytes: new Uint8Array() }), { name: 'InvalidError' })
    await assert.rejects(files.put({ folder: 'a', name: '../x', contentType: '', bytes: new Uint8Array() }), { name: 'InvalidError' })
    await files.remove(ref.id)
    await assert.rejects(files.read(ref.id), { name: 'NotFoundError' })
    await store.close()
  })
}

test('jsonl store drops a torn trailing write and keeps everything acknowledged', async () => {
  const dir = temp()
  const store = await jsonlStore(dir)
  await store.create('notes', { id: 'kept', title: 'Kept' })
  appendFileSync(join(dir, 'notes.jsonl'), '{"put":{"id":"torn"')
  const reopened = await jsonlStore(dir)
  assert.deepEqual((await reopened.list('notes')).rows.map((row) => row.id), ['kept'])
  await reopened.create('notes', { id: 'after', title: 'After' })
  assert.deepEqual((await (await jsonlStore(dir)).list('notes')).rows.map((row) => row.id), ['kept', 'after'])
  assert.ok(readFileSync(join(dir, 'notes.jsonl'), 'utf8').endsWith('\n'))
})

test('HTTP and agent tool callers share one invoke and authorize path', async () => {
  const root = temp()
  fixtureApp(root)
  const backend = await createAppBackend(root, join(root, '.golem/data'))
  const server = createServer((request, response) => void backend.handle(request, response))
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  const http = async (name, input) => {
    const response = await fetch(`${base}/api/app/operations/${name}`, { method: 'POST', body: JSON.stringify(input) })
    return { status: response.status, body: await response.json() }
  }
  const agent = Object.fromEntries(backend.app.agentTools(anonymous).map((tool) => [tool.name, tool]))
  try {
    assert.ok(agent['notes.archive'].inputSchema.properties.id)
    const open = (await http('records.create', { collection: 'notes', data: { title: 'Open' } })).body.result
    const viaAgent = await agent['records.create'].call({ collection: 'notes', data: { title: 'Locked', locked: true } })

    const archivedByHttp = await http('notes.archive', { id: open.id })
    assert.deepEqual(archivedByHttp, { status: 200, body: { result: { id: open.id, archived: true, version: 2, message: 'Archived.' } } })
    const second = await agent['records.create'].call({ collection: 'notes', data: { title: 'Second' } })
    assert.deepEqual(await agent['notes.archive'].call({ id: second.id }), { id: second.id, archived: true, version: 2, message: 'Archived.' })

    assert.deepEqual(await http('notes.archive', { id: viaAgent.id }), { status: 403, body: { error: 'Not allowed: notes.archive', name: 'ForbiddenError' } })
    await assert.rejects(agent['notes.archive'].call({ id: viaAgent.id }), { name: 'ForbiddenError', message: 'Not allowed: notes.archive' })
    await assert.rejects(agent['records.remove'].call({ collection: 'notes', id: viaAgent.id }), { name: 'ForbiddenError' })
    assert.equal((await http('records.get', { collection: 'notes', id: viaAgent.id })).body.result.title, 'Locked')

    const stale = await http('records.update', { collection: 'notes', id: open.id, patch: { title: 'late' }, expectedVersion: 1 })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.name, 'VersionConflictError')
    assert.equal(stale.body.current.version, 2)

    assert.equal((await http('records.list', { collection: '../notes' })).status, 400)
    assert.equal((await http('records.list', { collection: '_files' })).status, 400)
    assert.equal((await fetch(`${base}/api/app/files/..%2Frecords.sqlite`)).status, 400)
    assert.equal((await fetch(`${base}/api/app/files?folder=../x&name=a`, { method: 'PUT', body: 'x' })).status, 400)
    assert.equal((await fetch(`${base}/api/app/operations/records.list`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}' })).status, 403)

    const changed = []
    backend.app.changes.on('change', (collection) => changed.push(collection))
    const upload = await fetch(`${base}/api/app/files?folder=attachments&name=gate.html`, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: '<script>1</script>' })
    const ref = (await upload.json()).result
    const download = await fetch(`${base}/api/app/files/${ref.id}`)
    assert.equal(await download.text(), '<script>1</script>')
    assert.equal(download.headers.get('content-security-policy'), 'sandbox')
    assert.deepEqual((await http('files.list', { folder: 'attachments' })).body.result.map((one) => one.id), [ref.id])
    await http('files.caption', { id: ref.id, caption: 'Gate' })
    await http('files.remove', { id: ref.id })
    assert.deepEqual(changed, ['_files', '_files', '_files'])
  } finally {
    server.close()
    await backend.close()
  }
})

test('list results pass through the same authorize hook, row by row', async () => {
  const dir = temp()
  const records = await jsonlStore(dir)
  const seen = []
  const files = await diskFiles(join(dir, 'files'), records)
  const app = createApp({ records, files: () => files }, {
    authorize: (request) => { seen.push([request.operation, request.record?.title ?? null]); return request.record?.secret !== true },
  })
  await records.create('notes', { title: 'Public' })
  await records.create('notes', { title: 'Secret', secret: true })
  const page = await app.invoke('records.list', { collection: 'notes' }, anonymous, 'http')
  assert.deepEqual(page.rows.map((row) => row.title), ['Public'])
  assert.deepEqual(seen, [['records.list', null], ['records.list', 'Public'], ['records.list', 'Secret']])
})

test('a malformed server module edit keeps the last good operations and policy', async () => {
  const root = fixtureApp(mkdtempSync(join(tmpdir(), 'golem-backend-')))
  const backend = await createAppBackend(root, join(root, '.golem/data'))
  const entry = join(root, 'src/server/index.ts')
  const good = readFileSync(entry, 'utf8')
  const locked = await backend.app.invoke('records.create', { collection: 'notes', data: { title: 'Locked', locked: true } }, anonymous, 'server')
  const broken = [
    good.replace('export default {', 'export const notDefault = {'),
    `${good}\nexport const unused = 1\n`.replace('export default {', 'export default null as unknown as {'),
    good.replace('authorize: (', "authorize: 'allow' as never, _unused: ("),
    good.replace('operations: [archive, generate]', "operations: [{ name: 'notes.bad', run() {} } as never]"),
    good.replace("operation: 'notes.generate'", "operation: 'notes.missing'"),
  ]
  try {
    for (const source of broken) {
      writeFileSync(entry, source)
      await assert.rejects(backend.reload())
      await assert.rejects(backend.app.invoke('notes.archive', { id: locked.id }, anonymous, 'http'), { name: 'ForbiddenError' })
      assert.ok(backend.app.operations.some((operation) => operation.name === 'notes.archive'))
    }
  } finally {
    await backend.close()
  }
})
