import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixtureApp } from './fixtures/app.mjs'

// A neutral field-notes app: signed-in members read everything; a note changes only for its team's group or a manager.
const serverModule = `import type { AppServerModule } from 'golem-kit/server'
export default {
  authorize: ({ operation, principal, record }) => {
    if (principal.kind !== 'user') return operation === 'records.list' || operation === 'records.get'
    if (!record || operation === 'records.list' || operation === 'records.get') return true
    return principal.roles.includes('admin') || principal.groups.includes(String(record.team))
  },
} satisfies AppServerModule
`

function app(accounts) {
  const root = fixtureApp(mkdtempSync(join(tmpdir(), 'golem-accounts-')))
  writeFileSync(join(root, 'golem.config.ts'), `export default { title: 'Field Notes', accounts: ${JSON.stringify(accounts)} }\n`)
  writeFileSync(join(root, 'src/server/index.ts'), serverModule)
  return root
}

class Worker {
  sends = []
  async start(emit) { this.emit = emit }
  send(text) { this.sends.push(text); return new Promise(() => {}) }
  async interrupt() {}
  async shutdown() {}
}

function client(base) {
  let cookie = ''
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0]
    const text = await response.text()
    return { status: response.status, body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text }
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body = {}, headers) => request('POST', path, body, headers),
    op: (name, input) => request('POST', `/api/app/operations/${name}`, input),
    get cookie() { return cookie },
  }
}

