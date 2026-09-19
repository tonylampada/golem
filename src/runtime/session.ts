import { randomUUID } from 'node:crypto'
import type { AgentName } from './discovery.ts'
import type { TurnContext } from './assistant.ts'
import { citations } from '../brain.ts'

/** A terminal agent, or `anthropic`: the ordinary-use API agent. */
export type BackendName = AgentName | 'anthropic'

export type BackendEvent =
  | { type: 'message'; text: string }
  | { type: 'interrupted'; reason?: string }
  | { type: 'error'; message: string }
  | { type: 'tool'; name: string; ok: boolean; text?: string }

export type SessionBackend = {
  /** `sessionId` names the conversation this backend serves (the tmux backend's session name and `GOLEM_SESSION`). */
  start(emit: (event: BackendEvent) => void, sessionId: string): Promise<void>
  /** `context` is the sender of this message, when the server accepted it from a person. */
  send(text: string, context?: TurnContext): Promise<void>
  shutdown(): Promise<void>
  interrupt?(): Promise<void>
  /** Called instead of `shutdown` when the server stops: a backend that outlives the server keeps running. */
  detach?(): Promise<void>
  /** Where to find or resume the agent after a server restart; saved with the conversation. */
  harnessRef?(): unknown
  /** Conversation state a backend keeps itself, saved with the conversation and handed back on restore. */
  transcript?(): unknown
  /** The agent's live terminal screen, when the backend has one to show (the tmux backend). */
  pane?(): PaneAccess | undefined
  /** Slash commands the harness honours, and their runner; the reply is the strip's system text. */
  commands?(): SlashCommand[]
  runCommand?(line: string): Promise<string>
}

export type SlashCommand = { name: string; description: string; args?: Array<{ value: string; description: string }> }

/** One agent screen: `open` streams whole-screen frames on change until closed, `input` types one key or a literal string. */
export type PaneAccess = {
  open(onFrame: (frame: string) => void): Promise<{ close(): void }> | { close(): void }
  snapshot(): Promise<string>
  input(input: { key?: string; text?: string }): Promise<void>
}

export type SessionStatus = 'starting' | 'ready' | 'interrupted' | 'stopped' | 'failed'

export type SessionEvent = {
  sequence: number
  sessionId: string
  type: 'status' | 'user' | 'message' | 'interrupted' | 'error' | 'rebuilt' | 'tool'
  status?: SessionStatus
  text?: string
  reason?: string
  /** A tool event's operation name and whether the call succeeded. */
  name?: string
  ok?: boolean
  clientMessageId?: string
  attachments?: Array<{ id: string; name: string; size?: number }>
  /** Brain locations (`path#Lstart-Lend`) the agent cited in this message. */
  sources?: string[]
}

export class Session {
  readonly history: SessionEvent[] = []
  status: SessionStatus = 'starting'
  private readonly listeners = new Set<(event: SessionEvent) => void>()
  private sequence = 0
  private readonly pending: Array<{ text: string; context?: TurnContext; generation: number; resolve: () => void; reject: (error: Error) => void }> = []
  private active = false
  private dispatchScheduled = false
  private closed = false
  private shutdownPromise: Promise<void> | undefined
  private workerShutdownPromise: Promise<void> | undefined
  private activeReject: ((error: Error) => void) | undefined
  /** The sender of the turn now running; revocation checks it. */
  activeContext: TurnContext | undefined
  private workerStarted = false
  private persistence = Promise.resolve()
  private persistenceError: Error | undefined
  private readonly pendingReceipts = new Map<string, { event: SessionEvent; receipt: Promise<void> }>()
  private requestGeneration = 0
  private updatedAt: string | undefined = new Date().toISOString()
  readonly id: string
  readonly backend: BackendName
  /** Server-owned: set once at creation from the request's explicit build intent, never inferred. */
  readonly buildMode: boolean
  /** The account that started this conversation when the app has accounts; only it may use it. */
  readonly owner: string | undefined
  readonly worker: SessionBackend
  private readonly save?: (snapshot: SessionSnapshot) => Promise<void>

  constructor(
    backend: BackendName,
    worker: SessionBackend,
    id: string,
    buildMode = false,
    save?: (snapshot: SessionSnapshot) => Promise<void>,
    owner?: string,
  ) {
    this.id = id
    this.owner = owner
    this.backend = backend
    this.worker = worker
    this.buildMode = buildMode
    this.save = save
  }

