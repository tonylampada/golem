import { createHash } from 'node:crypto'
import { Cron } from 'croner'
import {
  anonymous, defineOperation, ForbiddenError, InvalidError, NotFoundError, RecordRefusedError, system, z,
  type JobContext, type Operation, type Principal, type RecordStore, type Row,
} from '../operations.ts'

/** Reserved collections: the records operations refuse `_` names, so run state never leaks through them. */
export const SCHEDULES = '_job_schedules'
export const RUNS = '_job_runs'
// Finished runs are kept; there is no retention limit yet.
/** The only name job state puts on the change stream; readers re-list through `jobs.runs`. */
export const JOBS_CHANGE = '_jobs'

/** An app-owned job: which registered operation it runs. Callers pick the job and its input, never the operation or who it acts for. */
export type JobDefinition = {
  name: string
  description: string
  /** A registered operation; each run goes through `invoke` and `authorize` like any other call. */
  operation: string
  /** Signed-out guests may start and schedule it; its runs act as `anonymous`. Apps without accounts are always anonymous. */
  anonymous?: boolean
  /** A scheduled time that passed while the server was down: `skip` (default) waits for the next one, `once` runs one catch-up at start. */
  missed?: 'skip' | 'once'
  /**
   * A system schedule declared in code: golem keeps exactly one per job, owned by no account, and
   * its runs act as the `system` principal. Changing it here changes the stored schedule at the next
   * boot or reload; removing it removes the schedule. Admins pause, resume and run it; only code changes it.
   */
  schedule?: { cron: string; timezone: string; input?: unknown }
}

/** Throws when a declared schedule's cron or timezone cannot run. */
export function checkDeclared(job: JobDefinition): void {
  if (job.schedule === undefined) return
  const { cron, timezone } = job.schedule ?? {}
  if (typeof cron !== 'string' || typeof timezone !== 'string') throw new Error(`Job ${job.name}: schedule needs { cron, timezone }`)
  try {
    if (!new Cron(cron, { timezone, paused: true }).nextRun()) throw new Error('it never runs again')
  } catch (error) {
    throw new Error(`Job ${job.name}: invalid schedule: ${(error as Error).message}`)
  }
}

/** One stable record id per declared job, so two boots — or two racing ones — keep one schedule. */
export const systemScheduleId = (job: string) => `system-${createHash('sha256').update(job).digest('hex').slice(0, 32)}`

type Deps = {
  store: RecordStore
  definitions(): JobDefinition[]
  hasAccounts: boolean
  resolveAccount(id: string): Promise<Principal>
  /** Holds the role that manages accounts: may see and manage system schedules and orphans. */
  manages(principal: Principal): boolean
  invoke(name: string, input: unknown, principal: Principal, job: JobContext): Promise<unknown>
  emit(): void
}

const maxDelay = 2 ** 31 - 1
const now = () => new Date().toISOString()

/**
 * Durable server-side runs of app operations, started by hand or by an interval/cron schedule.
 * A run outlives the request that started it; one found still running at start was cut off by a
 * stop, so it becomes `interrupted` and waits for someone to retry or dismiss it — never replayed.
 */
