import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import {
  anonymous, defineOperation, ForbiddenError, InvalidError, NotFoundError, UnauthorizedError, validCollection, z,
  type Authorize, type FileStore, type JobContext, type Operation, type Principal, type RecordStore, type Row, type Via,
} from '../operations.ts'
import { FILES_COLLECTION } from './files.ts'
import { createJobs, JOBS_CHANGE, type JobDefinition } from './jobs.ts'

/** What an app's src/server/index.ts may default-export. Every field is optional. */
export type AppServerModule = {
  operations?: Operation[]
  /** Defaults to allowing everything: the local anonymous mode every existing app runs in. */
  authorize?: Authorize
  /** Trusted server-side identity for an HTTP request. Defaults to `anonymous`. */
  resolvePrincipal?: (request: IncomingMessage) => Principal | Promise<Principal>
  /** Server-side runs of these operations, started or scheduled through the `jobs.*` operations. */
  jobs?: JobDefinition[]
}

export type AgentTool = { name: string; description: string; inputSchema: unknown; call(input: unknown): Promise<unknown> }

export type App = {
  readonly operations: Operation[]
  /** Swaps in a new server module's operations and hooks; stores, change stream and callers stay. */
  use(module: AppServerModule): void
  invoke(name: string, input: unknown, principal: Principal, via: Via): Promise<unknown>
  /** Stops job timers; call before closing the store. */
  close(): void
  /**
   * The operations as tools for an in-process agent acting for `principal`. Each call first
   * refreshes the principal, so a signed-out session or a changed role takes effect at once.
   */
  agentTools(principal: Principal): AgentTool[]
  resolvePrincipal(request: IncomingMessage): Promise<Principal>
  /** Re-reads a principal from trusted state; throws once its session has ended. Identity for anonymous-only apps. */
  refresh(principal: Principal): Promise<Principal>
  /** Server-owned work acting for a stored account (a scheduled job): its current roles and groups. */
  resolveAccount(id: string): Promise<Principal>
  /** Emits `change` with a collection name after every record write, files included (`_files`). */
  changes: EventEmitter
}

const allowAll: Authorize = () => true

/** Where principals come from when the app has local accounts; replaces the module's `resolvePrincipal`. */
export type Identity = {
  /** guests: false — anonymous callers are refused on every path, HTTP, agent and server alike. */
  requireUser: boolean
  resolve(request: IncomingMessage): Promise<Principal>
  refresh(principal: Principal): Promise<Principal>
  resolveAccount(id: string): Promise<Principal>
}

export function createApp(stores: { records: RecordStore; files: (records: RecordStore) => FileStore }, module: AppServerModule = {}, identity?: Identity): App {
  const changes = new EventEmitter().setMaxListeners(0)
  const records = watched(stores.records, (collection) => changes.emit('change', collection))
  const files = stores.files(records)
  // Job state lives in reserved collections of the raw store: only the `_jobs` name reaches the change stream.
  const jobs = createJobs({
    store: stores.records,
    definitions: () => current.module.jobs ?? [],
    hasAccounts: Boolean(identity),
    resolveAccount: (id) => resolveAccount(id),
    invoke: (name, input, principal, job) => invoke(name, input, principal, 'server', job),
    emit: () => changes.emit('change', JOBS_CHANGE),
  })
  const compile = (next: AppServerModule) => compileModule(next, jobs.operations)
  let current = compile(module)

  async function resolveAccount(id: string): Promise<Principal> {
    if (!identity) throw new ForbiddenError('This app has no accounts')
    return identity.resolveAccount(id)
  }

  async function invoke(name: string, raw: unknown, principal: Principal, via: Via, job?: JobContext): Promise<unknown> {
    const { byName, authorize } = current
    if (identity?.requireUser && principal.kind === 'anonymous') throw new UnauthorizedError('Sign in to use this app.')
    const operation = byName.get(name)
    if (!operation) throw new NotFoundError(`Unknown operation: ${name}`)
    const parsed = operation.input.safeParse(raw)
    if (!parsed.success) throw new InvalidError(`${name}: ${z.prettifyError(parsed.error)}`)
    const input = parsed.data
    const target = operation.record?.(input)
    const record = target ? await records.get(target.collection, target.id) : null
    const request = { operation: name, input, principal, via }
    if (!(await authorize({ ...request, record }))) throw new ForbiddenError(`Not allowed: ${name}`)
    const permits = async (row: Row) => Boolean(await authorize({ ...request, record: row }))
    return operation.output.parse(await operation.run(input, { principal, via, records, files, permits, ...(job ? { job } : {}) }))
  }

  return {
    get operations() { return [...current.byName.values()] },
    invoke,
    changes,
    use(next) { current = compile(next) },
    close: () => jobs.close(),
    resolvePrincipal: async (request) => identity ? identity.resolve(request) : (await current.module.resolvePrincipal?.(request)) ?? anonymous,
    refresh: async (principal) => identity ? identity.refresh(principal) : principal,
    resolveAccount,
    agentTools: (principal) => [...current.byName.values()].map((operation) => ({
      name: operation.name,
      description: operation.description,
      inputSchema: z.toJSONSchema(operation.input, { unrepresentable: 'any' }),
      call: async (input: unknown) => invoke(operation.name, input, identity ? await identity.refresh(principal) : principal, 'agent'),
    })),
  }
}

