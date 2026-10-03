import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { anonymous, createApp, defineOperation, ForbiddenError, sqliteStore, z } from '../src/backend/index.ts'

const temp = () => mkdtempSync(join(tmpdir(), 'golem-system-jobs-'))
const noFiles = () => ({})
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// An invented bakery: a nightly stock count that only admins (and the app itself) may run.
function bakery({ cron = '0 3 * * *', timezone = 'UTC', fail = () => false, calls = [] } = {}) {
  const count = defineOperation({
    name: 'stock.count', description: 'Count the loaves and record who counted.',
    input: z.object({ shelf: z.string() }), output: z.object({ by: z.string() }),
    async run(input, { principal, records, job }) {
      calls.push(principal)
      if (fail()) throw new Error('scale offline')
      const by = principal.kind === 'anonymous' ? 'anonymous' : principal.name
      await records.create('counts', { shelf: input.shelf, by, key: job?.key ?? null })
      return { by }
    },
  })
  const authorize = ({ operation, principal }) => operation !== 'stock.count'
    || principal.kind === 'system' || (principal.kind === 'user' && principal.roles.includes('admin'))
  return {
    operations: [count],
    jobs: [{ name: 'nightly-count', description: 'Count stock every night.', operation: 'stock.count', schedule: { cron, timezone, input: { shelf: 'rye' } } }],
    authorize,
  }
}

/** Accounts as a test double: ids → roles; `admin` manages. */
function people(entries) {
  const roles = new Map(entries)
  const user = (id) => ({ kind: 'user', id, name: id, roles: roles.get(id) ?? [], groups: [], session: 's' })
  const identity = {
    requireUser: true,
    resolve: async () => anonymous,
    refresh: async (principal) => principal,
    resolveAccount: async (id) => {
      if (!roles.has(id)) throw new ForbiddenError(`Account ${id} no longer exists`)
      return { kind: 'user', id, name: id, roles: roles.get(id), groups: [] }
    },
    manages: (principal) => principal.kind === 'user' && principal.roles.includes('admin'),
  }
  return { roles, user, identity }
}

test('a declared schedule is created once across two boots, and a changed cron updates it', async () => {
  const dir = temp()
  for (const cron of ['0 3 * * *', '0 3 * * *', '30 4 * * *']) {
    const records = await sqliteStore(join(dir, 'records.sqlite'))
    const app = createApp({ records, files: noFiles }, bakery({ cron }))
    const { schedules } = await app.invoke('jobs.admin.list', {}, anonymous, 'http')
    assert.equal(schedules.length, 1)
    assert.equal(schedules[0].cron, cron)
    assert.equal(schedules[0].owner, 'system')
    assert.equal(schedules[0].accountId, null)
    assert.equal(new Date(schedules[0].nextRunAt).getUTCHours(), cron === '30 4 * * *' ? 4 : 3)
    assert.equal((await records.list('_job_schedules')).rows.length, 1)
    // Not anyone's own schedule: user-facing lists leave it out.
    assert.equal((await app.invoke('jobs.list', {}, anonymous, 'http')).schedules.length, 0)
    app.close()
    await records.close()
  }
  // Removing the declaration removes the schedule.
  const records = await sqliteStore(join(dir, 'records.sqlite'))
  const app = createApp({ records, files: noFiles }, { ...bakery(), jobs: [{ name: 'nightly-count', description: 'x', operation: 'stock.count' }] })
  await app.invoke('jobs.list', {}, anonymous, 'http')
  assert.equal((await records.list('_job_schedules')).rows.length, 0)
  app.close()
  await records.close()
})

