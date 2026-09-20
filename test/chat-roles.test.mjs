import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixtureApp } from './fixtures/app.mjs'

// An app with three roles where only two of them may chat: `chat.roles` is the app's rule and the
// server is where it holds, so a role that may not chat gets no conversation by any route.
const roles = [
  { id: 'field', label: 'Field' },
  { id: 'auditor', label: 'Auditor' },
  { id: 'admin', label: 'Admin', manages: true },
]

function client(base) {
  let cookie = ''
  const request = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0]
    const text = await response.text()
    return { status: response.status, body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text }
  }
  return { get: (path) => request('GET', path), post: (path, body = {}) => request('POST', path, body) }
}

test('chat.roles: the roles the app names may chat, the others get 403 on every chat route', { timeout: 60000 }, async () => {
  const root = fixtureApp(mkdtempSync(join(tmpdir(), 'golem-chat-roles-')))
  writeFileSync(join(root, 'golem.config.ts'), `export default { title: 'Field Notes', accounts: { guests: false, allowSignUp: false, roles: ${JSON.stringify(roles)} }, chat: { provider: 'tmux', agent: 'claude', roles: ['field', 'admin'] } }\n`)
  process.chdir(root)
  const logs = []
  const log = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  const { startDevServer } = await import('../src/dev-server.ts')
  const worker = () => ({ start: async () => {}, send: async () => new Promise(() => {}), interrupt: async () => {}, shutdown: async () => {} })
  const server = await startDevServer(3243, worker, join(root, '.golem'))
  console.log = log
  const base = 'http://127.0.0.1:3243'
  try {
    const invite = new URL(logs.map((line) => line.match(/Admin invite \(one use, expires in 24 hours\): (\S+)/)?.[1]).find(Boolean)).searchParams.get('invite')
    const admin = client(base)
    assert.equal((await admin.post('/api/auth/sign-up', { name: 'Ada Admin', email: 'admin@example.test', password: 'correct horse', invite })).status, 200)
    const join_ = async (role, name, email) => {
      const url = (await admin.post('/api/auth/invites', { role })).body.result
      const person = client(base)
      const created = await person.post('/api/auth/sign-up', { name, email, password: 'field notes 1', invite: new URL(url).searchParams.get('invite') })
      assert.equal(created.status, 200)
      return person
    }
    const fieldhand = await join_('field', 'Fay Fieldhand', 'field@example.test')
    const auditor = await join_('auditor', 'Ari Auditor', 'auditor@example.test')

    // Field: the app's chat, and nothing of the builder's.
    assert.deepEqual((await fieldhand.get('/api/chat')).body, { provider: 'tmux', agent: 'claude', available: true, views: false })
    const chat = await fieldhand.post('/api/sessions', { backend: 'claude', intent: 'chat' })
    assert.equal(chat.status, 201)
    assert.equal((await fieldhand.get('/api/sessions/latest?chat=1')).body.id, chat.body.id)
    assert.equal((await fieldhand.get(`/api/sessions/${chat.body.id}/commands`)).status, 200)
    assert.equal((await fieldhand.post('/api/builder', { builder: true })).status, 403)
    assert.equal((await fieldhand.post('/api/sessions', { backend: 'claude', intent: 'build' })).status, 403)
    assert.equal((await fieldhand.get('/api/builder')).body.builder, false)
    // Chat needs to know which agents this computer has, so the discovery route serves both modes.
    assert.equal((await fieldhand.get('/api/runtime')).status, 200)

    // Auditor: no chat column to show, and no way to start or reach one.
    assert.deepEqual((await auditor.get('/api/chat')).body, { provider: null, available: false })
    assert.equal((await auditor.post('/api/sessions', { backend: 'claude', intent: 'chat' })).status, 403)
    assert.equal((await auditor.post('/api/sessions', { backend: 'claude', intent: 'build' })).status, 403)
    assert.equal((await auditor.get('/api/sessions/latest?chat=1')).status, 403)
    assert.equal((await auditor.get('/api/runtime')).status, 403)
    assert.equal((await auditor.get(`/api/sessions/${chat.body.id}/commands`)).status, 403)
    assert.equal((await auditor.post(`/api/sessions/${chat.body.id}/command`, { line: '/reset' })).status, 403)
    assert.equal((await auditor.get(`/api/sessions/${chat.body.id}/pane/stream`)).status, 403)
    assert.equal((await auditor.post(`/api/sessions/${chat.body.id}/pane/input`, { key: 'Enter' })).status, 403)
    assert.equal((await auditor.post(`/api/sessions/${chat.body.id}`, { text: 'hello', clientMessageId: 'a' })).status, 403)

    // Signed out is not a role either, and neither is chatting your way into a build.
    const guest = client(base)
    assert.deepEqual((await guest.get('/api/chat')).body, { provider: null, available: false })
    assert.equal((await guest.post('/api/sessions', { backend: 'claude', intent: 'chat' })).status, 401)

    // Admin: both, because `admin` is one of the chat roles and it manages.
    assert.equal((await admin.get('/api/chat')).body.provider, 'tmux')
    assert.equal((await admin.post('/api/sessions', { backend: 'claude', intent: 'chat' })).status, 201)
    assert.equal((await admin.post('/api/builder', { builder: true })).status, 200)
    assert.equal((await admin.post('/api/sessions', { backend: 'claude', intent: 'build' })).status, 201)
  } finally {
    await server.close()
  }
})

test('chat.roles must name roles the app declares', async () => {
  const root = fixtureApp(mkdtempSync(join(tmpdir(), 'golem-chat-roles-bad-')))
  writeFileSync(join(root, 'golem.config.ts'), `export default { title: 'Field Notes', accounts: {}, chat: { provider: 'tmux', roles: ['feild'] } }\n`)
  const { loadAppConfig } = await import('../src/config.ts')
  await assert.rejects(loadAppConfig(root), /chat\.roles names roles the app does not declare: feild/)
})