/** Validates a server module into the lookup `invoke` reads; throws before anything is swapped. */
function compileModule(module: AppServerModule, jobOperations: Operation[]) {
  if (!module || typeof module !== 'object') throw new Error('src/server/index.ts must default-export an object')
  for (const hook of ['authorize', 'resolvePrincipal'] as const) {
    if (module[hook] !== undefined && typeof module[hook] !== 'function') throw new Error(`${hook} must be a function`)
  }
  for (const list of ['operations', 'jobs'] as const) {
    if (module[list] !== undefined && !Array.isArray(module[list])) throw new Error(`${list} must be an array`)
  }
  const byName = new Map<string, Operation>()
  for (const operation of [...builtins, ...jobOperations, ...(module.operations ?? [])]) {
    const schemas = [operation?.input, operation?.output].every((schema) => typeof (schema as { safeParse?: unknown })?.safeParse === 'function')
    if (typeof operation?.name !== 'string' || !operation.name || typeof operation.run !== 'function' || !schemas) {
      throw new Error(`Operation ${operation?.name ?? '(unnamed)'} needs a name, input and output schemas, and a run function`)
    }
    if (byName.has(operation.name)) throw new Error(`Operation ${operation.name} is defined twice`)
    byName.set(operation.name, operation)
  }
  const jobNames = new Set<string>()
  for (const job of module.jobs ?? []) {
    if (typeof job?.name !== 'string' || !job.name || typeof job.description !== 'string') throw new Error(`Job ${job?.name ?? '(unnamed)'} needs a name and a description`)
    if (jobNames.has(job.name)) throw new Error(`Job ${job.name} is defined twice`)
    if (!byName.has(job.operation) || job.operation.startsWith('jobs.')) throw new Error(`Job ${job.name} runs ${job.operation}, which is not an app operation`)
    if (job.missed !== undefined && job.missed !== 'skip' && job.missed !== 'once') throw new Error(`Job ${job.name}: missed must be 'skip' or 'once'`)
    jobNames.add(job.name)
  }
  return { module, byName, authorize: module.authorize ?? allowAll }
}

function watched(store: RecordStore, emit: (collection: string) => void): RecordStore {
  const after = <T>(collection: string, result: Promise<T>) => result.then((value) => { emit(collection); return value })
  return {
    native: store.native,
    list: (collection, query) => store.list(collection, query),
    get: (collection, id) => store.get(collection, id),
    create: (collection, data) => after(collection, store.create(collection, data)),
    update: (collection, id, patch, options) => after(collection, store.update(collection, id, patch, options)),
    remove: (collection, id) => after(collection, store.remove(collection, id)),
    close: () => store.close(),
  }
}

