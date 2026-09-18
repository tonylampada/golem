import { Cron } from 'croner'
import {
  anonymous, defineOperation, ForbiddenError, InvalidError, NotFoundError, RecordRefusedError, z,
  type JobContext, type Operation, type Principal, type RecordStore, type Row,
} from '../operations.ts'

/** Reserved collections: the records operations refuse `_` names, so run state never leaks through them. */
export const SCHEDULES = '_job_schedules'
export const RUNS = '_job_runs'
// ponytail: finished runs are kept forever; prune per job when a long-lived schedule makes the list heavy.
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
}

type Deps = {
  store: RecordStore
  definitions(): JobDefinition[]
  hasAccounts: boolean
  resolveAccount(id: string): Promise<Principal>
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

  async function all(collection: string, filter?: Record<string, string | null>): Promise<Row[]> {
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

  /** Runs are owned by the account that started them; nobody reads or acts on someone else's. */
  function owned(row: Row | null, principal: Principal): Row {
    const owner = principal.kind === 'user' ? principal.id : null
    if (!row || (row.accountId ?? null) !== owner) throw new NotFoundError('No such job run or schedule')
    return row
  }

  function actor(definition: JobDefinition, principal: Principal): string | null {
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
      const principal = run.accountId ? await deps.resolveAccount(String(run.accountId)) : anonymous
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

  async function begin(fields: { job: string; operation: string; input: unknown; accountId: string | null; scheduleId: string | null; key?: string; retryOf?: string }): Promise<Row> {
    const id = crypto.randomUUID()
    const run = await write(store.create(RUNS, { id, ...fields, key: fields.key ?? id, status: 'running', progress: null, startedAt: now(), cancelRequested: false }))
    void execute(run)
    return run
  }

  async function tick(scheduleId: string): Promise<void> {
    timers.delete(scheduleId)
    if (closed) return
    const schedule = await store.get(SCHEDULES, scheduleId)
    if (!schedule) return
    const slot = String(schedule.nextRunAt)
    if (Date.parse(slot) > Date.now()) return arm(schedule)
    await fire(schedule, slot, new Date())
  }

  /**
   * One scheduled slot. Overlap is skipped: while a run of this schedule is still running (a
   * cancelled one included, until its operation returns), or was interrupted and nobody has retried
   * or dismissed it, the slot is recorded as skipped instead. So is a slot whose job was removed or changed.
   */
  async function fire(schedule: Row, slot: string, from: Date): Promise<void> {
    const pending = (await all(RUNS, { scheduleId: schedule.id })).some((run) => run.status === 'running' || (run.status === 'interrupted' && !run.resolution))
    let problem: string | null = null
    try { unchanged(schedule) } catch (error) { problem = (error as Error).message }
    const skip = pending || problem !== null
    const next = await store.update(SCHEDULES, schedule.id, { nextRunAt: nextAfter(schedule, from), error: problem, ...(skip ? { lastSkippedAt: slot } : { lastRunAt: slot }) })
    deps.emit()
    if (!skip) await begin({ job: String(schedule.job), operation: String(schedule.operation), input: schedule.input, accountId: (schedule.accountId as string | null) ?? null, scheduleId: schedule.id, key: `${schedule.id}-${Date.parse(slot)}` })
    arm(next)
  }

  function arm(schedule: Row): void {
    clearTimeout(timers.get(schedule.id))
    if (closed) return
    const delay = Math.min(Math.max(Date.parse(String(schedule.nextRunAt)) - Date.now(), 0), maxDelay)
    const timer = setTimeout(() => void tick(schedule.id).catch((error) => console.error(error)), delay)
    timers.set(schedule.id, timer.unref())
  }

  async function start(): Promise<void> {
    for (const run of await all(RUNS, { status: 'running' })) {
      await store.update(RUNS, run.id, { status: 'interrupted', finishedAt: now(), error: 'The server stopped while this run was in progress. Its effects may be partial; retry or dismiss it.' })
    }
    for (const schedule of await all(SCHEDULES)) {
      const slot = String(schedule.nextRunAt)
      if (Date.parse(slot) > Date.now()) { arm(schedule); continue }
      if (definition(String(schedule.job))?.missed === 'once') { await fire(schedule, slot, new Date()); continue }
      arm(await store.update(SCHEDULES, schedule.id, { nextRunAt: nextAfter(schedule, new Date()), lastMissedAt: slot }))
    }
    deps.emit()
  }

  const ready = start().catch((error) => { console.error('Jobs failed to start', error) })

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
        const mine = (await all(SCHEDULES, { accountId: owner }))
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
      async run(request, { principal }) {
        owned(await store.get(SCHEDULES, request.id), principal)
        clearTimeout(timers.get(request.id))
        timers.delete(request.id)
        await write(store.remove(SCHEDULES, request.id))
        return null
      },
    }),
    defineOperation({
      name: 'jobs.runs', description: 'Your recent job runs, newest first, with status, progress, result and error.',
      input: z.object({ job: z.string().optional(), scheduleId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
      output: z.array(row),
      async run(request, { principal, permits }) {
        await ready
        const filter: Record<string, string | null> = { accountId: principal.kind === 'user' ? principal.id : null }
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
      async run(request, { principal }) {
        const run = owned(await store.get(RUNS, request.id), principal)
        if (run.status !== 'interrupted' || run.resolution) throw new RecordRefusedError('Only an unsettled interrupted run can be retried or dismissed')
        // Re-checks who may start the job now: the retry acts as the same account with its current roles.
        if (request.action === 'retry') actor(unchanged(run), principal)
        await write(store.update(RUNS, run.id, { resolution: request.action === 'retry' ? 'retried' : 'dismissed' }))
        if (request.action === 'dismiss') return (await store.get(RUNS, run.id))!
        return begin({ job: String(run.job), operation: String(run.operation), input: run.input, accountId: (run.accountId as string | null) ?? null, scheduleId: (run.scheduleId as string | null) ?? null, key: String(run.key), retryOf: run.id })
      },
    }),
  ]

  return {
    operations,
    /** Resolves once interrupted runs are marked and schedules armed. */
    ready,
    /** Stops the timers; runs still in flight are marked interrupted at the next start. */
    close() {
      closed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