  async start(): Promise<void> {
    try {
      await this.startWorker()
      if (this.status !== 'starting') {
        await this.closeWorker()
        throw new Error(`Session ${this.status} during startup`)
      }
      this.setStatus('ready')
    } catch (error) {
      if (this.status === 'starting') {
        this.setStatus('failed')
        this.record({ type: 'error', text: error instanceof Error ? error.message : String(error) })
      }
      await this.closeWorker()
      throw error
    }
  }

  static restore(snapshot: SessionSnapshot, worker: SessionBackend, save?: (snapshot: SessionSnapshot) => Promise<void>): Session {
    const session = new Session(snapshot.backend, worker, snapshot.id, snapshot.buildMode, save, snapshot.owner)
    session.history.push(...snapshot.history)
    session.status = snapshot.status
    session.sequence = Math.max(-1, ...snapshot.history.map((event) => event.sequence)) + 1
    session.updatedAt = snapshot.updatedAt
    // A stopped session with a harness ref was parked, not closed: its next message resumes the agent.
    session.closed = snapshot.status === 'stopped' && !snapshot.harness
    if (snapshot.active) session.recoverInterrupted()
    return session
  }

  snapshot(): SessionSnapshot {
    return { id: this.id, backend: this.backend, buildMode: this.buildMode, ...(this.owner ? { owner: this.owner } : {}), status: this.status, active: this.active, history: [...this.history, ...[...this.pendingReceipts.values()].map(({ event }) => event)], harness: this.worker.harnessRef?.(), ...(this.worker.transcript ? { transcript: this.worker.transcript() } : {}), updatedAt: this.updatedAt }
  }

  async flush(): Promise<void> {
    await this.persistence
    if (this.persistenceError) throw this.persistenceError
  }

  /** `context` stays with this message through the queue; a duplicate keeps the first one's. */
  async accept(text: string, clientMessageId: string, attachments?: SessionEvent['attachments'], context?: TurnContext): Promise<{ duplicate: boolean; completion?: Promise<void> }> {
    if (this.closed || this.status === 'starting') throw new Error(`Session ${this.status}`)
    if (!clientMessageId) throw new Error('clientMessageId is required')
    if (this.history.some((event) => event.type === 'user' && event.clientMessageId === clientMessageId)) return { duplicate: true }
    const pending = this.pendingReceipts.get(clientMessageId)
    if (pending) { await pending.receipt; return { duplicate: true } }
    if (this.status !== 'ready') this.setStatus('ready')
    const generation = this.requestGeneration
    await this.recordDurably({ type: 'user', text, clientMessageId, attachments })
    if (generation !== this.requestGeneration || this.closed || this.status !== 'ready') throw new Error(`Session ${this.status}`)
    let resolve!: () => void
    let reject!: (error: Error) => void
    const completion = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
    this.pending.push({ text, context, generation, resolve, reject })
    this.pump()
    return { duplicate: false, completion }
  }

