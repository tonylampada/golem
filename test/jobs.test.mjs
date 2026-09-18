import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { anonymous, createApp, defineOperation, ForbiddenError, jsonlStore, sqliteStore, z } from '../src/backend/index.ts'

const temp = () => mkdtempSync(join(tmpdir(), 'golem-jobs-'))
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

// A harmless job: writes `count` tally records keyed by the run's idempotency key, reporting progress.
// `gate` holds it between writes so a test can cancel, stop the server, or let it finish.
function tallyModule({ gate = () => Promise.resolve(), cooperative = true, operation = 'tally.fill', authorize } = {}) {
  const fill = defineOperation({
    name: operation, description: 'Write numbered tally records.',
    input: z.object({ count: z.number().int().min(1).max(20) }), output: z.object({ written: z.number() }),
    async run(input, { records, job }) {
      let written = 0
      for (let index = 0; index < input.count; index++) {
        if (cooperative) job?.signal.throwIfAborted()
        const id = `${job?.key ?? 'direct'}-${index}`
        if (!(await records.get('tallies', id))) await records.create('tallies', { id, index })
        written++
        await job?.progress({ done: written, total: input.count })
        await gate(index)
      }
      return { written }
    },
  })
  return { operations: [fill], jobs: [{ name: 'tally', description: 'Fill tallies.', operation, missed: 'once' }], authorize }
}

for (const [kind, open] of Object.entries({ jsonl: (dir) => jsonlStore(join(dir, 'records')), sqlite: async (dir) => sqliteStore(join(dir, 'records.sqlite')) })) {
  test(`${kind}: a run reports progress and a result, stays out of records.*, and survives its caller`, async () => {
    const records = await open(temp())
    const app = createApp({ records, files: noFiles }, tallyModule())
    const run = await app.invoke('jobs.start', { job: 'tally', input: { count: 3 } }, anonymous, 'http')
    assert.equal(run.status, 'running')
    const done = await until(async () => (await app.invoke('jobs.runs', {}, anonymous, 'http')).find((one) => one.id === run.id && one.status !== 'running'))
    assert.equal(done.status, 'succeeded')
    assert.deepEqual(done.result, { written: 3 })
    assert.deepEqual(done.progress, { done: 3, total: 3 })
    assert.equal((await records.list('tallies')).rows.length, 3)
    for (const collection of ['_job_runs', '_job_schedules']) {
      await assert.rejects(app.invoke('records.list', { collection }, anonymous, 'http'), { name: 'InvalidError' })
    }
    await assert.rejects(app.invoke('jobs.start', { job: 'nope' }, anonymous, 'http'), { name: 'NotFoundError' })
    const bad = await app.invoke('jobs.start', { job: 'tally', input: { count: 99 } }, anonymous, 'http')
    assert.match((await until(async () => { const row = await records.get('_job_runs', bad.id); return row.status !== 'running' && row })).error, /^InvalidError: tally.fill/)
    app.close()
    await records.close()
  })
}

test('cancel is cooperative: the run stays running until the operation returns, and nothing is rolled back', async () => {
  const records = await jsonlStore(join(temp(), 'records'))
  for (const cooperative of [true, false]) {
    let release
    const held = new Promise((resolve) => { release = resolve })
    const app = createApp({ records, files: noFiles }, tallyModule({ cooperative, gate: (index) => index === 0 ? held : undefined }))
    const run = await app.invoke('jobs.start', { job: 'tally', input: { count: 2 } }, anonymous, 'http')
    await until(async () => (await records.get('_job_runs', run.id)).progress)
    const asked = await app.invoke('jobs.cancel', { id: run.id }, anonymous, 'http')
    assert.equal(asked.status, 'running')
    assert.equal(asked.cancelRequested, true)
    release()
    const settled = await until(async () => { const row = await records.get('_job_runs', run.id); return row.status !== 'running' && row })
    // A cooperative operation stops at its next check; one that ignores the signal finishes.
    assert.equal(settled.status, cooperative ? 'cancelled' : 'succeeded')
    assert.equal((await records.get('tallies', `${run.key}-0`)).index, 0)
    await assert.rejects(app.invoke('jobs.cancel', { id: run.id }, anonymous, 'http'), { name: 'RecordRefusedError' })
    app.close()
  }
  await records.close()
})