export function createJobs(deps: Deps) {
  const { store } = deps
  const definition = (name: string) => deps.definitions().find((one) => one.name === name)
  const active = new Map<string, AbortController>()
  const timers = new Map<string, NodeJS.Timeout>()
  let closed = false
  // Claims (a slot firing, a retry, an unschedule) read and write run state in one step, one at a time,
  // so two callers never both see a run as unclaimed. Operations themselves run outside this queue.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(step: () => Promise<T>): Promise<T> => {
    const result = queue.then(step)
    queue = result.catch(() => {})
    return result
  }

  async function all(collection: string, filter?: Record<string, string | boolean | null>): Promise<Row[]> {
    const rows: Row[] = []
    let cursor: string | null = null
    do {
      const page: Awaited<ReturnType<RecordStore['list']>> = await store.list(collection, { filter, cursor, limit: 500 })
      rows.push(...page.rows)
      cursor = page.nextCursor
    } while (cursor)
    return rows
  }
  const write = async <T>(result: Promise<T>) => { const value = await result; deps.emit(); return value }

  function nextAfter(schedule: Record<string, unknown>, from: Date): string {
    if (typeof schedule.every === 'number') return new Date(from.getTime() + (schedule.every as number) * 1000).toISOString()
    const next = new Cron(String(schedule.cron), { timezone: String(schedule.timezone), paused: true }).nextRun(from)
    if (!next) throw new InvalidError('This cron expression never runs again')
    return next.toISOString()
  }

  function job(name: string): JobDefinition {
    const found = definition(name)
    if (!found) throw new NotFoundError(`Unknown job: ${name}`)
    return found
  }

  /** The job as it was when the run or schedule was made: a removed job, or one now pointing at another operation, never runs. */
  function unchanged(row: Row): JobDefinition {
    const found = job(String(row.job))
    if (found.operation !== row.operation) throw new RecordRefusedError(`Job ${found.name} now runs ${found.operation}, not ${String(row.operation)}; schedule it again`)
    return found
  }

  /** Runs are owned by the account that started them; nobody reads or acts on someone else's. System ones belong to admins. */
  function owned(row: Row | null, principal: Principal): Row {
    const owner = principal.kind === 'user' ? principal.id : null
    if (!row || row.system || (row.accountId ?? null) !== owner) throw new NotFoundError('No such job run or schedule')
    return row
  }

  function actor(definition: JobDefinition, principal: Principal): string | null {
    if (principal.kind === 'system') throw new ForbiddenError('System runs come only from schedules declared in code')
    if (principal.kind === 'user') {
      if (!deps.hasAccounts) throw new ForbiddenError('Jobs that act for a person need local accounts')
      return principal.id
    }
    if (deps.hasAccounts && !definition.anonymous) throw new ForbiddenError(`Sign in to run ${definition.name}`)
    return null
  }

  async function execute(run: Row): Promise<void> {
    const controller = new AbortController()
    active.set(run.id, controller)
    const context: JobContext = {
      runId: run.id,
      key: String(run.key),
      signal: controller.signal,
      progress: async (progress) => { await write(store.update(RUNS, run.id, { progress })) },
    }
    let patch: Record<string, unknown>
    try {
      const definition = unchanged(run)
      // Current roles and groups on every run: a removed account or a lost role stops its jobs.
      const principal = run.system ? system : run.accountId ? await deps.resolveAccount(String(run.accountId)) : anonymous
      const result = await deps.invoke(definition.operation, run.input, principal, context)
      patch = { status: 'succeeded', result: result ?? null }
    } catch (error) {
      const failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      patch = { status: controller.signal.aborted ? 'cancelled' : 'failed', error: failure }
    } finally {
      active.delete(run.id)
    }
    if (!closed) await write(store.update(RUNS, run.id, { ...patch, finishedAt: now() })).catch((error) => console.error(error))
  }

  async function begin(fields: { job: string; operation: string; input: unknown; accountId: string | null; scheduleId: string | null; key?: string; retryOf?: string; system?: boolean; startedBy?: string }): Promise<Row> {
    const id = crypto.randomUUID()
    const { system: isSystem, ...rest } = fields
    const run = await write(store.create(RUNS, { id, ...rest, ...(isSystem ? { system: true } : {}), key: fields.key ?? id, status: 'running', progress: null, startedAt: now(), cancelRequested: false }))
    void execute(run)
    return run
  }

  const tick = (scheduleId: string) => serial(async () => {
    timers.delete(scheduleId)
    if (closed) return
    const schedule = await store.get(SCHEDULES, scheduleId)
    if (!schedule || schedule.paused) return
    const slot = String(schedule.nextRunAt)
    if (Date.parse(slot) > Date.now()) return arm(schedule)
    await fire(schedule, slot, new Date())
  })

  /**
   * One scheduled slot. Overlap is skipped: while a run of this schedule is still running (a
   * cancelled one included, until its operation returns), or was interrupted and nobody has retried
   * or dismissed it, the slot is recorded as skipped instead. So is a slot whose job was removed or changed.
   */
  async function fire(schedule: Row, slot: string, from: Date): Promise<void> {
    const pending = await busy(schedule.id)
    let problem: string | null = null
    try { unchanged(schedule) } catch (error) { problem = (error as Error).message }
    // A schedule whose owner was removed skips with that reason instead of failing a run every slot; an admin deletes it.
    if (!problem && schedule.accountId && !(await accountExists(String(schedule.accountId)))) problem = `Owner removed: account ${String(schedule.accountId)} no longer exists`
    const skip = pending || problem !== null
    const next = await store.update(SCHEDULES, schedule.id, { nextRunAt: nextAfter(schedule, from), error: problem, ...(skip ? { lastSkippedAt: slot } : { lastRunAt: slot }) })
    deps.emit()
    if (!skip) await begin({ ...origin(schedule), scheduleId: schedule.id, key: `${schedule.id}-${Date.parse(slot)}` })
    arm(next)
  }

  /** What a run of this schedule (or a retry of this run) acts as and does. */
  const origin = (row: Row) => ({ job: String(row.job), operation: String(row.operation), input: row.input, accountId: (row.accountId as string | null) ?? null, system: row.system === true })

  /** A run of this schedule is still running, or was interrupted and nobody settled it. */
  const busy = async (scheduleId: string) => (await all(RUNS, { scheduleId })).some((run) => run.status === 'running' || (run.status === 'interrupted' && !run.resolution))

  async function accountExists(id: string): Promise<boolean> {
    try { await deps.resolveAccount(id); return true } catch (error) {
      if (error instanceof ForbiddenError) return false
      throw error
    }
  }

  function arm(schedule: Row): void {
    clearTimeout(timers.get(schedule.id))
    timers.delete(schedule.id)
    if (closed || schedule.paused) return
    const delay = Math.min(Math.max(Date.parse(String(schedule.nextRunAt)) - Date.now(), 0), maxDelay)
    const timer = setTimeout(() => void tick(schedule.id).catch((error) => console.error(error)), delay)
    timers.set(schedule.id, timer.unref())
  }

  /**
   * Makes the stored system schedules match the declared ones: creates a missing one, updates one
   * whose cron, timezone, operation or input changed in code (keeping its paused state), and removes
   * one whose job no longer declares a schedule. Returns the schedules it created or changed.
   */
  async function syncDeclared(from: Date): Promise<Row[]> {
    const declared = new Map(deps.definitions().filter((one) => one.schedule).map((one) => [systemScheduleId(one.name), one]))
    for (const stale of await all(SCHEDULES, { system: true })) {
      if (declared.has(stale.id)) continue
      clearTimeout(timers.get(stale.id))
      timers.delete(stale.id)
      await store.remove(SCHEDULES, stale.id)
    }
    const touched: Row[] = []
    for (const [id, one] of declared) {
      const { cron, timezone, input = {} } = one.schedule!
      const wanted = { job: one.name, operation: one.operation, input, cron, timezone }
      const stored = await store.get(SCHEDULES, id)
      if (!stored) {
        touched.push(await store.create(SCHEDULES, { id, system: true, accountId: null, ...wanted, paused: false, nextRunAt: nextAfter(wanted, from) }))
      } else if ((Object.keys(wanted) as Array<keyof typeof wanted>).some((key) => JSON.stringify(stored[key] ?? null) !== JSON.stringify(wanted[key] ?? null))) {
        touched.push(await store.update(SCHEDULES, id, { ...wanted, nextRunAt: nextAfter(wanted, from), error: null }))
      }
    }
    return touched
  }

  async function start(): Promise<void> {
    for (const run of await all(RUNS, { status: 'running' })) {
      await store.update(RUNS, run.id, { status: 'interrupted', finishedAt: now(), error: 'The server stopped while this run was in progress. Its effects may be partial; retry or dismiss it.' })
    }
    await syncDeclared(new Date())
    for (const schedule of await all(SCHEDULES)) {
      if (schedule.paused) continue
      const slot = String(schedule.nextRunAt)
      if (Date.parse(slot) > Date.now()) { arm(schedule); continue }
      if (definition(String(schedule.job))?.missed === 'once') { await serial(() => fire(schedule, slot, new Date())); continue }
      arm(await store.update(SCHEDULES, schedule.id, { nextRunAt: nextAfter(schedule, new Date()), lastMissedAt: slot }))
    }
    deps.emit()
  }

  const ready = start().catch((error) => { console.error('Jobs failed to start', error) })

  function admin(principal: Principal): void {
    if (!deps.manages(principal)) throw new ForbiddenError('Only an admin can manage system jobs')
  }
  async function systemSchedule(scheduleId: string): Promise<Row> {
    const found = await store.get(SCHEDULES, scheduleId)
    if (!found?.system) throw new NotFoundError('No such system schedule')
    return found
  }
  const actorName = (principal: Principal) => principal.kind === 'anonymous' ? 'anonymous' : principal.name

  const runRecord = (input: { id: string }) => ({ collection: RUNS, id: input.id })
  const scheduleRecord = (input: { id: string }) => ({ collection: SCHEDULES, id: input.id })
  const row = z.looseObject({ id: z.string(), version: z.number() })
  const id = z.string().min(1)
  const input = z.unknown().optional()

  // Management goes through `invoke`, so the app's `authorize` sees each call (and the run or schedule as `record`).
  const operations: Operation[] = [
    defineOperation({
      name: 'jobs.list', description: 'List the app jobs and your schedules.',
      input: z.object({}), output: z.object({ jobs: z.array(z.object({ name: z.string(), description: z.string() })), schedules: z.array(row) }),
      async run(_, { principal, permits }) {
        await ready
        const owner = principal.kind === 'user' ? principal.id : null
        const mine = (await all(SCHEDULES, { accountId: owner, system: null }))
        const visible = await Promise.all(mine.map(permits))
        return { jobs: deps.definitions().map(({ name, description }) => ({ name, description })), schedules: mine.filter((_, index) => visible[index]) }
      },
    }),
    defineOperation({
      name: 'jobs.start', description: 'Start one run of a job now. It keeps running if the browser goes away.',
      input: z.object({ job: z.string(), input }), output: row,
      async run(request, { principal }) {
        await ready
        const definition = job(request.job)
        return begin({ job: definition.name, operation: definition.operation, input: request.input ?? {}, accountId: actor(definition, principal), scheduleId: null })
      },
    }),
    defineOperation({
      name: 'jobs.schedule', description: 'Run a job every N seconds, or on a cron expression in an explicit IANA timezone.',
      input: z.union([
        z.object({ job: z.string(), input, every: z.number().int().min(10) }),
        z.object({ job: z.string(), input, cron: z.string().max(120), timezone: z.string().max(64) }),
      ]),
      output: row,
      async run(request, { principal }) {
        await ready
        const definition = job(request.job)
        const timing = 'every' in request ? { every: request.every } : { cron: request.cron, timezone: request.timezone }
        let nextRunAt: string
        try { nextRunAt = nextAfter(timing, new Date()) } catch (error) { throw new InvalidError(`Invalid schedule: ${(error as Error).message}`) }
        const schedule = await write(store.create(SCHEDULES, { job: definition.name, operation: definition.operation, input: request.input ?? {}, accountId: actor(definition, principal), ...timing, nextRunAt }))
        arm(schedule)
        return schedule
      },
    }),
    defineOperation({
      name: 'jobs.unschedule', description: 'Stop a schedule. Runs it already started are unaffected.',
      input: z.object({ id }), output: z.null(), record: scheduleRecord,
      run: (request, { principal }) => serial(async () => {
        owned(await store.get(SCHEDULES, request.id), principal)
        clearTimeout(timers.get(request.id))
        timers.delete(request.id)
        await write(store.remove(SCHEDULES, request.id))
        return null
      }),
    }),
    defineOperation({
      name: 'jobs.runs', description: 'Your recent job runs, newest first, with status, progress, result and error.',
      input: z.object({ job: z.string().optional(), scheduleId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
      output: z.array(row),
      async run(request, { principal, permits }) {
        await ready
        const filter: Record<string, string | null> = { accountId: principal.kind === 'user' ? principal.id : null, system: null }
        if (request.job) filter.job = request.job
        if (request.scheduleId) filter.scheduleId = request.scheduleId
        const page = await store.list(RUNS, { filter, sort: { field: 'startedAt', direction: 'desc' }, limit: request.limit ?? 50 })
        const visible = await Promise.all(page.rows.map(permits))
        return page.rows.filter((_, index) => visible[index])
      },
    }),
    defineOperation({
      name: 'jobs.cancel', description: 'Ask a running job to stop. The operation stops at its next check; work it already did stays done.',
      input: z.object({ id }), output: row, record: runRecord,
      async run(request, { principal }) {
        const run = owned(await store.get(RUNS, request.id), principal)
        const controller = active.get(run.id)
        if (run.status !== 'running' || !controller) throw new RecordRefusedError('Only a running job can be cancelled')
        const updated = await write(store.update(RUNS, run.id, { cancelRequested: true }))
        controller.abort(new Error('Cancelled'))
        return updated
      },
    }),
    defineOperation({
      name: 'jobs.resolve', description: 'Settle an interrupted run: retry starts a new run with the same input and idempotency key; dismiss leaves it as is.',
      input: z.object({ id, action: z.enum(['retry', 'dismiss']) }), output: row, record: runRecord,
      run: (request, { principal }) => serial(async () => {
        const run = owned(await store.get(RUNS, request.id), principal)
        if (run.status !== 'interrupted' || run.resolution) throw new RecordRefusedError('Only an unsettled interrupted run can be retried or dismissed')
        if (request.action === 'dismiss') return write(store.update(RUNS, run.id, { resolution: 'dismissed' }))
        // Re-checks who may start the job now: the retry acts as the same account with its current roles.
        actor(unchanged(run), principal)
        // The retry exists before the old run is marked settled: a stop in between leaves both visible, never neither.
        const retry = await begin({ ...origin(run), scheduleId: (run.scheduleId as string | null) ?? null, key: String(run.key), retryOf: run.id })
        await write(store.update(RUNS, run.id, { resolution: 'retried', retryId: retry.id }))
        return retry
      }),
    }),

    // Admin: system schedules (declared in code, owned by no account) and user schedules whose owner was removed.
    defineOperation({
      name: 'jobs.admin.list', description: 'Admins: the system schedules declared in code, and user schedules whose owner was removed, each with its last run.',
      input: z.object({}), output: z.object({ schedules: z.array(row) }),
      async run(_, { principal }) {
        admin(principal)
        await ready
        const systems = await all(SCHEDULES, { system: true })
        const owned = (await all(SCHEDULES, { system: null })).filter((one) => one.accountId)
        const orphans = (await Promise.all(owned.map(async (one) => await accountExists(String(one.accountId)) ? null : one))).filter((one) => one !== null)
        const withLast = async (schedule: Row, owner: 'system' | 'removed') => {
          const [last] = (await store.list(RUNS, { filter: { scheduleId: schedule.id }, sort: { field: 'startedAt', direction: 'desc' }, limit: 1 })).rows
          const lastRun = last ? { id: last.id, status: last.status, error: last.error ?? null, startedAt: last.startedAt, finishedAt: last.finishedAt ?? null } : null
          return { ...schedule, owner, lastRun }
        }
        return { schedules: await Promise.all([...systems.map((one) => withLast(one, 'system')), ...orphans.map((one) => withLast(one, 'removed'))]) }
      },
    }),
    defineOperation({
      name: 'jobs.admin.pause', description: 'Admins: pause a system schedule (paused: true) or resume it (paused: false). Resuming waits for the next slot from now.',
      input: z.object({ id, paused: z.boolean() }), output: row, record: scheduleRecord,
      run: (request, { principal }) => serial(async () => {
        admin(principal)
        const schedule = await systemSchedule(request.id)
        const patch = request.paused ? { paused: true } : { paused: false, nextRunAt: nextAfter(schedule, new Date()) }
        const updated = await write(store.update(SCHEDULES, request.id, patch))
        arm(updated)
        return updated
      }),
    }),
    defineOperation({
      name: 'jobs.admin.run', description: 'Admins: run a system schedule\'s job now, as the system, outside its slots. Paused schedules run too.',
      input: z.object({ id }), output: row, record: scheduleRecord,
      run: (request, { principal }) => serial(async () => {
        admin(principal)
        const schedule = await systemSchedule(request.id)
        unchanged(schedule)
        if (await busy(schedule.id)) throw new RecordRefusedError('A run of this schedule is still running or waits to be settled')
        return begin({ ...origin(schedule), scheduleId: schedule.id, startedBy: actorName(principal) })
      }),
    }),
    defineOperation({
      name: 'jobs.admin.retry', description: 'Admins: retry a failed, cancelled or interrupted system run with the same input and idempotency key.',
      input: z.object({ id }), output: row, record: runRecord,
      run: (request, { principal }) => serial(async () => {
        admin(principal)
        const run = await store.get(RUNS, request.id)
        if (!run?.system) throw new NotFoundError('No such system run')
        if (!['failed', 'cancelled', 'interrupted'].includes(String(run.status)) || run.resolution) throw new RecordRefusedError('Only an unsettled failed, cancelled or interrupted run can be retried')
        unchanged(run)
        if (run.scheduleId && (await all(RUNS, { scheduleId: String(run.scheduleId), status: 'running' })).length) throw new RecordRefusedError('A run of this schedule is still running')
        const retry = await begin({ ...origin(run), scheduleId: (run.scheduleId as string | null) ?? null, key: String(run.key), retryOf: run.id, startedBy: actorName(principal) })
        await write(store.update(RUNS, run.id, { resolution: 'retried', retryId: retry.id }))
        return retry
      }),
    }),
    defineOperation({
      name: 'jobs.admin.runs', description: 'Admins: recent system runs, newest first, optionally for one job or schedule.',
      input: z.object({ job: z.string().optional(), scheduleId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
      output: z.array(row),
      async run(request, { principal }) {
        admin(principal)
        await ready
        const filter: Record<string, string | boolean> = { system: true }
        if (request.job) filter.job = request.job
        if (request.scheduleId) filter.scheduleId = request.scheduleId
        return (await store.list(RUNS, { filter, sort: { field: 'startedAt', direction: 'desc' }, limit: request.limit ?? 20 })).rows
      },
    }),
    defineOperation({
      name: 'jobs.admin.remove', description: 'Admins: delete a user schedule whose owner account was removed. System schedules change only in code.',
      input: z.object({ id }), output: z.null(), record: scheduleRecord,
      run: (request, { principal }) => serial(async () => {
        admin(principal)
        const schedule = await store.get(SCHEDULES, request.id)
        if (!schedule || schedule.system || !schedule.accountId || await accountExists(String(schedule.accountId))) throw new NotFoundError('No schedule here whose owner was removed')
        clearTimeout(timers.get(schedule.id))
        timers.delete(schedule.id)
        await write(store.remove(SCHEDULES, schedule.id))
        return null
      }),
    }),
  ]

  return {
    operations,
    /** Resolves once interrupted runs are marked and schedules armed. */
    ready,
    /** After a reload: brings the declared system schedules in line with the new module and arms what changed. */
    resync: () => serial(async () => {
      await ready
      for (const schedule of await syncDeclared(new Date())) arm(schedule)
      deps.emit()
    }),
    /**
     * Stops the timers and aborts every running operation's signal. Nothing more is recorded: those
     * runs stay `running` and become `interrupted` at the next start, whatever their operations did meanwhile.
     */
    close() {
      closed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const controller of active.values()) controller.abort(new Error('The server is stopping'))
    },
  }
}
