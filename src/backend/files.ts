import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { InvalidError, NotFoundError, validFolder, validId, type FileRef, type FileStore, type RecordStore, type Row } from '../operations.ts'

/** Record collection holding file metadata; the leading underscore keeps it off the public records routes. */
export const FILES_COLLECTION = '_files'

/** Bytes named by id under one root directory, so no caller-supplied string ever becomes a path. */
export async function diskFiles(directory: string, records: RecordStore): Promise<FileStore> {
  await mkdir(directory, { recursive: true })
  const path = (id: string) => join(directory, validId(id))
  const meta = async (id: string) => {
    const row = await records.get(FILES_COLLECTION, id)
    if (!row) throw new NotFoundError(`No file ${id}`)
    return toRef(row)
  }
  return {
    async put({ folder, name, contentType, bytes }) {
      validFolder(folder)
      if (!name || name.length > 255 || /[/\\\0]/.test(name)) throw new InvalidError(`Invalid file name: ${JSON.stringify(name)}`)
      const id = randomUUID()
      const temporary = `${path(id)}.upload`
      await writeFile(temporary, bytes, { flush: true })
      await rename(temporary, path(id))
      try {
        return toRef(await records.create(FILES_COLLECTION, { id, name, contentType: mediaType(contentType), size: bytes.byteLength, folder, uploadedAt: new Date().toISOString() }))
      } catch (error) {
        await unlink(path(id)).catch(() => {})
        throw error
      }
    },
    async read(id) {
      const ref = await meta(id)
      return { ref, bytes: await readFile(path(id)) }
    },
    async list(folder) {
      const refs: FileRef[] = []
      let cursor: string | null = null
      do {
        const found: Awaited<ReturnType<RecordStore['list']>> = await records.list(FILES_COLLECTION, { filter: { folder: validFolder(folder) }, sort: { field: 'uploadedAt', direction: 'desc' }, cursor, limit: 500 })
        refs.push(...found.rows.map(toRef))
        cursor = found.nextCursor
      } while (cursor)
      return refs
    },
    async caption(id, caption) {
      await meta(id)
      return toRef(await records.update(FILES_COLLECTION, id, { caption }))
    },
    async remove(id) {
      await records.remove(FILES_COLLECTION, validId(id))
      await unlink(path(id)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    },
  }
}

export function toRef(row: Row): FileRef {
  const { id, name, contentType, size, folder, uploadedAt, caption } = row as Row & FileRef
  return { id, name, contentType, size, folder, uploadedAt, ...(caption === undefined ? {} : { caption }) }
}

/** Only a bare `type/subtype` is kept; anything else is served as opaque bytes. */
function mediaType(value: string): string {
  const type = value.split(';')[0].trim().toLowerCase()
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream'
}
