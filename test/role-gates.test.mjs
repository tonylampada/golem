import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAppBackend } from '../src/backend/http.ts'
import { brainVisible, visibleScreens } from '../src/browser/roles.ts'
import { fixtureApp } from './fixtures/app.mjs'

// A clinic where the therapist reads the timeline but not the brain: `brain.roles`, per-screen
// `roles` and `changes.watch` keep a role out of what the app did not give it.
const roles = [
  { id: 'family', label: 'Family' },
  { id: 'therapist', label: 'Therapist' },
  { id: 'admin', label: 'Admin', manages: true },
]

function client(base) {
  let cookie = ''
  const request = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0]
    if (response.headers.get('content-type')?.includes('event-stream')) { await response.body.cancel(); return { status: response.status } }
    const text = await response.text()
    return { status: response.status, body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text }
  }
  return { get: (path) => request('GET', path), post: (path, body = {}) => request('POST', path, body) }
}

test('brain.roles: a role outside the list gets 403 on every brain route, a listed one reads', { timeout: 60000 }, async () => {
  const root = fixtureApp(mkdtempSync(join(tmpdir(), 'golem-brain-roles-')))
  writeFileSync(join(root, 'golem.config.ts'), `export default { title: 'Clinic', accounts: { guests: false, allowSignUp: false, roles: ${JSON.stringify(roles)} }, brain: { roles: ['family', 'admin'] } }\n`)
  mkdirSync(join(root, 'brain'))
  writeFileSync(join(root, 'brain/index.md'), '# Clinic\n\nAbout the family.\n')
  process.chdir(root)
  const logs = []
  const log = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  const { startDevServer } = await import('../src/dev-server.ts')
  const worker = () => ({ start: async () => {}, send: async () => new Promise(() => {}), interrupt: async () => {}, shutdown: async () => {} })
  const server = await startDevServer(3244, worker, join(root, '.golem'))
  console.log = log
  const base = 'http://127.0.0.1:3244'
  try {
    const invite = new URL(logs.map((line) => line.match(/Admin invite \(one use, expires in 24 hours\): (\S+)/)?.[1]).find(Boolean)).searchParams.get('invite')
    const admin = client(base)
    assert.equal((await admin.post('/api/auth/sign-up', { name: 'Ada Admin', email: 'admin@example.test', password: 'correct horse', invite })).status, 200)
    const join_ = async (role, name, email) => {
      const url = (await admin.post('/api/auth/invites', { role })).body.result
      const person = client(base)
      assert.equal((await person.post('/api/auth/sign-up', { name, email, password: 'clinic notes 1', invite: new URL(url).searchParams.get('invite') })).status, 200)
      return person
    }
    const family = await join_('family', 'Fran Family', 'family@example.test')
    const therapist = await join_('therapist', 'Theo Therapist', 'therapist@example.test')
    const routes = ['/api/brain/index', '/api/brain/list', '/api/brain/read?path=index.md', '/api/brain/search?q=family', '/api/brain/events']

    for (const route of routes) assert.equal((await therapist.get(route)).status, 403, route)
    assert.deepEqual((await therapist.get('/api/brain/read?path=index.md')).body, { error: 'Your account may not read the brain.' })
    for (const route of routes) assert.equal((await family.get(route)).status, 200, route)
    assert.match((await family.get('/api/brain/read?path=index.md')).body.text, /About the family/)
    assert.equal((await admin.get('/api/brain/list')).status, 200)
    for (const route of routes) assert.equal((await client(base).get(route)).status, 401, route)
  } finally {
    await server.close()
  }
})

test('brain: true keeps the brain open to everyone signed in; brain.roles must name declared roles and needs accounts', async () => {
  const { loadAppConfig } = await import('../src/config.ts')
  // A fresh directory per case: the config module is imported, and an import is cached by path.
  const config = async (text) => {
    const root = mkdtempSync(join(tmpdir(), 'golem-brain-config-'))
    writeFileSync(join(root, 'golem.config.ts'), text)
    return loadAppConfig(root)
  }
  assert.equal((await config(`export default { title: 'Clinic', brain: true }\n`)).brain, true)
  assert.deepEqual((await config(`export default { title: 'Clinic', accounts: { roles: ${JSON.stringify(roles)} }, brain: { roles: ['family'] } }\n`)).brain, { roles: ['family'] })
  await assert.rejects(config(`export default { title: 'Clinic', accounts: { roles: ${JSON.stringify(roles)} }, brain: { roles: ['famliy'] } }\n`), /brain\.roles names roles the app does not declare: famliy/)
  await assert.rejects(config(`export default { title: 'Clinic', brain: { roles: ['family'] } }\n`), /brain\.roles needs accounts/)
  await assert.rejects(config(`export default { title: 'Clinic', brain: 'yes' }\n`), /brain must be a boolean or \{ roles \}/)
})

test('the shell lists a screen with roles only to someone holding one, and the Brain item likewise', () => {
  const screens = [{ id: 'timeline', label: 'Timeline' }, { id: 'potty', label: 'Potty', roles: ['family', 'therapist'] }, { id: 'billing', label: 'Billing', roles: ['family'] }]
  const as = (...held) => ({ user: { roles: held } })
  assert.deepEqual(visibleScreens(screens, as('therapist')).map((one) => one.id), ['timeline', 'potty'])
  assert.deepEqual(visibleScreens(screens, as('family')).map((one) => one.id), ['timeline', 'potty', 'billing'])
  assert.deepEqual(visibleScreens(screens, as()).map((one) => one.id), ['timeline'])
  // Before `me` arrives, and signed out, only the screens without roles.
  assert.deepEqual(visibleScreens(screens, undefined).map((one) => one.id), ['timeline'])
  assert.deepEqual(visibleScreens(screens, { user: null }).map((one) => one.id), ['timeline'])

  assert.equal(brainVisible(true, undefined), true)
  assert.equal(brainVisible(undefined, as('family')), false)
  assert.equal(brainVisible(false, as('family')), false)
  assert.equal(brainVisible({ roles: ['family'] }, as('family')), true)
  assert.equal(brainVisible({ roles: ['family'] }, as('therapist')), false)
  assert.equal(brainVisible({ roles: ['family'] }, undefined), false)
})

test('/api/app/changes sends only the collections the app\'s authorize lets this reader watch', async () => {
  const root = fixtureApp(mkdtempSync(join(tmpdir(), 'golem-changes-watch-')))
  writeFileSync(join(root, 'src/server/index.ts'), `export default {
  authorize: ({ operation, input }) => !(operation === 'changes.watch' && input.collection === 'sessions'),
}\n`)
  const backend = await createAppBackend(root, join(root, '.golem/data'))
  const server = createServer((request, response) => void backend.handle(request, response))
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  const abort = new AbortController()
  try {
    const stream = await fetch(`${base}/api/app/changes`, { signal: abort.signal })
    assert.equal(stream.status, 200)
    const reader = stream.body.getReader()
    const create = (collection) => fetch(`${base}/api/app/operations/records.create`, { method: 'POST', body: JSON.stringify({ collection, data: { title: collection } }) })
    await create('sessions')
    await create('notes')
    await create('sessions')
    await create('timeline')
    let text = ''
    while (!text.includes('timeline')) text += new TextDecoder().decode((await reader.read()).value)
    const sent = text.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.slice('data: '.length)).collection)
    assert.deepEqual(sent, ['notes', 'timeline'])
  } finally {
    abort.abort()
    server.close()
    await backend.close()
  }
})
