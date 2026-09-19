import { watch } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A Golem app's brain: the `brain/` folder at the app root, an OKF bundle (root `index.md` with
 * `okf_version`, concepts with `type` front matter, optional `log.md`), served read-only to the
 * golem-ui Brain adapter. Paths are `/`-separated and relative to `brain/`.
 */
export type BrainEntry = { path: string; kind: 'file' | 'dir' }
export type BrainHit = { path: string; line: number; excerpt: string }

const segment = /^[^/\\\0.][^/\\\0]{0,127}$/
/** A relative path inside the bundle: no `..`, no hidden segments, no backslashes. Empty is the root. */
function clean(value: string): string {
  const path = value.replace(/\/$/, '')
  if (path && !path.split('/').every((part) => segment.test(part))) throw new Error(`Invalid brain path: ${JSON.stringify(value)}`)
  return path
}

export function openBrain(dir: string) {
  const list = async (dir_ = ''): Promise<BrainEntry[]> => {
    const folder = clean(dir_)
    const entries = await readdir(join(dir, folder), { withFileTypes: true }).catch(() => [])
    return entries
      .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.name.endsWith('.md')))
      .map((entry): BrainEntry => ({ path: folder ? `${folder}/${entry.name}` : entry.name, kind: entry.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'dir' ? -1 : 1))
  }
  const read = async (path: string): Promise<string> => {
    const file = clean(path)
    if (!file.endsWith('.md')) throw new Error(`Not a markdown file: ${path}`)
    return readFile(join(dir, file), 'utf8')
  }
  async function* walk(folder = ''): AsyncGenerator<string> {
    for (const entry of await list(folder)) {
      if (entry.kind === 'dir') yield* walk(entry.path)
      else yield entry.path
    }
  }
  return {
    list,
    read,
    /** That folder's `index.md`, or the OKF fallback: one bullet per entry, its `description` from front matter. */
    async index(dir_ = ''): Promise<string> {
      const folder = clean(dir_)
      const own = await read(folder ? `${folder}/index.md` : 'index.md').catch(() => undefined)
      if (own !== undefined) return own
      const lines = []
      for (const entry of await list(folder)) {
        const name = entry.path.slice(folder ? folder.length + 1 : 0)
        if (entry.kind === 'file' && (name === 'index.md' || name === 'log.md')) continue
        const description = entry.kind === 'file' ? /^description:\s*(.*)$/m.exec((await read(entry.path)).split(/^---$/m)[1] ?? '')?.[1]?.replace(/^["']|["']$/g, '') : ''
        lines.push(`* [${name}](${name}${entry.kind === 'dir' ? '/' : ''})${description ? ` - ${description}` : ''}`)
      }
      return `# ${folder || 'Index'}\n\n${lines.join('\n')}\n`
    },
    // ponytail: substring scan of every file per query; an index if a brain outgrows a few MB.
    async search(query: string, limit = 50): Promise<BrainHit[]> {
      const needle = query.trim().toLowerCase()
      const hits: BrainHit[] = []
      if (!needle) return hits
      for await (const path of walk()) {
        const lines = (await read(path)).split('\n')
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (lines[i]!.toLowerCase().includes(needle)) hits.push({ path, line: i + 1, excerpt: lines[i]!.trim().slice(0, 200) })
        }
        if (hits.length >= limit) break
      }
      return hits
    },
    /** Fires on any change under the folder; the browser re-reads what it shows. */
    watch(listener: () => void): () => void {
      let watcher: ReturnType<typeof watch> | undefined
      try { watcher = watch(dir, { recursive: true }, () => listener()) } catch { /* No folder yet: nothing to watch. */ }
      watcher?.on('error', () => {})
      return () => watcher?.close()
    },
  }
}

export type Brain = ReturnType<typeof openBrain>

/**
 * Source locations cited in an agent's reply, `path#L<start>-L<end>` relative to `brain/` (a leading
 * `brain/` is dropped), in order of first mention. What becomes `sources` on the chat event.
 */
export function citations(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/(?<![\w/.-])(?:brain\/)?([\w][\w./-]*\.md)#L(\d+)(?:-L?(\d+))?/g)) {
    found.add(`${match[1]}#L${match[2]}-L${match[3] ?? match[2]}`)
  }
  return [...found]
}
