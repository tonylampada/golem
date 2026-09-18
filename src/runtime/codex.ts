import { builderInstructions, CliBackend, type SandboxMode } from './cli.ts'

export type { SandboxMode }

type JsonEvent = { type?: string; thread_id?: string; item?: { type?: string; text?: string }; error?: string; message?: string }

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
export class CodexBackend extends CliBackend {
  protected readonly label = 'Codex'

  constructor(cwd: string, mode: SandboxMode, executable = 'codex', prefixArgs: string[] = [], threadId?: string) {
    super(cwd, mode, executable, prefixArgs, threadId)
  }

  protected args(text: string): string[] {
    const instructions = `developer_instructions=${JSON.stringify(builderInstructions(this.cwd))}`
    return this.nativeThreadId
      ? ['exec', 'resume', this.nativeThreadId, '--json', '-c', instructions, '-c', `sandbox_mode="${this.mode}"`, '--skip-git-repo-check', text]
      : ['exec', '--json', '-c', instructions, '-s', this.mode, '-C', this.cwd, '--skip-git-repo-check', text]
  }

  protected handle(event: JsonEvent, fail: (message: string) => void): void {
    if (event.type === 'thread.started' && event.thread_id) this.nativeThreadId = event.thread_id
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
      this.emit({ type: 'message', text: event.item.text })
    }
    if (event.type === 'error' || event.type === 'turn.failed') fail(event.error ?? event.message ?? 'Codex request failed')
  }
}
