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
    session.closed = snapshot.status === 'stopped'
    if (snapshot.active) session.recoverInterrupted()
    return session
  }

  snapshot(): SessionSnapshot {
    return { id: this.id, backend: this.backend, buildMode: this.buildMode, status: this.status, active: this.active, history: this.history, threadId: this.worker.threadId?.() }
  }

  async flush(): Promise<void> {
    await this.persistence
    if (this.persistenceError) throw this.persistenceError
  }

  send(text: string): Promise<void> {
    if (this.closed || (this.status !== 'ready' && this.status !== 'interrupted' && this.status !== 'failed')) {
      return Promise.reject(new Error(`Session ${this.status}`))
    }
    if (this.status === 'interrupted' || this.status === 'failed') this.setStatus('ready')
    return new Promise((resolve, reject) => {
      this.pending.push({ text, resolve, reject })
      this.pump()
    })
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
    this.setStatus('stopped')
    this.rejectPending(new Error('Session stopped'))
    this.shutdownPromise = this.closeWorker()
    return this.shutdownPromise
  }

  async dispose(): Promise<void> { await this.closeWorker() }

  abandon(): void {
    if (!this.active || this.closed) return
    this.setStatus('interrupted')
    this.record({ type: 'interrupted', reason: 'server restarted during this turn' })
    this.activeReject?.(new Error('Session interrupted'))
  }

  async interrupt(): Promise<void> {
    if (this.closed || this.status === 'stopped') return
    if (this.status !== 'ready') return
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
        this.record({ type: 'user', text: next.text })
        if (this.closed || this.status !== 'ready') {
          this.active = false
          next.reject(new Error(`Session ${this.status}`))
          this.pump()
          return
        }
        try {
          await this.startWorker()
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

  private async startWorker(): Promise<void> {
    if (this.workerStarted) return
    await this.worker.start((event) => this.receive(event))
    this.workerStarted = true
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
    this.listeners.forEach((listener) => listener(complete))
    this.persist()
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