test('a run cut off by a stop is interrupted, pauses its schedule, and retries only on request with the same key', async () => {
  const dir = temp()
  let records = await sqliteStore(join(dir, 'records.sqlite'))
  let app = createApp({ records, files: noFiles }, tallyModule({ gate: () => new Promise(() => {}) }))
  const schedule = await app.invoke('jobs.schedule', { job: 'tally', input: { count: 2 }, cron: '* * * * * *', timezone: 'UTC' }, anonymous, 'http')
  // The first slot writes one tally (an effect) and then never finishes before the stop.
  const run = await until(async () => (await app.invoke('jobs.runs', {}, anonymous, 'http'))[0])
  await until(async () => (await records.get('tallies', `${run.key}-0`)))
  app.close()
  await records.close()

  records = await sqliteStore(join(dir, 'records.sqlite'))
  app = createApp({ records, files: noFiles }, tallyModule())
  const interrupted = await until(async () => (await app.invoke('jobs.runs', {}, anonymous, 'http')).find((one) => one.status === 'interrupted'))
  assert.equal(interrupted.id, run.id)
  assert.match(interrupted.error, /effects may be partial/)
  // Slots keep passing, but none starts while the interrupted run is unsettled.
  await until(async () => (await records.get('_job_schedules', schedule.id)).lastSkippedAt, 4000)
  assert.equal((await app.invoke('jobs.runs', {}, anonymous, 'http')).length, 1)
  assert.equal((await records.list('tallies')).rows.length, 1)

  await app.invoke('jobs.unschedule', { id: schedule.id }, anonymous, 'http')
  const retry = await app.invoke('jobs.resolve', { id: run.id, action: 'retry' }, anonymous, 'http')
  assert.equal(retry.key, run.key)
  assert.equal(retry.retryOf, run.id)
  await until(async () => (await records.get('_job_runs', retry.id)).status === 'succeeded')
  // The same key made the retry skip the tally the cut-off run already wrote.
  assert.deepEqual((await records.list('tallies')).rows.map((row) => row.id).sort(), [`${run.key}-0`, `${run.key}-1`])
  assert.equal((await records.get('_job_runs', run.id)).resolution, 'retried')
  await assert.rejects(app.invoke('jobs.resolve', { id: run.id, action: 'dismiss' }, anonymous, 'http'), { name: 'RecordRefusedError' })
  app.close()
  await records.close()
})

test('missed slots: skip waits for the next one, once runs one catch-up at start', async () => {
  for (const missed of ['skip', 'once']) {
    const dir = temp()
    let records = await jsonlStore(join(dir, 'records'))
    const module = () => ({ ...tallyModule(), jobs: [{ name: 'tally', description: 'Fill tallies.', operation: 'tally.fill', missed }] })
    let app = createApp({ records, files: noFiles }, module())
    const schedule = await app.invoke('jobs.schedule', { job: 'tally', input: { count: 1 }, every: 3600 }, anonymous, 'http')
    app.close()
    await records.update('_job_schedules', schedule.id, { nextRunAt: new Date(Date.now() - 7_200_000).toISOString() })
    await records.close()
    records = await jsonlStore(join(dir, 'records'))
    app = createApp({ records, files: noFiles }, module())
    await app.invoke('jobs.list', {}, anonymous, 'http')
    const after = await records.get('_job_schedules', schedule.id)
    assert.ok(Date.parse(after.nextRunAt) > Date.now())
    if (missed === 'skip') {
      assert.ok(after.lastMissedAt)
      assert.equal((await app.invoke('jobs.runs', {}, anonymous, 'http')).length, 0)
    } else {
      await until(async () => (await app.invoke('jobs.runs', {}, anonymous, 'http'))[0]?.status === 'succeeded')
    }
    app.close()
    await records.close()
  }
})

