import { spawn, type ChildProcess } from 'node:child_process'
import type { BackendEvent, SessionBackend } from './session.ts'

type JsonEvent = { type?: string; thread_id?: string; item?: { type?: string; text?: string }; error?: string; message?: string }

/** One native `codex exec --json` process per turn; the thread id preserves continuity. */
export class CodexBackend implements SessionBackend {
  private emit!: (event: BackendEvent) => void
  private threadId: string | undefined
  private child: ChildProcess | undefined
  private request: Promise<void> | undefined
  private interrupted = false
  private childClosed: Promise<void> | undefined
  private readonly executable: string
  private readonly prefixArgs: string[]

  constructor(executable = 'codex', prefixArgs: string[] = []) {
    this.executable = executable
    this.prefixArgs = prefixArgs
  }

  async start(emit: (event: BackendEvent) => void): Promise<void> { this.emit = emit }

  send(text: string): Promise<void> {
    if (this.request) return Promise.reject(new Error('Codex is already handling a request'))
    const args = this.threadId
      ? [...this.prefixArgs, 'exec', 'resume', this.threadId, '--json', '-c', 'sandbox_mode="read-only"', '--skip-git-repo-check', text]
      : [...this.prefixArgs, 'exec', '--json', '-s', 'read-only', '--skip-git-repo-check', text]
    this.request = new Promise((resolve, reject) => {
      this.interrupted = false
      const child = spawn(this.executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
          if (event.type === 'thread.started' && event.thread_id) this.threadId = event.thread_id
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
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = this.childClosed ?? new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill('SIGTERM')
    const escalation = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 250)
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))])
    clearTimeout(escalation)
  }
}
