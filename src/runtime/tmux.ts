import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentName } from './discovery.ts'
import type { BackendEvent, PaneAccess, SessionBackend, SlashCommand } from './session.ts'

const require = createRequire(import.meta.url)
const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The Bridge Commander harness ref: enough to find, kill or resume the tmux session after a restart. */
export type HarnessRef = { harness: string; session: string; cwd: string; resumeId?: string; window?: string }

/** The seven-verb harness port (src/runtime/harness/README in bridge-commander); `fake.js` for tests. */
export type Harness = {
  spawn(cwd: string, prompt: string, opts: object): Promise<HarnessRef>
  send(ref: HarnessRef, text: string): Promise<void>
  resume(ref: HarnessRef, opts: object): Promise<HarnessRef>
  kill(ref: HarnessRef): Promise<void> | void
  onTurnEnd(ref: HarnessRef, hook: (event: { session_id?: string | null }) => void, opts: object): () => void
  paneInput?(ref: HarnessRef, input: { key?: string; text?: string }): Promise<void>
  openPane?(ref: HarnessRef, opts: { onFrame: (frame: string) => void }): Promise<PaneHandle> | PaneHandle
  paneSnapshot?(ref: HarnessRef): Promise<string>
  commands?(ref: HarnessRef): SlashCommand[]
  runCommand?(ref: HarnessRef, line: string): Promise<string>
  /** Pins a session-granular ref (pre-window conversations) to a named window without restarting the agent. */
  adoptWindow?(ref: HarnessRef, window: string): Promise<HarnessRef | null>
}
export type PaneHandle = { close(): void }

export const harnesses: Record<AgentName, Harness> = {
  claude: require('./harness/claude-tmux.js'),
  codex: require('./harness/codex-tmux.js'),
}

export function builderInstructions(cwd: string): string {
  const source = process.env.GOLEM_SOURCE ? resolve(process.env.GOLEM_SOURCE) : frameworkRoot
  const ui = process.env.GOLEM_UI_SOURCE ? resolve(process.env.GOLEM_UI_SOURCE) : undefined
  const guide = resolve(source, 'docs/builder.md')
  return `You are Golem's in-app builder. The user sees Chat beside their application's Canvas. Explain that plainly and ask what they want to create; do not redirect them to generic coding-assistant documentation. Build-mode turns may edit the app and, after success, Golem rebuilds and refreshes the Canvas. Conversation history persists, including resumed threads. Read ${existsSync(guide) ? guide : resolve(frameworkRoot, 'docs/builder.md')} and ${resolve(cwd, 'docs/domain.md')} when present before major work, implementation, or opening/updating a pull request. This app is ${cwd}; active Golem source is ${source}${ui ? `; active golem-ui source is ${ui}` : ''}. Keep app-specific decisions in the app and shared framework/UI knowledge in its owner. The user only sees what you send with \`./golem say <text>\` (or \`./golem say --file <f>\`) from the app root; answer every message that way, nothing printed in this terminal reaches them.${existsSync(resolve(cwd, 'brain/index.md')) ? ` ${brainInstructions}` : ''}`
}

/** The `chat` window's brief: the app's `docs/chat.md` when present, else a plain assistant; never a builder. */
export function chatInstructions(cwd: string): string {
  const brief = resolve(cwd, 'docs/chat.md')
  const own = existsSync(brief) ? readFileSync(brief, 'utf8').trim() : `You are the assistant of the application in ${cwd}. People chat with you beside the running app; help them use it and answer questions about it.`
  return `${own} You are not this app's builder: do not edit its files, run builds, or change its configuration; if asked to, say the Builder switch is for that. The user only sees what you send with \`./golem say <text>\` (or \`./golem say --file <f>\`) from the app root; answer every message that way, nothing printed in this terminal reaches them.${existsSync(resolve(cwd, 'brain/index.md')) ? ` ${brainInstructions}` : ''}`
}

/** Added when the app has a `brain/` folder: read the root index first, cite what you used. */
export const brainInstructions = 'This app has a brain: `brain/` is an Open Knowledge Format bundle. Read `brain/index.md` first, then the concepts it points to. When an answer is grounded in the brain, cite each passage you used as `path#Lstart-Lend` (the path relative to `brain/`, e.g. `concepts/opening.md#L4-L9`); Golem turns those citations into source chips under your reply that open the passage in the reader.'

/** `window` names this agent's window in the app's session (`builder`, `chat`); `instructions` its launch prompt. */
export type TmuxOptions = { harness?: Harness; stateDir?: string; api?: string; window?: string; instructions?: string }

/** The one tmux session of an app's build mode: `tmux attach -t golem-<app dir>` is always the place to look. */
export const tmuxSessionName = (cwd: string): string => `golem-${basename(cwd).replace(/[^A-Za-z0-9_-]/g, '-')}`

/**
 * One agent per app, in the fixed tmux session `golem-<app dir>` (attach to watch or take over). A
 * conversation whose agent was killed to make room for another resumes it there on its next message
 * (`SessionManager.parkOthers`). `send` types the message with verified submit and resolves at the agent's turn end
 * (Stop hook / codex notify); the reply itself arrives through `golem say`, never from the pane.
 */
