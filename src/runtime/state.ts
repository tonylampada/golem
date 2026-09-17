import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionSnapshot } from './session.ts'

type State = { version: 1; sessions: SessionSnapshot[] }

export class ConversationState {
  private readonly file: string

  constructor(directory: string) { this.file = join(directory, 'conversations.json') }

  async load(): Promise<SessionSnapshot[]> {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8')) as State
      if (state.version !== 1 || !Array.isArray(state.sessions)) throw new Error('unsupported conversation state')
      return state.sessions
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`Cannot load saved conversations: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async save(sessions: SessionSnapshot[]): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(temporary, JSON.stringify({ version: 1, sessions }) + '\n', 'utf8')
      await rename(temporary, this.file)
    } catch (error) {
      try { await import('node:fs/promises').then(({ unlink }) => unlink(temporary)) } catch {}
      throw new Error(`Cannot save conversations: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
