import { InvalidError, NotFoundError, VersionConflictError, validField, type RecordPage, type RecordQuery, type Row } from '../operations.ts'

/** Shared update rule: the version check and the store-owned fields. */
export function nextVersion(collection: string, id: string, current: Row | undefined, patch: Record<string, unknown>, options?: { expectedVersion: number; versionField?: string }): Row {
  if (!current) throw new NotFoundError(`No ${collection} record ${id}`)
  if (options && current[options.versionField ?? 'version'] !== options.expectedVersion) {
    throw new VersionConflictError(`This ${collection} record changed since it was read`, current)
  }
  const { id: _id, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...changes } = patch
  return { ...current, ...json(changes), id: current.id, version: current.version + 1, createdAt: current.createdAt, updatedAt: new Date().toISOString() }
}

/** The query semantics both stores share: equality filters, case-insensitive search, stable sort, offset cursor. */
export function page(rows: Row[], query: RecordQuery = {}): RecordPage<Row> {
  const { offset, limit } = bounds(query)
  let matched = rows
  for (const [key, value] of Object.entries(query.filter ?? {})) {
    validField(key)
    const allowed = Array.isArray(value) ? value : [value]
    matched = matched.filter((row) => allowed.some((one) => one === null ? row[key] == null : row[key] === one))
  }
  if (query.search?.text) {
    const text = query.search.text.toLowerCase()
    const fields = query.search.fields.map(validField)
    matched = matched.filter((row) => fields.some((key) => row[key] != null && String(row[key]).toLowerCase().includes(text)))
  }
  if (query.sort) {
    const { field, direction } = query.sort
    validField(field)
    const sign = direction === 'desc' ? -1 : 1
    matched = matched.toSorted((left, right) => sign * compare(left[field], right[field]))
  }
  const slice = matched.slice(offset, offset + limit)
  return { rows: slice, nextCursor: offset + limit < matched.length ? String(offset + limit) : null }
}

export function bounds(query: RecordQuery = {}): { offset: number; limit: number } {
  const offset = query.cursor ? Number(query.cursor) : 0
  const limit = query.limit ?? 50
  if (!Number.isInteger(offset) || offset < 0) throw new InvalidError('Invalid cursor')
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new InvalidError('limit must be an integer from 1 to 500')
  return { offset, limit }
}

function compare(left: unknown, right: unknown): number {
  if (left == null || right == null) return left == null ? (right == null ? 0 : -1) : 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** Stored values are JSON: what is kept in memory must equal what a restart reads back. */
export function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
