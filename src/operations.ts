/**
 * The app backend contract: plain typed values, operations and the errors every layer shares.
 * Browser-safe on purpose — types, zod and error classes only, no Node or driver imports.
 */
import { z } from 'zod'
import type { FileRef, RecordPage, RecordQuery, UpdateOptions } from 'golem-ui'

export { z }
export type { FileRef, RecordPage, RecordQuery, UpdateOptions }

/** A stored record: the app's plain value plus the fields the store owns. */
export type Row = Record<string, unknown> & { id: string; version: number; createdAt: string; updatedAt: string }

/**
 * Who is asking. Resolved on the server from trusted request context, never from request input.
 * `session` is set when a signed-in browser session stands behind the call; it ends at sign-out.
 * A user principal without one comes from trusted server code acting for an account (a job).
 */
export type Principal =
  | { kind: 'anonymous' }
  | { kind: 'user'; id: string; name: string; roles: string[]; groups: string[]; session?: string }
export const anonymous: Principal = Object.freeze({ kind: 'anonymous' })

/** Which caller path reached `invoke`. */
export type Via = 'http' | 'agent' | 'server'

/**
 * One adapter contract for record storage. `native` is the backend-specific escape hatch
 * (the SQLite `DatabaseSync`, or the JSONL directory path); code that touches it is tied to that backend.
 */
export interface RecordStore {
  list(collection: string, query?: RecordQuery): Promise<RecordPage<Row>>
  get(collection: string, id: string): Promise<Row | null>
  /** Mints `id` unless `data.id` is given; a taken id is refused. */
  create(collection: string, data: Record<string, unknown>): Promise<Row>
  /** Merges `patch`; `id`, `version`, `createdAt` and `updatedAt` stay store-owned. */
  update(collection: string, id: string, patch: Record<string, unknown>, options?: UpdateOptions): Promise<Row>
  remove(collection: string, id: string): Promise<void>
  close(): Promise<void>
  readonly native: unknown
}

/** Bytes on rooted disk, metadata in the record store. */
export interface FileStore {
  put(input: { folder: string; name: string; contentType: string; bytes: Uint8Array }): Promise<FileRef>
  read(id: string): Promise<{ ref: FileRef; bytes: Uint8Array }>
  /** Newest first. */
  list(folder: string): Promise<FileRef[]>
  caption(id: string, caption: string): Promise<FileRef>
  remove(id: string): Promise<void>
}

/**
 * A model call for app server code: free text in, a value the schema accepts out. The app names
 * the shape it wants and never which model or runtime answered, so a box with an API key swaps the
 * implementation behind this and no operation changes. Throws `ModelUnavailableError` when no
 * model could answer; treat that as a state of the record, not a crash.
 */
export interface Model {
  extract<S extends z.ZodType>(request: { schema: S; text: string; instructions?: string }): Promise<z.output<S>>
}

export type OperationContext = {
  principal: Principal
  via: Via
  /** Trusted, unfiltered stores. Filter what you return with `permits`. */
  records: RecordStore
  files: FileStore
  /** Free text in, structure out. Unavailable runtimes throw `ModelUnavailableError`. */
  model: Model
  /** Asks `authorize` about this same call for one row; list-style operations drop rows it refuses. */
  permits(record: Row): Promise<boolean>
  /** Set when a job run called this operation (then `via` is `server`). */
  job?: JobContext
}

/**
 * What a job run hands its operation. Cancellation is cooperative: `signal` aborts when someone
 * cancels, and the run stays `running` until the operation returns or throws. Nothing is rolled back.
 */
export type JobContext = {
  runId: string
  /** Stable across an explicit retry of the same run, and per slot for scheduled runs; a valid record id, for idempotent writes. */
  key: string
  signal: AbortSignal
  /** Stored on the run for anyone who may see it; the browser reads it through `jobs.runs`. */
  progress(value: { done?: number; total?: number; message?: string }): Promise<void>
}

export interface Operation<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** Stable public name, e.g. `notes.archive`. */
  name: string
  /** One or two sentences for people and agent tools. */
  description: string
  input: I
  output: O
  /** The record this call acts on; `authorize` receives it as `record`. `{ row }` hands over one that is not stored (a knowledge file). */
  record?: (input: z.output<I>) => { collection: string; id: string } | { row: Row } | undefined
  run(input: z.output<I>, context: OperationContext): Promise<z.input<O>> | z.input<O>
}

export function defineOperation<I extends z.ZodType, O extends z.ZodType>(operation: Operation<I, O>): Operation<I, O> {
  return operation
}

/**
 * The one authorization hook. Called before every operation (with the target `record` when the
 * operation names one) and again per row for list results, where `false` hides the row.
 */
export type AuthorizeRequest = { operation: string; input: unknown; principal: Principal; via: Via; record: Row | null }
export type Authorize = (request: AuthorizeRequest) => boolean | Promise<boolean>

export class AppError extends Error {
  status = 400
}
export class InvalidError extends AppError {
  override name = 'InvalidError'
}
export class UnauthorizedError extends AppError {
  override name = 'UnauthorizedError'
  override status = 401
}
export class ForbiddenError extends AppError {
  override name = 'ForbiddenError'
  override status = 403
}
export class NotFoundError extends AppError {
  override name = 'NotFoundError'
  override status = 404
}
/** No model could answer: the runtime is missing, timed out, or gave nothing the schema accepts. */
export class ModelUnavailableError extends AppError {
  override name = 'ModelUnavailableError'
  override status = 503
}
/** Same name and `current` shape as golem-ui's, so the browser binding can rethrow it as one. */
export class VersionConflictError extends AppError {
  override name = 'VersionConflictError'
  override status = 409
  current: Row | null
  constructor(message: string, current: Row | null) {
    super(message)
    this.current = current
  }
}
export class RecordRefusedError extends AppError {
  override name = 'RecordRefusedError'
  override status = 422
  fields: Array<{ field: string; message: string }>
  constructor(message: string, fields: Array<{ field: string; message: string }> = []) {
    super(message)
    this.fields = fields
  }
}

const name = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const id = /^[A-Za-z0-9_-]{1,128}$/
const field = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const folder = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}(\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}){0,7}$/

function check(pattern: RegExp, label: string, value: string): string {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('..')) throw new InvalidError(`Invalid ${label}: ${JSON.stringify(value)}`)
  return value
}
export const validCollection = (value: string) => check(name, 'collection', value)
export const validId = (value: string) => check(id, 'id', value)
export const validField = (value: string) => check(field, 'field', value)
export const validFolder = (value: string) => check(folder, 'folder', value)