// Builtin operations: the records and files adapters, over the same invoke/authorize path as app operations.
const collection = z.string().refine((value) => !value.startsWith('_') && Boolean(validCollection(value)), 'must be a public collection name')
const id = z.string().min(1)
const bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'must be bytes')
const row = z.looseObject({ id: z.string(), version: z.number() })
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])
const query = z.object({
  filter: z.record(z.string(), z.union([scalar, z.array(scalar)])).optional(),
  sort: z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }).optional(),
  search: z.object({ text: z.string(), fields: z.array(z.string()) }).optional(),
  cursor: z.string().nullable().optional(),
  limit: z.number().int().optional(),
})
const fileRef = z.object({ id: z.string(), name: z.string(), contentType: z.string(), size: z.number(), folder: z.string(), uploadedAt: z.string(), caption: z.string().optional() })
const fileRecord = (input: { id: string }) => ({ collection: FILES_COLLECTION, id: input.id })

const builtins: Operation[] = [
  defineOperation({
    name: 'records.list', description: 'List records in a collection with optional equality filter, sort, search and paging.',
    input: z.object({ collection, query: query.optional() }), output: z.object({ rows: z.array(row), nextCursor: z.string().nullable() }),
    async run(input, { records, permits }) {
      const page = await records.list(input.collection, input.query)
      const visible = await Promise.all(page.rows.map(permits))
      // Hidden rows make a page short; nextCursor still continues correctly.
      return { rows: page.rows.filter((_, index) => visible[index]), nextCursor: page.nextCursor }
    },
  }),
  defineOperation({
    name: 'records.get', description: 'Read one record by id; null when it does not exist.',
    input: z.object({ collection, id }), output: row.nullable(), record: (input) => input,
    run: (input, { records }) => records.get(input.collection, input.id),
  }),
  defineOperation({
    name: 'records.create', description: 'Create a record. The store mints id, version, createdAt and updatedAt unless id is given.',
    input: z.object({ collection, data: z.record(z.string(), z.unknown()) }), output: row,
    run: (input, { records }) => records.create(input.collection, input.data),
  }),
  defineOperation({
    name: 'records.update', description: 'Merge a patch into a record. With expectedVersion, a record changed since it was read is refused.',
    input: z.object({ collection, id, patch: z.record(z.string(), z.unknown()), expectedVersion: z.number().int().optional(), versionField: z.string().optional() }),
    output: row, record: (input) => input,
    run: (input, { records }) => records.update(input.collection, input.id, input.patch,
      input.expectedVersion === undefined ? undefined : { expectedVersion: input.expectedVersion, versionField: input.versionField }),
  }),
  defineOperation({
    name: 'records.remove', description: 'Delete a record by id.',
    input: z.object({ collection, id }), output: z.null(), record: (input) => input,
    run: async (input, { records }) => { await records.remove(input.collection, input.id); return null },
  }),
  defineOperation({
    name: 'files.list', description: 'List stored files in a folder, newest first.',
    input: z.object({ folder: z.string() }), output: z.array(fileRef),
    async run(input, { files, records, permits }) {
      const refs = await files.list(input.folder)
      const rows = await Promise.all(refs.map((ref) => records.get(FILES_COLLECTION, ref.id)))
      const visible = await Promise.all(rows.map((one) => one ? permits(one) : false))
      return refs.filter((_, index) => visible[index])
    },
  }),
  defineOperation({
    name: 'files.upload', description: 'Store bytes in a folder and return the file reference.',
    input: z.object({ folder: z.string(), name: z.string(), contentType: z.string(), bytes: bytes }), output: fileRef,
    run: (input, { files }) => files.put(input),
  }),
  defineOperation({
    name: 'files.read', description: 'Read a stored file reference and its bytes.',
    input: z.object({ id }), output: z.object({ ref: fileRef, bytes: bytes }), record: fileRecord,
    run: (input, { files }) => files.read(input.id),
  }),
  defineOperation({
    name: 'files.caption', description: 'Write the caption on a stored file.',
    input: z.object({ id, caption: z.string().max(2000) }), output: fileRef, record: fileRecord,
    run: (input, { files }) => files.caption(input.id, input.caption),
  }),
  defineOperation({
    name: 'files.remove', description: 'Delete a stored file.',
    input: z.object({ id }), output: z.null(), record: fileRecord,
    run: async (input, { files }) => { await files.remove(input.id); return null },
  }),
]
