import { builderInstructions, CliBackend, type SandboxMode } from './cli.ts'

type StreamEvent = {
  type?: string
  session_id?: string
  parent_tool_use_id?: string | null
  error?: string
  message?: { content?: Array<{ type?: string; text?: string }> }
  is_error?: boolean
  result?: string
  subtype?: string
}

/**
 * One native `claude -p --output-format stream-json` process per turn; `--resume <session_id>`
 * preserves continuity. The prompt goes over stdin so no variadic flag can swallow it.
 *
 * Build mode uses `--permission-mode bypassPermissions`: like Codex's `danger-full-access`, it runs
 * with the account's ordinary permissions and is not an app-root boundary. Read-only keeps only the
 * Read/Grep/Glob built-ins, loads no MCP servers (`--tools` alone leaves configured MCP tools), and
 * auto-denies anything that would prompt. Hooks and settings still come from the user's profile.
 */
export class ClaudeBackend extends CliBackend {
  protected readonly label = 'Claude Code'

  constructor(cwd: string, mode: SandboxMode, executable = 'claude', prefixArgs: string[] = [], sessionId?: string) {
    super(cwd, mode, executable, prefixArgs, sessionId)
  }

  protected args(): string[] {
    return [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt', builderInstructions(this.cwd),
      ...(this.mode === 'danger-full-access'
        ? ['--permission-mode', 'bypassPermissions']
        : ['--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']),
      ...(this.nativeThreadId ? ['--resume', this.nativeThreadId] : []),
    ]
  }

  protected input(text: string): string { return text }

  protected handle(event: StreamEvent, fail: (message: string) => void): void {
    if (event.session_id) this.nativeThreadId = event.session_id
    if (event.type === 'assistant' && !event.error && !event.parent_tool_use_id) {
      const text = (event.message?.content ?? []).filter((block) => block.type === 'text' && block.text).map((block) => block.text).join('\n\n')
      if (text) this.emit({ type: 'message', text })
    }
    if (event.type === 'result' && event.is_error) fail(event.result || `Claude Code request failed (${event.subtype ?? 'error'})`)
  }
}