export class TmuxBackend implements SessionBackend {
  private ref: HarnessRef | undefined
  private emit!: (event: BackendEvent) => void
  private turnEnded: (() => void) | undefined
  private unsubscribe: (() => void) | undefined
  private readonly harness: Harness
  private readonly opts: TmuxOptions

  private readonly cwd: string
  private readonly agent: AgentName

  constructor(cwd: string, agent: AgentName, ref?: HarnessRef, opts: TmuxOptions = {}) {
    this.cwd = cwd
    this.agent = agent
    this.ref = ref
    this.opts = opts
    this.harness = opts.harness ?? harnesses[agent]
  }

  async start(emit: (event: BackendEvent) => void, sessionId: string): Promise<void> {
    this.emit = emit
    const opts = {
      stateDir: this.opts.stateDir ?? resolve(this.cwd, '.golem/harness'),
      session: tmuxSessionName(this.cwd),
      window: this.opts.window,
      env: { GOLEM_SESSION: sessionId, GOLEM_API: this.opts.api ?? 'http://127.0.0.1:3000' },
      // codex 0.155: the update prompt at launch would take the typed brief as its answer, the
      // paste-burst fold swallows the first Enter of a long line, and the rate-limit "keep current
      // model" nudge after the first turn eats the first message. All off; replayed on resume.
      extraArgs: this.agent === 'codex' ? ['-c', 'check_for_update_on_startup=false', '-c', 'disable_paste_burst=true', '-c', 'notice.hide_rate_limit_model_nudge=true'] : [],
    }
    try {
      // A ref saved under an older naming (`golem-<uuid>`) comes back in the app's fixed session: only
      // resumeId carries continuity, and the stray session, if still up, would break one-session-per-app.
      if (this.ref && this.ref.session !== opts.session) {
        await this.harness.kill(this.ref)
        this.ref = { ...this.ref, session: opts.session, window: opts.window }
      }
      // A conversation saved before windows existed owned the whole session: pin it to its window first.
      if (this.ref && !this.ref.window && opts.window) this.ref = (await this.harness.adoptWindow?.(this.ref, opts.window)) ?? this.ref
      this.ref = this.ref ? await this.harness.resume(this.ref, opts) : await this.harness.spawn(this.cwd, this.opts.instructions ?? builderInstructions(this.cwd), opts)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit({ type: 'error', message: `${this.agent} session failed to start: ${message}` })
      throw error
    }
    this.unsubscribe = this.harness.onTurnEnd(this.ref, (event) => {
      if (event.session_id) this.ref!.resumeId = event.session_id // codex adopts its thread id from the first turn end
      this.turnEnded?.()
    }, opts)
  }

  async send(text: string): Promise<void> {
    if (this.turnEnded) throw new Error(`${this.agent} is already handling a request`)
    // ponytail: the next turn end is taken as this message's; a launch-prompt turn still running when
    // the first message lands ends it early. The reply still arrives via `golem say` either way.
    const done = new Promise<void>((resolve) => { this.turnEnded = resolve })
    try { await this.harness.send(this.ref!, text) } catch (error) { this.turnEnded = undefined; throw error }
    await done
    this.turnEnded = undefined
  }

  async interrupt(): Promise<void> {
    if (!this.ref) return
    await this.harness.paneInput?.(this.ref, { key: 'C-c' })
    this.turnEnded?.()
    this.turnEnded = undefined
  }

  /** The server is stopping, the agent is not: the tmux session outlives it and is resumed on restart. */
  async detach(): Promise<void> { this.unsubscribe?.() }

  async shutdown(): Promise<void> {
    this.unsubscribe?.()
    this.turnEnded?.() // a send cut short by the kill still resolves; its reply will never come
    this.turnEnded = undefined
    if (this.ref) await this.harness.kill(this.ref)
  }

  harnessRef(): HarnessRef | undefined { return this.ref }

  /** The harness's own slash commands (`/status`, `/compact`, …); `/reset` is the server's, not listed here. */
  commands(): SlashCommand[] { return this.ref && this.harness.commands ? this.harness.commands(this.ref) : [] }

  async runCommand(line: string): Promise<string> {
    if (!this.ref || !this.harness.runCommand) throw new Error(`unknown command ${line.split(/\s+/)[0]}`)
    return this.harness.runCommand(this.ref, line)
  }

  /** The live tmux screen, for the Terminal popup: undefined until the agent has been spawned or resumed. */
  pane(): PaneAccess | undefined {
    const { harness, ref } = this
    if (!ref || !harness.openPane) return undefined
    return {
      open: (onFrame) => harness.openPane!(ref, { onFrame }),
      snapshot: () => harness.paneSnapshot?.(ref) ?? Promise.resolve(''),
      input: (input) => harness.paneInput?.(ref, input) ?? Promise.reject(new Error('harness cannot take pane input')),
    }
  }
}
