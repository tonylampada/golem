import { randomUUID } from 'node:crypto'
import type { AgentName } from './discovery.ts'

export type BackendEvent =
  | { type: 'message'; text: string }
  | { type: 'interrupted'; reason?: string }
  | { type: 'error'; message: string }

/** The runtime contract only; Claude/Codex process bridging is intentionally not implemented yet. */
export type SessionBackend = {
  start(emit: (event: BackendEvent) => void): Promise<void>
  send(text: string): Promise<void>
  shutdown(): Promise<void>
  interrupt?(): Promise<void>
  threadId?(): string | undefined
}

export type SessionStatus = 'starting' | 'ready' | 'interrupted' | 'stopped' | 'failed'

export type SessionEvent = {
  sequence: number
  sessionId: string
  type: 'status' | 'user' | 'message' | 'interrupted' | 'error' | 'rebuilt'
  status?: SessionStatus
  text?: string
  reason?: string
  clientMessageId?: string
  attachments?: Array<{ id: string; name: string; size?: number }>
}

export class Session {
  readonly history: SessionEvent[] = []
  status: SessionStatus = 'starting'
  private readonly listeners = new Set<(event: SessionEvent) => void>()
  private sequence = 0
  private readonly pending: Array<{ text: string; resolve: () => void; reject: (error: Error) => void }> = []
  private active = false
  private dispatchScheduled = false
  private closed = false
  private shutdownPromise: Promise<void> | undefined
  private workerShutdownPromise: Promise<void> | undefined
  private activeReject: ((error: Error) => void) | undefined
  private workerStarted = false
  private persistence = Promise.resolve()
  private persistenceError: Error | undefined
  private readonly pendingReceipts = new Map<string, { event: SessionEvent; receipt: Promise<void> }>()
  private requestGeneration = 0
  private updatedAt = new Date().toISOString()
  readonly id: string
  readonly backend: AgentName
  /** Server-owned: set once at creation from the request's explicit build intent, never inferred. */
  readonly buildMode: boolean
  private readonly worker: SessionBackend
  private readonly save?: (snapshot: SessionSnapshot) => Promise<void>

  constructor(
    backend: AgentName,
    worker: SessionBackend,
    id: string,
    buildMode = false,
    save?: (snapshot: SessionSnapshot) => Promise<void>,
  ) {
    this.id = id
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
    const session = new Session(snapshot.backend, worker, snapshot.id, snapshot.buildMode, save)
    session.history.push(...snapshot.history)
    session.status = snapshot.status
    session.sequence = Math.max(-1, ...snapshot.history.map((event) => event.sequence)) + 1
    session.updatedAt = snapshot.updatedAt ?? session.updatedAt
    session.closed = snapshot.status === 'stopped'
    if (snapshot.active) session.recoverInterrupted()
    return session
  }

  snapshot(): SessionSnapshot {
    return { id: this.id, backend: this.backend, buildMode: this.buildMode, status: this.status, active: this.active, history: [...this.history, ...[...this.pendingReceipts.values()].map(({ event }) => event)], threadId: this.worker.threadId?.(), updatedAt: this.updatedAt }
  }

  async flush(): Promise<void> {
    await this.persistence
    if (this.persistenceError) throw this.persistenceError
  }

  async accept(text: string, clientMessageId: string, attachments?: SessionEvent['attachments']): Promise<{ duplicate: boolean; completion?: Promise<void> }> {
    if (this.closed || (this.status !== 'ready' && this.status !== 'interrupted' && this.status !== 'failed')) {
      throw new Error(`Session ${this.status}`)
    }
    if (!clientMessageId) throw new Error('clientMessageId is required')
    if (this.history.some((event) => event.type === 'user' && event.clientMessageId === clientMessageId)) return { duplicate: true }
    const pending = this.pendingReceipts.get(clientMessageId)
    if (pending) { await pending.receipt; return { duplicate: true } }
    if (this.status === 'interrupted' || this.status === 'failed') this.setStatus('ready')
    const generation = this.requestGeneration
    await this.recordDurably({ type: 'user', text, clientMessageId, attachments })
    if (generation !== this.requestGeneration || this.closed || this.status !== 'ready') throw new Error(`Session ${this.status}`)
    let resolve!: () => void
    let reject!: (error: Error) => void
    const completion = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
    this.pending.push({ text, resolve, reject })
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

  async dispose(): Promise<void> { await this.closeWorker() }

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

  private receive(event: BackendEvent): void {
    if (this.closed) return
    if (event.type === 'message') this.record({ type: 'message', text: event.text })
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
        if (this.closed || this.status !== 'ready' || this.pending[0] !== next) {
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
        if (this.closed || this.status !== 'ready') {
          this.active = false
          next.reject(new Error(`Session ${this.status}`))
          this.pump()
          return
        }
        try {
          await this.startWorker()
          if (this.closed || this.status !== 'ready') {
            this.active = false
            next.reject(new Error(`Session ${this.status}`))
            this.pump()
            return
          }
          this.activeReject = next.reject
          Promise.resolve(this.worker.send(next.text)).then(next.resolve, next.reject).finally(() => {
            this.activeReject = undefined
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
    await this.worker.start((event) => this.receive(event))
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
  backend: AgentName
  buildMode: boolean
  status: SessionStatus
  active: boolean
  history: SessionEvent[]
  threadId?: string
  updatedAt?: string
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly save: ((snapshots: SessionSnapshot[]) => Promise<void>) | undefined

  constructor(save?: (snapshots: SessionSnapshot[]) => Promise<void>) { this.save = save }

  private persist = async (): Promise<void> => this.save?.([...this.sessions.values()].map((session) => session.snapshot()))

  async start(backend: AgentName, worker: SessionBackend, buildMode = false): Promise<Session> {
    const session = new Session(backend, worker, randomUUID(), buildMode, this.persist)
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

  latest(): Session | undefined {
    return [...this.sessions.values()]
      .filter((session) => session.buildMode)
      .sort((left, right) => right.snapshot().updatedAt!.localeCompare(left.snapshot().updatedAt!))[0]
  }

  restore(snapshots: SessionSnapshot[], createWorker: (snapshot: SessionSnapshot) => SessionBackend): void {
    for (const snapshot of snapshots) this.sessions.set(snapshot.id, Session.restore(snapshot, createWorker(snapshot), this.persist))
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
