import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { NotFoundError, RecordRefusedError, validCollection, validField, validId, type RecordStore, type Row } from '../operations.ts'
import { bounds, json, nextVersion } from './rules.ts'

/**
 * Records as JSON documents in one SQLite table, queried with json_extract.
 * `native` is the open `DatabaseSync` for app code in src/server/persistence that needs real SQL.
 */
export function sqliteStore(file: string): RecordStore & { native: DatabaseSync } {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id));`)
  const read = db.prepare('SELECT data FROM records WHERE collection = ? AND id = ?')
  const insert = db.prepare('INSERT INTO records (collection, id, data) VALUES (?, ?, ?)')
  const write = db.prepare('UPDATE records SET data = ? WHERE collection = ? AND id = ?')
  const erase = db.prepare('DELETE FROM records WHERE collection = ? AND id = ?')
  const get = (collection: string, id: string): Row | null => {
    const found = read.get(validCollection(collection), validId(id)) as { data: string } | undefined
    return found ? JSON.parse(found.data) as Row : null
  }
  // node:sqlite is synchronous, so each method below runs to completion without interleaving.
  return {
    native: db,
    async list(collection, query = {}) {
      const { offset, limit } = bounds(query)
      const where = ['collection = ?']
      const params: SQLInputValue[] = [validCollection(collection)]
      const path = (field: string) => `'$.${validField(field)}'`
      for (const [key, value] of Object.entries(query.filter ?? {})) {
        const allowed = Array.isArray(value) ? value : [value]
        const clauses = allowed.map((one) => {
          if (one === null) return `json_extract(data, ${path(key)}) IS NULL`
          params.push(typeof one === 'boolean' ? JSON.stringify(one) : one)
          return typeof one === 'boolean'
            ? `json_type(data, ${path(key)}) = ?`
            : `(json_extract(data, ${path(key)}) = ? AND json_type(data, ${path(key)}) ${typeof one === 'string' ? "= 'text'" : "IN ('integer', 'real')"})`
        })
        where.push(clauses.length ? `(${clauses.join(' OR ')})` : '0')
      }
      if (query.search?.text) {
        const text = query.search.text.toLowerCase()
        where.push(`(${query.search.fields.map((field) => { params.push(text); return `instr(lower(CAST(json_extract(data, ${path(field)}) AS TEXT)), ?) > 0` }).join(' OR ') || '0'})`)
      }
      const order = query.sort ? `json_extract(data, ${path(query.sort.field)}) ${query.sort.direction === 'desc' ? 'DESC' : 'ASC'}, rowid` : 'rowid'
      const rows = db.prepare(`SELECT data FROM records WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...params, limit + 1, offset) as Array<{ data: string }>
      return { rows: rows.slice(0, limit).map((row) => JSON.parse(row.data) as Row), nextCursor: rows.length > limit ? String(offset + limit) : null }
    },
    async get(collection, id) { return get(collection, id) },
    async create(collection, data) {
      const id = data.id === undefined ? randomUUID() : validId(String(data.id))
      if (get(collection, id)) throw new RecordRefusedError(`A record with id ${id} already exists`, [{ field: 'id', message: 'This id is already taken.' }])
      const now = new Date().toISOString()
      const row: Row = { ...json(data), id, version: 1, createdAt: now, updatedAt: now }
      insert.run(collection, id, JSON.stringify(row))
      return row
    },
    async update(collection, id, patch, options) {
      const row = nextVersion(collection, id, get(collection, id) ?? undefined, patch, options)
      write.run(JSON.stringify(row), collection, id)
      return row
    },
    async remove(collection, id) {
      if (!erase.run(validCollection(collection), validId(id)).changes) throw new NotFoundError(`No ${collection} record ${id}`)
    },
    async close() { if (db.isOpen) db.close() },
  }
}
