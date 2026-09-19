import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import {
  defineOperation, ForbiddenError, InvalidError, NotFoundError, validCollection, VersionConflictError, z,
  type Operation, type RecordStore, type Row,
} from '../operations.ts'

/** Internal collection holding one revision row per file: the numeric version Editor saves against and the last sha256 seen. */
export const KNOWLEDGE_COLLECTION = '_knowledge'

/** Knowledge roots an app's server module opts into: root name → directory relative to the app root. */
export type KnowledgeRoots = Record<string, string>

/** One markdown file as operations return it. `id` is the path, so it plugs into golem-ui's Records contract. */
export type KnowledgeFile = Row & { root: string; path: string; body: string; sha256: string; type: string | null; title: string }

const maxBytes = 2_000_000

// One queue per absolute file path, shared across server-module reloads.
// In-process only: a second server process on the same app is not covered.
const locks = new Map<string, Promise<unknown>>()
function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(work, work)
  const settled = next.catch(() => {})
  locks.set(key, settled)
  void settled.then(() => { if (locks.get(key) === settled) locks.delete(key) })
  return next
}
const segment = /^[^/\\\0.][^/\\\0]{0,127}$/

/** A relative `.md` path inside a root: no `..`, no hidden segments, no backslashes. */
export function validPath(value: string): string {
  const parts = typeof value === 'string' ? value.split('/') : []
  if (!parts.length || value.length > 512 || !value.endsWith('.md') || !parts.every((part) => segment.test(part))) {
    throw new InvalidError(`Invalid knowledge path: ${JSON.stringify(value)}`)
  }
  return value
}

/** What `authorize` sees as `record` for every knowledge operation, whether or not the file exists yet. */
export const knowledgeEntry = (root: string, path: string): Row => ({ id: `${root}/${path}`, root, path, version: 0, createdAt: '', updatedAt: '' })

/**
 * Markdown files under trusted roots, versioned for Editor. Golem's own writes are serialized per
 * file and compare the disk bytes against the version they were given right before the rename;
 * an edit made on disk since the last read shows up as a new version. Editors that do not go through
 * Golem are not locked out: one that writes in the instant between that check and the rename is overwritten.
 */