  async send(text: string): Promise<void> {
    const accepted = await this.accept(text, randomUUID())
    await accepted.completion
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeFrom(sequence: number, listener: (event: SessionEvent) => void): () => void {
    for (const event of this.history) if (event.sequence > sequence) listener(event)
    return this.subscribe(listener)
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closed = true
    this.requestGeneration++
    this.setStatus('stopped')
    this.rejectPending(new Error('Session stopped'))
    this.shutdownPromise = this.closeWorker()
    return this.shutdownPromise
  }

  /** The agent is running: a tmux session exists for this conversation. */
  get live(): boolean { return this.workerStarted && !this.closed }

  /**
   * Kills the worker but keeps the conversation: history and the harness ref (with its resume id) stay
   * in the snapshot, and the next message resumes the agent the way a server restart does.
   */
  async park(): Promise<void> {
    if (!this.live) return
    this.requestGeneration++
    this.workerStarted = false
    this.setStatus('stopped')
    this.activeReject?.(new Error('Session parked'))
    this.rejectPending(new Error('Session parked'))
    await this.worker.shutdown()
  }

  async dispose(): Promise<void> { await (this.worker.detach ? this.worker.detach() : this.closeWorker()) }

  abandon(): void {
    if (!this.active || this.closed) return
    this.requestGeneration++
    this.setStatus('interrupted')
    this.record({ type: 'interrupted', reason: 'server restarted during this turn' })
    this.activeReject?.(new Error('Session interrupted'))
  }

  async interrupt(): Promise<void> {
    if (this.closed || this.status === 'stopped') return
    if (this.status !== 'ready') return
    this.requestGeneration++
    this.setStatus('interrupted')
    this.record({ type: 'interrupted', reason: 'interrupted by user' })
    this.activeReject?.(new Error('Session interrupted'))
    this.rejectPending(new Error('Session interrupted'))
    await this.worker.interrupt?.()
  }

  /** Server-owned rebuild-then-refresh signal; fired once after a successful build-mode turn. */
  notifyRebuilt(): void {
    if (this.closed) return
    this.record({ type: 'rebuilt' })
  }

  /** Routed through the existing error surface: visible in chat, session stays recoverable. */
  notifyBuildFailed(message: string): void {
    if (this.closed) return
    this.setStatus('failed')
    this.record({ type: 'error', text: message })
  }

  /** Also the entry for replies the agent posts itself (`golem say`). */
  receive(event: BackendEvent): void {
    if (this.closed) return
    if (event.type === 'message') { const sources = citations(event.text); this.record({ type: 'message', text: event.text, ...(sources.length ? { sources } : {}) }) }
    if (event.type === 'tool') this.record({ type: 'tool', name: event.name, ok: event.ok, text: event.text })
    if (event.type === 'interrupted') {
      const alreadyInterrupted = this.status === 'interrupted'
      if (!alreadyInterrupted) this.setStatus('interrupted')
      this.rejectPending(new Error('Session interrupted'))
      if (!alreadyInterrupted) this.record({ type: 'interrupted', reason: event.reason })
    }
    if (event.type === 'error') {
      this.setStatus('failed')
      this.rejectPending(new Error('Session failed'))
      this.record({ type: 'error', text: event.message })
    }
  }

  private pump(): void {
    if (this.active || this.dispatchScheduled || this.closed || this.status !== 'ready') return
    const next = this.pending[0]
    if (!next) return
    this.dispatchScheduled = true
    Promise.resolve()
      .then(async () => {
        this.dispatchScheduled = false
        if (next.generation !== this.requestGeneration || this.closed || this.status !== 'ready' || this.pending[0] !== next) {
          this.pump()
          return
        }
        this.pending.shift()
        this.active = true
        this.persist()
        try { await this.flush() } catch (error) {
          this.active = false
          next.reject(error instanceof Error ? error : new Error(String(error)))
          this.pump()
          return
        }
        if (next.generation !== this.requestGeneration || this.closed || this.status !== 'ready') {
          this.active = false
          next.reject(new Error(`Session ${this.status}`))
          this.pump()
          return
        }
        try {
          await this.startWorker()
          if (next.generation !== this.requestGeneration || this.closed || this.status !== 'ready') {
            this.active = false
            next.reject(new Error(`Session ${this.status}`))
            this.pump()
            return
          }
          this.activeReject = next.reject
          this.activeContext = next.context
          Promise.resolve(this.worker.send(next.text, next.context)).then(next.resolve, next.reject).finally(() => {
            this.activeReject = undefined
            this.activeContext = undefined
            this.active = false
            this.persist()
            this.pump()
          })
        } catch (error) {
          this.active = false
          next.reject(error instanceof Error ? error : new Error(String(error)))
          this.pump()
        }
      })
  }

  private rejectPending(error: Error): void {
    while (this.pending.length) this.pending.shift()?.reject(error)
  }

  private closeWorker(): Promise<void> {
    if (!this.workerShutdownPromise) this.workerShutdownPromise = Promise.resolve().then(() => this.worker.shutdown())
    return this.workerShutdownPromise
  }

  private async startWorker(): Promise<boolean> {
    if (this.workerStarted) return false
    await this.worker.start((event) => this.receive(event), this.id)
    this.workerStarted = true
    return true
  }

  private recoverInterrupted(): void {
    this.active = false
    this.status = 'interrupted'
    this.record({ type: 'status', status: 'interrupted' })
    this.record({ type: 'interrupted', reason: 'server restarted during this turn' })
  }

  private setStatus(status: SessionStatus): void {
    this.status = status
    this.record({ type: 'status', status })
  }

  private record(event: Omit<SessionEvent, 'sequence' | 'sessionId'>): void {
    const complete = { ...event, sequence: this.sequence++, sessionId: this.id }
    this.history.push(complete)
    this.updatedAt = new Date().toISOString()
    this.listeners.forEach((listener) => listener(complete))
    this.persist()
  }

  /** A user receipt is not externally visible until it is durable. */
  private async recordDurably(event: Omit<SessionEvent, 'sequence' | 'sessionId'>): Promise<void> {
    const complete = { ...event, sequence: this.sequence++, sessionId: this.id }
    this.updatedAt = new Date().toISOString()
    let resolve!: () => void
    let reject!: (error: Error) => void
    const receipt = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
    void receipt.catch(() => {})
    this.pendingReceipts.set(complete.clientMessageId!, { event: complete, receipt })
    this.persist()
    try {
      await this.flush()
      this.pendingReceipts.delete(complete.clientMessageId!)
      this.history.push(complete)
      this.listeners.forEach((listener) => listener(complete))
      resolve()
    } catch (error) {
      this.pendingReceipts.delete(complete.clientMessageId!)
      reject(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private persist(): void {
    if (!this.save || this.persistenceError) return
    const snapshot = this.snapshot()
    this.persistence = this.persistence.catch(() => {}).then(() => this.save!(snapshot))
    void this.persistence.catch((error) => {
      if (this.persistenceError) return
      this.persistenceError = error instanceof Error ? error : new Error(String(error))
      const complete = { type: 'error' as const, text: `Unable to save conversation: ${this.persistenceError.message}`, sequence: this.sequence++, sessionId: this.id }
      this.history.push(complete)
      this.listeners.forEach((listener) => listener(complete))
    })
  }
}

export type SessionSnapshot = {
  id: string
  backend: BackendName
  buildMode: boolean
  owner?: string
  status: SessionStatus
  active: boolean
  history: SessionEvent[]
  harness?: unknown
  transcript?: unknown
  updatedAt?: string
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly save: ((snapshots: SessionSnapshot[]) => Promise<void>) | undefined

  constructor(save?: (snapshots: SessionSnapshot[]) => Promise<void>) { this.save = save }

  private persist = async (): Promise<void> => this.save?.([...this.sessions.values()].map((session) => session.snapshot()))

  async start(backend: BackendName, worker: SessionBackend, buildMode = false, owner?: string): Promise<Session> {
    const session = new Session(backend, worker, randomUUID(), buildMode, this.persist, owner)
    this.sessions.set(session.id, session)
    try {
      await session.start()
      await session.flush()
      return session
    } catch (error) {
      this.sessions.delete(session.id)
      throw error
    }
  }

  get(id: string): Session | undefined { return this.sessions.get(id) }

  all(): Session[] { return [...this.sessions.values()] }

  /** The most recently active conversation among those `visible` allows; build conversations by default. */
  latest(visible: (session: Session) => boolean = (session) => session.buildMode): Session | undefined {
    let latest: Session | undefined
    for (const session of this.sessions.values()) {
      if (!visible(session)) continue
      const candidate = session.snapshot().updatedAt
      const current = latest?.snapshot().updatedAt
      if (!latest || (candidate && (!current || candidate >= current)) || (!candidate && !current)) latest = session
    }
    return latest
  }

  restore(snapshots: SessionSnapshot[], createWorker: (snapshot: SessionSnapshot) => SessionBackend): void {
    for (const snapshot of snapshots) this.sessions.set(snapshot.id, Session.restore(snapshot, createWorker(snapshot), this.persist))
  }

  /**
   * One agent per window: the app's tmux session has a `builder` window and a `chat` window, and a
   * terminal-agent conversation lives in the one its `buildMode` names. Parks every other terminal-agent
   * conversation of that window before another starts or resumes there.
   */
  async parkOthers(buildMode: boolean, id?: string): Promise<void> {
    await Promise.all(this.all().filter((session) => session.id !== id && session.backend !== 'anthropic' && session.buildMode === buildMode).map((session) => session.park()))
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.shutdown()))
  }

  async disposeAll(): Promise<void> {
    for (const session of this.sessions.values()) session.abandon()
    await Promise.all([...this.sessions.values()].map((session) => session.dispose()))
  }

  async flushAll(): Promise<void> { await Promise.all([...this.sessions.values()].map((session) => session.flush())) }

  async shutdown(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Unknown session ${id}`)
    await session.shutdown()
  }
}