test('a reload with a changed declared cron updates the schedule in place', async () => {
  const records = await sqliteStore(join(temp(), 'records.sqlite'))
  const app = createApp({ records, files: noFiles }, bakery())
  const [before] = (await app.invoke('jobs.admin.list', {}, anonymous, 'http')).schedules
  app.use(bakery({ cron: '15 2 * * *' }))
  const after = await until(async () => { const row = await records.get('_job_schedules', before.id); return row.cron === '15 2 * * *' && row })
  assert.equal(new Date(after.nextRunAt).getUTCMinutes(), 15)
  assert.equal((await records.list('_job_schedules')).rows.length, 1)
  app.close()
  await records.close()
})

test('a system run calls an admin-only operation as the system, whose name marks what it wrote', async () => {
  const { identity } = people([['ana', ['admin']]])
  const records = await sqliteStore(join(temp(), 'records.sqlite'))
  const calls = []
  const app = createApp({ records, files: noFiles }, bakery({ cron: '* * * * * *', calls }), identity)
  const counted = await until(async () => (await records.list('counts')).rows[0])
  assert.equal(counted.by, 'System')
  assert.deepEqual(calls[0], { kind: 'system', id: 'system', name: 'System' })
  const [run] = await app.invoke('jobs.admin.runs', {}, { kind: 'user', id: 'ana', name: 'ana', roles: ['admin'], groups: [] }, 'http')
  assert.equal(run.system, true)
  assert.equal(run.accountId, null)
  // The same operation is refused to a member calling it directly.
  await assert.rejects(app.invoke('stock.count', { shelf: 'rye' }, { kind: 'user', id: 'ben', name: 'ben', roles: ['member'], groups: [] }, 'http'), { name: 'ForbiddenError' })
  app.close()
  await records.close()
})

test('pause, resume, run now and retry are for admins only', async () => {
  const { user, identity } = people([['ana', ['admin']], ['ben', ['member']]])
  const records = await sqliteStore(join(temp(), 'records.sqlite'))
  let failing = true
  const app = createApp({ records, files: noFiles }, bakery({ fail: () => failing }), identity)
  const [schedule] = (await app.invoke('jobs.admin.list', {}, user('ana'), 'http')).schedules

  for (const [name, input] of [
    ['jobs.admin.list', {}], ['jobs.admin.runs', {}], ['jobs.admin.pause', { id: schedule.id, paused: true }],
    ['jobs.admin.run', { id: schedule.id }], ['jobs.admin.retry', { id: 'nope' }], ['jobs.admin.remove', { id: schedule.id }],
  ]) {
    await assert.rejects(app.invoke(name, input, user('ben'), 'http'), { name: 'ForbiddenError' }, name)
  }
  // Nor can anyone reach it through their own jobs.* operations.
  await assert.rejects(app.invoke('jobs.unschedule', { id: schedule.id }, user('ben'), 'http'), { name: 'NotFoundError' })
  await assert.rejects(app.invoke('jobs.unschedule', { id: schedule.id }, user('ana'), 'http'), { name: 'NotFoundError' })

  const paused = await app.invoke('jobs.admin.pause', { id: schedule.id, paused: true }, user('ana'), 'http')
  assert.equal(paused.paused, true)
  const resumed = await app.invoke('jobs.admin.pause', { id: schedule.id, paused: false }, user('ana'), 'http')
  assert.equal(resumed.paused, false)
  assert.ok(Date.parse(resumed.nextRunAt) > Date.now())

  const run = await app.invoke('jobs.admin.run', { id: schedule.id }, user('ana'), 'http')
  assert.equal(run.startedBy, 'ana')
  const failed = await until(async () => { const row = await records.get('_job_runs', run.id); return row.status !== 'running' && row })
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /scale offline/)
  const [listed] = (await app.invoke('jobs.admin.list', {}, user('ana'), 'http')).schedules
  assert.deepEqual({ status: listed.lastRun.status, id: listed.lastRun.id }, { status: 'failed', id: run.id })
  assert.match(listed.lastRun.error, /scale offline/)

  failing = false
  const retry = await app.invoke('jobs.admin.retry', { id: run.id }, user('ana'), 'http')
  assert.equal(retry.key, run.key)
  assert.equal(retry.retryOf, run.id)
  await until(async () => (await records.get('_job_runs', retry.id)).status === 'succeeded')
  await assert.rejects(app.invoke('jobs.admin.retry', { id: run.id }, user('ana'), 'http'), { name: 'RecordRefusedError' })
  assert.deepEqual((await app.invoke('jobs.admin.runs', { scheduleId: schedule.id }, user('ana'), 'http')).map((one) => one.id), [retry.id, run.id])
  app.close()
  await records.close()
})