export function knowledgeOperations(appRoot: string, roots: KnowledgeRoots): Operation[] {
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) throw new Error('knowledge must map root names to directories')
  for (const [name, directory] of Object.entries(roots)) {
    validCollection(name)
    if (typeof directory !== 'string' || !directory || directory.startsWith('/') || directory.split(/[/\\]/).includes('..')) {
      throw new Error(`knowledge root ${name} must be a directory inside the app`)
    }
  }
  // Policy: no symlink anywhere between the app root and a file, so a path is also the file's one identity.
  async function base(root: string): Promise<string> {
    if (!Object.hasOwn(roots, root)) throw new NotFoundError(`No knowledge root ${root}`)
    const app = await realpath(appRoot)
    const top = join(app, roots[root])
    if (!(await unlinked(app, top))) throw new NotFoundError(`Knowledge root ${root} has no directory`)
    return top
  }

  /** Absolute path of a file under the root; every folder on the way is a real directory, and the file is opened without following links. */
  async function locate(root: string, path: string): Promise<string> {
    const top = await base(root)
    const file = join(top, validPath(path))
    await unlinked(top, dirname(file))
    return file
  }

  async function readDisk(file: string): Promise<Buffer | null> {
    let handle
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      if (code === 'ELOOP') throw new ForbiddenError('Knowledge files may not be symlinks')
      throw error
    }
    try {
      const stat = await handle.stat()
      // A second hard link would be a second name for the same bytes, possibly outside the root.
      if (!stat.isFile() || stat.nlink > 1) throw new ForbiddenError('Not a knowledge file')
      const bytes = await handle.readFile()
      if (bytes.byteLength > maxBytes) throw new InvalidError('Knowledge file is too large')
      return bytes
    } finally {
      await handle.close()
    }
  }

  /** The revision row for these bytes: a sha the store has not seen yet bumps the version. */
  async function revision(records: RecordStore, root: string, path: string, bytes: Buffer): Promise<Row> {
    const id = createHash('sha256').update(`${root}\0${path}`).digest('hex').slice(0, 40)
    const sha256 = hash(bytes)
    const row = await records.get(KNOWLEDGE_COLLECTION, id)
    if (!row) return records.create(KNOWLEDGE_COLLECTION, { id, root, path, sha256 })
    return row.sha256 === sha256 ? row : records.update(KNOWLEDGE_COLLECTION, id, { sha256 })
  }

  async function read(records: RecordStore, root: string, path: string): Promise<KnowledgeFile> {
    const file = await locate(root, path)
    return serial(file, async () => {
      const bytes = await readDisk(file)
      if (!bytes) throw new NotFoundError(`No knowledge file ${root}/${path}`)
      return toFile(root, path, bytes, await revision(records, root, path, bytes))
    })
  }

  async function write(records: RecordStore, root: string, path: string, body: string, expectedVersion: number): Promise<KnowledgeFile> {
    const file = await locate(root, path)
    return serial(file, async () => {
      const before = await readDisk(file)
      const current = before && await revision(records, root, path, before)
      const conflict = async () => new VersionConflictError(`${root}/${path} changed since it was read`, before && current ? toFile(root, path, before, current) : null)
      if (current ? current.version !== expectedVersion : expectedVersion !== 0) throw await conflict()
      const bytes = Buffer.from(body, 'utf8')
      if (bytes.byteLength > maxBytes) throw new InvalidError('Knowledge file is too large')
      if (!before) await mkdirInside(await base(root), dirname(file))
      const temporary = join(dirname(file), `.${randomUUID()}.golem-write`)
      await writeFile(temporary, bytes, { flush: true, flag: 'wx' })
      try {
        if (!before) {
          // link() refuses an existing name: a file created meanwhile is a conflict, not overwritten.
          await link(temporary, file).catch(async (error) => { throw error.code === 'EEXIST' ? await conflict() : error })
        } else {
          const latest = await readDisk(file)
          if (!latest || hash(latest) !== hash(before)) throw new VersionConflictError(`${root}/${path} changed on disk while saving`, latest ? toFile(root, path, latest, await revision(records, root, path, latest)) : null)
          await rename(temporary, file)
        }
      } finally {
        await unlink(temporary).catch(() => {})
      }
      return toFile(root, path, bytes, await revision(records, root, path, bytes))
    })
  }

  async function* walk(top: string, folder: string): AsyncGenerator<string> {
    const entries = await readdir(join(top, folder), { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      const path = folder ? `${folder}/${entry.name}` : entry.name
      // Symlinked entries are skipped, so a link never pulls outside content into a listing.
      if (entry.isDirectory()) yield* walk(top, path)
      else if (entry.isFile() && entry.name.endsWith('.md')) yield path
    }
  }

  const root = z.string().min(1)
  const path = z.string().transform((value, context) => {
    try { return validPath(value) } catch (error) { context.addIssue({ code: 'custom', message: (error as Error).message }); return z.NEVER }
  })
  const entry = (input: { root: string; path: string }) => ({ row: knowledgeEntry(input.root, input.path) })
  const fileRow = z.looseObject({ id: z.string(), root: z.string(), path: z.string(), version: z.number(), body: z.string() })
  const listed = z.looseObject({ id: z.string(), root: z.string(), path: z.string(), version: z.number(), title: z.string(), type: z.string().nullable() })

  // Folder paths are validated like file paths, minus the extension.
  const folder = z.string().refine((value) => value === '' || value.split('/').every((part) => segment.test(part)), 'must be a relative folder')
  async function files(input: { root: string; folder?: string }, permits: (row: Row) => Promise<boolean>) {
    const top = await base(input.root)
    if (input.folder && !(await unlinked(top, join(top, input.folder)))) return []
    const found: string[] = []
    for await (const one of walk(top, input.folder ?? '')) {
      if (await permits(knowledgeEntry(input.root, one))) found.push(one)
    }
    return found
  }

  return [
    defineOperation({
      name: 'knowledge.list',
      description: 'List markdown files in a knowledge root (optionally one folder), with their title, OKF type and version. Start here to find sources.',
      input: z.object({ root, folder: folder.optional() }),
      output: z.object({ rows: z.array(listed), nextCursor: z.null() }),
      async run(input, { records, permits }) {
        const rows = []
        for (const one of await files(input, permits)) {
          const file = await read(records, input.root, one).catch(() => null)
          if (file) rows.push(summary(file))
        }
        return { rows, nextCursor: null }
      },
    }),
    defineOperation({
      name: 'knowledge.search',
      description: 'Find lines containing some text across a knowledge root. Returns path, 1-based line number and that line, so an answer can cite its source.',
      input: z.object({ root, text: z.string().min(2).max(200), limit: z.number().int().min(1).max(100).optional() }),
      output: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
      async run(input, { records, permits }) {
        const needle = input.text.toLowerCase()
        const hits: Array<{ path: string; line: number; text: string }> = []
        for (const one of await files(input, permits)) {
          const file = await read(records, input.root, one).catch(() => null)
          file?.body.split('\n').forEach((text, index) => { if (text.toLowerCase().includes(needle)) hits.push({ path: one, line: index + 1, text: text.slice(0, 400) }) })
          if (hits.length >= (input.limit ?? 30)) break
        }
        return hits.slice(0, input.limit ?? 30)
      },
    }),
    defineOperation({
      name: 'knowledge.read',
      description: 'Read one markdown file: its whole text (frontmatter included) as `body`, and the `version` a write must send back.',
      input: z.object({ root, path }), output: fileRow, record: entry,
      run: (input, { records }) => read(records, input.root, input.path),
    }),
    defineOperation({
      name: 'knowledge.write',
      description: 'Replace one markdown file with `body`. Send the `version` you read (0 to create a new file); a file changed since then is refused with the current text.',
      input: z.object({ root, path, body: z.string(), expectedVersion: z.number().int().min(0) }), output: fileRow, record: entry,
      run: (input, { records }) => write(records, input.root, input.path, input.body, input.expectedVersion),
    }),
  ]
}