test('schedules need an explicit timezone and a valid expression', async () => {
  const records = await jsonlStore(join(temp(), 'records'))
  const app = createApp({ records, files: noFiles }, tallyModule())
  await assert.rejects(app.invoke('jobs.schedule', { job: 'tally', cron: '0 9 * * *' }, anonymous, 'http'), { name: 'InvalidError' })
  await assert.rejects(app.invoke('jobs.schedule', { job: 'tally', cron: '0 9 * * *', timezone: 'Mars/Base' }, anonymous, 'http'), { name: 'InvalidError' })
  await assert.rejects(app.invoke('jobs.schedule', { job: 'tally', cron: 'soon', timezone: 'UTC' }, anonymous, 'http'), { name: 'InvalidError' })
  await assert.rejects(app.invoke('jobs.schedule', { job: 'tally', every: 1 }, anonymous, 'http'), { name: 'InvalidError' })
  const daily = await app.invoke('jobs.schedule', { job: 'tally', cron: '0 9 * * *', timezone: 'America/New_York' }, anonymous, 'http')
  assert.match(new Date(daily.nextRunAt).toLocaleString('en-US', { timeZone: 'America/New_York' }), /9:00:00 AM/)
  app.close()
  await records.close()
})

test('runs act as the stored account with its current roles; others cannot see, cancel or settle them', async () => {
  const records = await jsonlStore(join(temp(), 'records'))
  const people = new Map([['ana', ['member']], ['ben', ['member']]])
  const identity = {
    requireUser: true,
    resolve: async () => anonymous,
    refresh: async (principal) => principal,
    resolveAccount: async (id) => {
      if (!people.has(id)) throw new ForbiddenError('That account no longer exists')
      return { kind: 'user', id, name: id, roles: people.get(id), groups: [] }
    },
  }
  const user = (id) => ({ kind: 'user', id, name: id, roles: people.get(id), groups: [], session: 'browser' })
  let release
  const held = new Promise((resolve) => { release = resolve })
  // Only members may fill tallies; the job re-checks that on every run, not when it was started.
  const authorize = ({ operation, principal }) => operation !== 'tally.fill' || principal.roles?.includes('member')
  const app = createApp({ records, files: noFiles }, tallyModule({ gate: () => held, authorize }), identity)
  await assert.rejects(app.invoke('jobs.start', { job: 'tally', input: { count: 1 } }, anonymous, 'server'), { name: 'UnauthorizedError' })

  const run = await app.invoke('jobs.start', { job: 'tally', input: { count: 1 } }, user('ana'), 'http')
  assert.equal(run.accountId, 'ana')
  assert.equal('roles' in run, false)
  assert.equal((await app.invoke('jobs.runs', {}, user('ben'), 'http')).length, 0)
  await assert.rejects(app.invoke('jobs.cancel', { id: run.id }, user('ben'), 'http'), { name: 'NotFoundError' })
  release()
  await until(async () => (await records.get('_job_runs', run.id)).status === 'succeeded')

  people.set('ana', ['viewer'])
  const denied = await app.invoke('jobs.start', { job: 'tally', input: { count: 1 } }, user('ana'), 'http')
  const failed = await until(async () => { const row = await records.get('_job_runs', denied.id); return row.status !== 'running' && row })
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /ForbiddenError: Not allowed: tally.fill/)

  people.delete('ana')
  const gone = await app.invoke('jobs.start', { job: 'tally', input: { count: 1 } }, user('ana'), 'http')
  assert.match((await until(async () => { const row = await records.get('_job_runs', gone.id); return row.status !== 'running' && row })).error, /no longer exists/)
  app.close()
  await records.close()
})

test('reload validates jobs before swapping; a changed job never redirects its schedule', async () => {
  const records = await jsonlStore(join(temp(), 'records'))
  const app = createApp({ records, files: noFiles }, tallyModule())
  assert.throws(() => app.use({ ...tallyModule(), jobs: [{ name: 'tally', description: 'x', operation: 'records.nope' }] }), /not an app operation/)
  assert.throws(() => app.use({ ...tallyModule(), jobs: [{ name: 'tally', description: 'x', operation: 'jobs.start' }] }), /not an app operation/)
  assert.deepEqual((await app.invoke('jobs.list', {}, anonymous, 'http')).jobs.map((job) => job.name), ['tally'])

  const schedule = await app.invoke('jobs.schedule', { job: 'tally', input: { count: 1 }, cron: '* * * * * *', timezone: 'UTC' }, anonymous, 'http')
  app.use(tallyModule({ operation: 'tally.other' }))
  const skipped = await until(async () => { const row = await records.get('_job_schedules', schedule.id); return row.error && row })
  assert.match(skipped.error, /now runs tally.other/)
  assert.equal((await app.invoke('jobs.runs', {}, anonymous, 'http')).length, 0)
  app.close()
  await records.close()
})