test('a paused system schedule skips its slots until resumed', async () => {
  const records = await sqliteStore(join(temp(), 'records.sqlite'))
  const app = createApp({ records, files: noFiles }, bakery({ cron: '* * * * * *' }))
  const [schedule] = (await app.invoke('jobs.admin.list', {}, anonymous, 'http')).schedules
  await app.invoke('jobs.admin.pause', { id: schedule.id, paused: true }, anonymous, 'http')
  const before = (await records.list('_job_runs')).rows.length
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal((await records.list('_job_runs')).rows.length, before)
  await app.invoke('jobs.admin.pause', { id: schedule.id, paused: false }, anonymous, 'http')
  await until(async () => (await records.list('_job_runs')).rows.length > before)
  app.close()
  await records.close()
})

test('a user schedule whose owner was removed is listed as such, skips instead of failing, and an admin deletes it', async () => {
  const { roles, user, identity } = people([['ana', ['admin']], ['ben', ['admin']]])
  const records = await sqliteStore(join(temp(), 'records.sqlite'))
  const module = { ...bakery(), jobs: [{ name: 'count', description: 'Count by hand.', operation: 'stock.count' }] }
  const app = createApp({ records, files: noFiles }, module, identity)
  const mine = await app.invoke('jobs.schedule', { job: 'count', input: { shelf: 'spelt' }, cron: '* * * * * *', timezone: 'UTC' }, user('ben'), 'http')
  const kept = await app.invoke('jobs.schedule', { job: 'count', input: { shelf: 'oat' }, every: 3600 }, user('ana'), 'http')
  assert.equal((await app.invoke('jobs.admin.list', {}, user('ana'), 'http')).schedules.length, 0)
  await assert.rejects(app.invoke('jobs.admin.remove', { id: kept.id }, user('ana'), 'http'), { name: 'NotFoundError' })

  roles.delete('ben')
  const skipped = await until(async () => { const row = await records.get('_job_schedules', mine.id); return row.error && row })
  assert.match(skipped.error, /Owner removed/)
  const runsAfter = (await records.list('_job_runs')).rows.filter((one) => one.scheduleId === mine.id && one.status === 'failed')
  assert.equal(runsAfter.filter((one) => /no longer exists/.test(one.error)).length <= 1, true)

  const { schedules } = await app.invoke('jobs.admin.list', {}, user('ana'), 'http')
  assert.deepEqual(schedules.map((one) => [one.id, one.owner]), [[mine.id, 'removed']])
  await app.invoke('jobs.admin.remove', { id: mine.id }, user('ana'), 'http')
  assert.equal(await records.get('_job_schedules', mine.id), null)
  // The owner's healthy schedule still works as before.
  assert.equal((await app.invoke('jobs.list', {}, user('ana'), 'http')).schedules[0].id, kept.id)
  app.close()
  await records.close()
})

test('a declared schedule must name a cron and a timezone that run', () => {
  const app = createApp({ records: { list: async () => ({ rows: [], nextCursor: null }) }, files: noFiles }, {})
  for (const schedule of [{ cron: 'soon', timezone: 'UTC' }, { cron: '0 3 * * *', timezone: 'Mars/Base' }, { cron: '0 3 * * *' }]) {
    assert.throws(() => app.use({ ...bakery(), jobs: [{ name: 'x', description: 'x', operation: 'stock.count', schedule }] }), /schedule/)
  }
  app.close()
})