/** True when every step from `top` down to `target` exists as a real directory; a symlink on the way is refused. */
async function unlinked(top: string, target: string): Promise<boolean> {
  let at = top
  for (const part of relative(top, target).split(sep).filter(Boolean)) {
    at = join(at, part)
    const stat = await lstat(at).catch(() => null)
    if (!stat) return false
    if (!stat.isDirectory()) throw new ForbiddenError('Path leaves the knowledge root')
  }
  return true
}

async function mkdirInside(top: string, directory: string): Promise<void> {
  const parts = relative(top, directory).split(sep).filter(Boolean)
  let at = top
  for (const part of parts) {
    at = join(at, part)
    const stat = await lstat(at).catch(() => null)
    if (!stat) await mkdir(at).catch((error) => { if (error.code !== 'EEXIST') throw error })
    else if (!stat.isDirectory()) throw new ForbiddenError('Path leaves the knowledge root')
  }
}

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function toFile(root: string, path: string, bytes: Buffer, revision: Row): KnowledgeFile {
  const body = bytes.toString('utf8')
  const meta = frontmatter(body)
  const title = meta.title || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || path.split('/').pop()!.replace(/\.md$/, '')
  return { id: path, root, path, body, sha256: revision.sha256 as string, type: meta.type || null, title, version: revision.version, createdAt: revision.createdAt, updatedAt: revision.updatedAt }
}

const summary = ({ body: _body, ...rest }: KnowledgeFile) => rest

/** Top-level scalar keys of a YAML frontmatter block; enough for OKF's `type`, `title` and `description`. */
function frontmatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1]
  const out: Record<string, string> = {}
  for (const line of block?.split(/\r?\n/) ?? []) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line)
    if (match && match[2]) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}
