import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BackendEvent, SessionBackend } from './session.ts'

type JsonEvent = { type?: string; thread_id?: string; item?: { type?: string; text?: string }; error?: string; message?: string }
export type SandboxMode = 'read-only' | 'danger-full-access'

const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function builderInstructions(cwd: string): string {
  const source = process.env.GOLEM_SOURCE ? resolve(process.env.GOLEM_SOURCE) : frameworkRoot
  const ui = process.env.GOLEM_UI_SOURCE ? resolve(process.env.GOLEM_UI_SOURCE) : undefined
  const guide = resolve(source, 'docs/builder.md')
  return `You are Golem's in-app builder. The user sees Chat beside their application's Canvas. Explain that plainly and ask what they want to create; do not redirect them to generic coding-assistant documentation. Build-mode turns may edit the app and, after success, Golem rebuilds and refreshes the Canvas. Conversation history persists, including resumed threads. Read ${existsSync(guide) ? guide : resolve(frameworkRoot, 'docs/builder.md')} and ${resolve(cwd, 'docs/domain.md')} when present before major work, implementation, or opening/updating a pull request. This app is ${cwd}; active Golem source is ${source}${ui ? `; active golem-ui source is ${ui}` : ''}. Keep app-specific decisions in the app and shared framework/UI knowledge in its owner. Respect the selected sandbox and do not change files in read-only mode.`
}

/**
 * One native `codex exec --json` process per turn; the thread id preserves continuity.
 * `mode` is chosen by the caller (the dev server, from the session's explicit build intent),
 * never defaulted here: an explicit build intent selects `danger-full-access`, a supported
 * `-s`/`--sandbox` value (`codex exec --help`) that runs with the account's own ordinary
 * filesystem permissions — not the `--dangerously-bypass-approvals-and-sandbox` omnibus flag,
 * which is never used here; every other session stays `read-only`.
 *
 * `cwd`/`-C` are pinned to the resolved app root so Codex resolves relative paths correctly —
 * not as a security boundary. A build-mode session can write anywhere this account can.
 */
export class CodexBackend implements SessionBackend {
  private emit!: (event: BackendEvent) => void
  private nativeThreadId: string | undefined
  private child: ChildProcess | undefined
  private request: Promise<void> | undefined
  private interrupted = false
  private childClosed: Promise<void> | undefined
  private readonly cwd: string
  private readonly mode: SandboxMode
  private readonly executable: string
  private readonly prefixArgs: string[]

  constructor(cwd: string, mode: SandboxMode, executable = 'codex', prefixArgs: string[] = [], threadId?: string) {
    this.cwd = cwd
    this.mode = mode
    this.executable = executable
    this.prefixArgs = prefixArgs
    this.nativeThreadId = threadId
  }

  async start(emit: (event: BackendEvent) => void): Promise<void> { this.emit = emit }

  threadId(): string | undefined { return this.nativeThreadId }

  send(text: string): Promise<void> {
    if (this.request) return Promise.reject(new Error('Codex is already handling a request'))
    const instructions = `developer_instructions=${JSON.stringify(builderInstructions(this.cwd))}`
    const args = this.nativeThreadId
      ? [...this.prefixArgs, 'exec', 'resume', this.nativeThreadId, '--json', '-c', instructions, '-c', `sandbox_mode="${this.mode}"`, '--skip-git-repo-check', text]
      : [...this.prefixArgs, 'exec', '--json', '-c', instructions, '-s', this.mode, '-C', this.cwd, '--skip-git-repo-check', text]
    this.request = new Promise((resolve, reject) => {
      this.interrupted = false
      const child = spawn(this.executable, args, { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
      this.child = child
      this.childClosed = new Promise((resolve) => child.once('close', () => resolve()))
      let stderr = ''
      let output = ''
      let settled = false
      const fail = (message: string) => {
        if (settled) return
        settled = true
        this.emit({ type: 'error', message })
        reject(new Error(message))
        void this.stopChild(child)
      }
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        output += String(chunk)
        const lines = output.split('\n')
        output = lines.pop() ?? ''
        for (const line of lines.filter(Boolean)) {
          let event: JsonEvent
          try { event = JSON.parse(line) } catch { continue }
          if (event.type === 'thread.started' && event.thread_id) this.nativeThreadId = event.thread_id
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
            this.emit({ type: 'message', text: event.item.text })
          }
          if (event.type === 'error' || event.type === 'turn.failed') fail(event.error ?? event.message ?? 'Codex request failed')
        }
      })
      child.once('error', (error) => fail(error.message))
      child.once('close', (code, signal) => {
        this.child = undefined
        this.childClosed = undefined
        this.request = undefined
        if (settled) return
        if (code === 0 || this.interrupted) { settled = true; resolve(); return }
        fail(stderr.trim() || (signal ? `Codex terminated by ${signal}` : `Codex exited with code ${code}`))
      })
    })
    return this.request
  }

  async interrupt(): Promise<void> {
    if (!this.child) return
    this.interrupted = true
    await this.stopChild(this.child)
  }

  async shutdown(): Promise<void> {
    if (this.child) await this.stopChild(this.child)
    if (this.request) await this.request.catch(() => {})
    this.child = undefined
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    const closed = this.childClosed ?? new Promise<void>((resolve) => child.once('close', () => resolve()))
    this.signal(child, 'SIGTERM')
    // Always escalate the request group: its leader may exit after TERM while a child survives.
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
    this.signal(child, 'SIGKILL')
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 750))])
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}
