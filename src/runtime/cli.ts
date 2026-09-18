import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BackendEvent, SessionBackend } from './session.ts'

export type SandboxMode = 'read-only' | 'danger-full-access'

const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function builderInstructions(cwd: string): string {
  const source = process.env.GOLEM_SOURCE ? resolve(process.env.GOLEM_SOURCE) : frameworkRoot
  const ui = process.env.GOLEM_UI_SOURCE ? resolve(process.env.GOLEM_UI_SOURCE) : undefined
  const guide = resolve(source, 'docs/builder.md')
  return `You are Golem's in-app builder. The user sees Chat beside their application's Canvas. Explain that plainly and ask what they want to create; do not redirect them to generic coding-assistant documentation. Build-mode turns may edit the app and, after success, Golem rebuilds and refreshes the Canvas. Conversation history persists, including resumed threads. Read ${existsSync(guide) ? guide : resolve(frameworkRoot, 'docs/builder.md')} and ${resolve(cwd, 'docs/domain.md')} when present before major work, implementation, or opening/updating a pull request. This app is ${cwd}; active Golem source is ${source}${ui ? `; active golem-ui source is ${ui}` : ''}. Keep app-specific decisions in the app and shared framework/UI knowledge in its owner. Respect the selected sandbox and do not change files in read-only mode.`
}

/**
 * One native agent CLI process per turn, reading its JSONL stdout. The native thread id preserves
 * continuity across turns. Interrupt and shutdown kill the whole process group.
 */
export abstract class CliBackend implements SessionBackend {
  protected emit!: (event: BackendEvent) => void
  protected nativeThreadId: string | undefined
  private child: ChildProcess | undefined
  private request: Promise<void> | undefined
  private interrupted = false
  private childClosed: Promise<void> | undefined
  protected readonly cwd: string
  protected readonly mode: SandboxMode
  private readonly executable: string
  private readonly prefixArgs: string[]
  protected abstract readonly label: string

  constructor(cwd: string, mode: SandboxMode, executable: string, prefixArgs: string[] = [], threadId?: string) {
    this.cwd = cwd
    this.mode = mode
    this.executable = executable
    this.prefixArgs = prefixArgs
    this.nativeThreadId = threadId
  }

  /** Native arguments for one turn. */
  protected abstract args(text: string): string[]
  /** Handles one parsed JSONL event; calls `fail` for a turn-level error. */
  protected abstract handle(event: any, fail: (message: string) => void): void
  /** Text written to stdin, when the CLI reads the prompt there. */
  protected input(_text: string): string | undefined { return undefined }

  async start(emit: (event: BackendEvent) => void): Promise<void> { this.emit = emit }

  threadId(): string | undefined { return this.nativeThreadId }

  send(text: string): Promise<void> {
    if (this.request) return Promise.reject(new Error(`${this.label} is already handling a request`))
    const args = [...this.prefixArgs, ...this.args(text)]
    const input = this.input(text)
    this.request = new Promise((resolve, reject) => {
      this.interrupted = false
      const child = spawn(this.executable, args, { cwd: this.cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
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
      if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input) }
      child.stderr!.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
      child.stdout!.setEncoding('utf8').on('data', (chunk) => {
        output += String(chunk)
        const lines = output.split('\n')
        output = lines.pop() ?? ''
        for (const line of lines.filter(Boolean)) {
          let event: unknown
          try { event = JSON.parse(line) } catch { continue }
          if (event && typeof event === 'object') this.handle(event, fail)
        }
      })
      child.once('error', (error) => fail(error.message))
      child.once('close', (code, signal) => {
        this.child = undefined
        this.childClosed = undefined
        this.request = undefined
        if (settled) return
        if (code === 0 || this.interrupted) { settled = true; resolve(); return }
        fail(stderr.trim() || (signal ? `${this.label} terminated by ${signal}` : `${this.label} exited with code ${code}`))
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
