import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NotFoundError, RecordRefusedError, validCollection, validId, type RecordStore, type Row } from '../operations.ts'
import { json, nextVersion, page } from './rules.ts'

type Entry = { put: Row } | { remove: string }

/**
 * One append-only JSONL log per collection, replayed into memory on first use and fsynced per write.
 * Single-process only and one write at a time; use the SQLite store for anything busier.
 */
export async function jsonlStore(directory: string): Promise<RecordStore & { native: string }> {
  await mkdir(directory, { recursive: true })
  const collections = new Map<string, Map<string, Row>>()
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work)
    queue = run.catch(() => {})
    return run
  }
  const file = (collection: string) => join(directory, `${validCollection(collection)}.jsonl`)

  async function load(collection: string): Promise<Map<string, Row>> {
    const loaded = collections.get(collection)
    if (loaded) return loaded
    const rows = new Map<string, Row>()
    let text = ''
    try { text = await readFile(file(collection), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // A crash can leave one torn line at the end; everything before the last newline was acknowledged.
    const complete = text.slice(0, text.lastIndexOf('\n') + 1)
    const lines = complete.split('\n').filter(Boolean)
    for (const line of lines) {
      const entry = JSON.parse(line) as Entry
      if ('put' in entry) rows.set(entry.put.id, entry.put)
      else rows.delete(entry.remove)
    }
    if (complete.length !== text.length || lines.length > rows.size * 2 + 100) {
      const temporary = `${file(collection)}.${process.pid}.tmp`
      await writeFile(temporary, [...rows.values()].map((row) => `${JSON.stringify({ put: row })}\n`).join(''), { flush: true })
      await rename(temporary, file(collection))
    }
    collections.set(collection, rows)
    return rows
  }

  async function append(collection: string, entry: Entry): Promise<void> {
    const handle = await open(file(collection), 'a')
    try {
      await handle.appendFile(`${JSON.stringify(entry)}\n`)
      await handle.datasync()
    } finally {
      await handle.close()
    }
  }

  return {
    native: directory,
    async list(collection, query) { return structuredClone(page([...(await serial(() => load(collection))).values()], query)) },
    async get(collection, id) { return structuredClone((await serial(() => load(collection))).get(validId(id)) ?? null) },
    create: (collection, data) => serial(async () => {
      const rows = await load(collection)
      const id = data.id === undefined ? randomUUID() : validId(String(data.id))
      if (rows.has(id)) throw new RecordRefusedError(`A record with id ${id} already exists`, [{ field: 'id', message: 'This id is already taken.' }])
      const now = new Date().toISOString()
      const row: Row = { ...json(data), id, version: 1, createdAt: now, updatedAt: now }
      await append(collection, { put: row })
      rows.set(id, row)
      return structuredClone(row)
    }),
    update: (collection, id, patch, options) => serial(async () => {
      const rows = await load(collection)
      const current = rows.get(validId(id))
      const row = nextVersion(collection, id, current, patch, options)
      await append(collection, { put: row })
      rows.set(id, row)
      return structuredClone(row)
    }),
    remove: (collection, id) => serial(async () => {
      const rows = await load(collection)
      if (!rows.has(validId(id))) throw new NotFoundError(`No ${collection} record ${id}`)
      await append(collection, { remove: id })
      rows.delete(id)
    }),
    close: () => serial(async () => { collections.clear() }),
  }
}