test('local accounts: sign-in, groups, roles, build access and revocation over HTTP and agent tools', { timeout: 60000 }, async () => {
  const root = app({})
  process.chdir(root)
  const logs = []
  const log = console.log
  console.log = (...args) => { logs.push(args.join(' ')); log(...args) }
  const { startDevServer } = await import('../src/dev-server.ts')
  const workers = []
  const server = await startDevServer(3241, () => { const worker = new Worker(); workers.push(worker); return worker }, join(root, '.golem'))
  console.log = log
  const base = 'http://127.0.0.1:3241'
  try {
    const invite = logs.map((line) => line.match(/Admin invite \(one use, expires in 24 hours\): (\S+)/)?.[1]).find(Boolean)
    assert.match(invite, /^http:\/\/127\.0\.0\.1:3241\/\?invite=[A-Za-z0-9_-]{43}$/)
    const token = new URL(invite).searchParams.get('invite')

    // Signed out, with guests off: no app data, no change stream, no build routes.
    const guest = client(base)
    assert.deepEqual((await guest.get('/api/auth/me')).body, { user: null, canBuild: false, accounts: { guests: false, allowSignUp: false, roles: [{ id: 'member', label: 'Member', manages: false }, { id: 'builder', label: 'Builder', manages: false }, { id: 'admin', label: 'Admin', manages: true }] } })
    assert.equal((await guest.op('records.list', { collection: 'notes' })).status, 401)
    assert.equal((await guest.get('/api/app/changes')).status, 401)
    assert.equal((await guest.get('/api/runtime')).status, 401)
    assert.equal((await guest.get('/api/sessions/latest')).status, 401)
    assert.equal((await guest.post('/api/sessions', { backend: 'codex', intent: 'build' })).status, 401)
    assert.equal((await guest.post('/api/auth/sign-up', { name: 'Walk In', email: 'walk@example.test', password: 'long enough' })).status, 403)

    const admin = client(base)
    assert.equal((await admin.post('/api/auth/sign-up', { name: 'Ada Admin', email: 'admin@example.test', password: 'correct horse', invite: token }, { origin: 'http://evil.example' })).status, 403)
    assert.equal((await admin.post('/api/auth/sign-up', { name: 'Ada Admin', email: 'Admin@Example.test', password: 'correct horse', invite: token })).body.result.roles[0], 'admin')
    assert.equal((await client(base).post('/api/auth/sign-up', { name: 'Again', email: 'again@example.test', password: 'correct horse', invite: token })).status, 400)

    const join_ = async (role, name, email) => {
      const url = (await admin.post('/api/auth/invites', { role })).body.result
      const person = client(base)
      const created = await person.post('/api/auth/sign-up', { name, email, password: 'field notes 1', invite: new URL(url).searchParams.get('invite') })
      assert.equal(created.status, 200)
      return Object.assign(person, { id: created.body.result.id })
    }
    const member = await join_('member', 'Mo Member', 'member@example.test')
    const builder = await join_('builder', 'Bea Builder', 'builder@example.test')

    // Session separation: each cookie is its own person.
    assert.equal((await member.get('/api/auth/me')).body.user.name, 'Mo Member')
    assert.equal((await builder.get('/api/auth/me')).body.canBuild, true)
    assert.equal((await member.get('/api/auth/me')).body.canBuild, false)

    // Record rules, enforced the same way for HTTP and agent tools, with groups read fresh on each call.
    const note = (await admin.op('records.create', { collection: 'notes', data: { title: 'North gate', team: 'field' } })).body.result
    assert.equal((await member.op('records.update', { collection: 'notes', id: note.id, patch: { title: 'Mine' } })).status, 403)
    assert.equal((await member.op('records.list', { collection: '_accounts' })).status, 400)
    assert.equal((await member.get('/api/auth/members')).status, 403)
    assert.equal((await member.post(`/api/auth/members/${member.id}/role`, { role: 'admin' })).status, 403)
    assert.equal((await member.post(`/api/auth/members/${member.id}/groups`, { groups: ['field'] })).status, 403)
    assert.equal((await admin.post(`/api/auth/members/${member.id}/groups`, { groups: ['field'] })).status, 200)
    assert.equal((await member.op('records.update', { collection: 'notes', id: note.id, patch: { title: 'North gate, checked' } })).status, 200)
    assert.deepEqual((await member.get('/api/auth/me')).body.user.groups, ['field'])

    // Build access is its own permission, and conversations belong to whoever started them.
    assert.equal((await member.post('/api/sessions', { backend: 'codex', intent: 'build' })).status, 403)
    assert.equal((await member.get('/api/runtime')).status, 403)
    const started = await builder.post('/api/sessions', { backend: 'codex', intent: 'build' })
    assert.equal(started.status, 201)
    const own = await admin.post('/api/sessions', { backend: 'codex', intent: 'build' })
    assert.equal(own.status, 201)
    assert.equal((await builder.get('/api/sessions/latest')).body.id, started.body.id)
    assert.equal((await admin.get('/api/sessions/latest')).body.id, own.body.id)
    assert.equal((await admin.get(`/api/sessions/${started.body.id}/history`)).status, 404)
    assert.equal((await admin.post(`/api/sessions/${started.body.id}`, { text: 'x', clientMessageId: 'a' })).status, 404)
    assert.equal((await builder.get(`/api/sessions/${started.body.id}/history`)).status, 200)

    // Losing build access stops a running build turn at once.
    assert.equal((await builder.post(`/api/sessions/${started.body.id}`, { text: 'Add a status field', clientMessageId: 'turn-1' })).status, 202)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(workers[0].sends, ['Add a status field'])
    assert.equal((await admin.post(`/api/auth/members/${builder.id}/role`, { role: 'member' })).status, 200)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal((await builder.get(`/api/sessions/${started.body.id}/history`)).status, 403)
    assert.equal((await admin.post(`/api/auth/members/${builder.id}/role`, { role: 'builder' })).status, 200)
    const history = (await builder.get(`/api/sessions/${started.body.id}/history`)).body
    assert.equal(history.status, 'interrupted')

    // Keep a manager; sign-out ends the cookie session.
    assert.equal((await admin.post(`/api/auth/members/${(await admin.get('/api/auth/me')).body.user.id}/role`, { role: 'member' })).status, 422)
    const stale = member.cookie
    assert.equal((await member.post('/api/auth/sign-out')).status, 200)
    assert.equal(member.cookie, '')
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: stale } }).then((response) => response.json())).user, null)

    // Brute force: five misses lock the address, even for the right password afterwards.
    const attacker = client(base)
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await attacker.post('/api/auth/sign-in', { email: 'member@example.test', password: `wrong ${attempt}` })).status, 400)
    assert.equal((await attacker.post('/api/auth/sign-in', { email: 'member@example.test', password: 'field notes 1' })).status, 429)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('agent tools and jobs re-resolve the principal: sign-out and removal take effect, never as anonymous', { timeout: 60000 }, async () => {
  const root = app({ guests: true })
  const { createAppBackend } = await import('../src/backend/http.ts')
  const backend = await createAppBackend(root, join(root, '.golem/data'))
  const { accounts, app: served } = backend
  try {
    const url = await accounts.managerInvite('http://127.0.0.1:3000', false)
    assert.equal(await accounts.managerInvite('http://127.0.0.1:3000', false) !== undefined, true, 'still no account, so still offered')
    const admin = await accounts.signUp({ name: 'Ada Admin', email: 'admin@example.test', password: 'correct horse', invite: new URL(url).searchParams.get('invite') })
    assert.equal(await accounts.managerInvite('http://127.0.0.1:3000', false), undefined, 'an existing account is never re-offered automatically')
    assert.match(await accounts.managerInvite('http://127.0.0.1:3000', true), /invite=/, 'explicit operator recovery')
    const invite = await accounts.invite(await accounts.fromToken(admin.token), { role: 'member' }, 'http://127.0.0.1:3000')
    const member = await accounts.signUp({ name: 'Mo Member', email: 'member@example.test', password: 'field notes 1', invite: new URL(invite).searchParams.get('invite') })
    const principal = await accounts.fromToken(member.token)
    assert.equal(principal.kind, 'user')
    assert.ok(principal.session)

    const note = await served.invoke('records.create', { collection: 'notes', data: { title: 'Pump house', team: 'field' } }, { kind: 'anonymous' }, 'server').catch((error) => error)
    assert.equal(note.name, 'ForbiddenError', 'guests reach authorize as anonymous; this app refuses anonymous writes')
    const tools = Object.fromEntries(served.agentTools(principal).map((tool) => [tool.name, tool]))
    const created = await tools['records.create'].call({ collection: 'notes', data: { title: 'Pump house', team: 'field' } })
    await assert.rejects(tools['records.update'].call({ collection: 'notes', id: created.id, patch: { title: 'x' } }), { name: 'ForbiddenError' })
    await accounts.setGroups(await accounts.fromToken(admin.token), member.user.id, { groups: ['field'] })
    assert.equal((await tools['records.update'].call({ collection: 'notes', id: created.id, patch: { title: 'Pump house, checked' } })).version, 2)

    // A job acts for the account, not a browser session: current groups, independent of sign-out.
    await accounts.signOut(principal)
    await assert.rejects(tools['records.list'].call({ collection: 'notes' }), { name: 'UnauthorizedError' })
    await assert.rejects(served.refresh(principal), { name: 'UnauthorizedError' })
    const job = await served.resolveAccount(member.user.id)
    assert.deepEqual([job.kind, job.session, job.groups], ['user', undefined, ['field']])
    const jobTools = Object.fromEntries(served.agentTools(job).map((tool) => [tool.name, tool]))
    assert.equal((await jobTools['records.update'].call({ collection: 'notes', id: created.id, patch: { title: 'By job' } })).version, 3)
    await accounts.setGroups(await accounts.fromToken(admin.token), member.user.id, { groups: [] })
    await assert.rejects(jobTools['records.update'].call({ collection: 'notes', id: created.id, patch: { title: 'Stale' } }), { name: 'ForbiddenError' })
    await accounts.remove(await accounts.fromToken(admin.token), member.user.id)
    await assert.rejects(served.resolveAccount(member.user.id), { name: 'ForbiddenError' })
    await assert.rejects(jobTools['records.list'].call({ collection: 'notes' }), { name: 'ForbiddenError' })
  } finally {
    await backend.close()
  }
})

test('accounts and origin config are validated, and absent accounts keep the anonymous app', async () => {
  const { loadAppConfig } = await import('../src/config.ts')
  // A fresh directory per case: import() caches golem.config.ts by URL.
  const load = (source) => {
    const root = mkdtempSync(join(tmpdir(), 'golem-accounts-config-'))
    writeFileSync(join(root, 'golem.config.ts'), `${source}\n`)
    return loadAppConfig(root)
  }
  assert.equal((await load(`export default { title: 'A' }`)).accounts, undefined)
  for (const [source, message] of [
    [`export default { accounts: { roles: [{ id: 'member', label: 'Member' }] } }`, /manages: true/],
    [`export default { accounts: { guest: true } }`, /unknown fields: guest/],
    [`export default { origin: 'https://notes.example.test/' }`, /exact origin/],
  ]) {
    await assert.rejects(load(source), message)
  }
})
