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
}

export type SessionStatus = 'starting' | 'ready' | 'interrupted' | 'stopped' | 'failed'

export type SessionEvent = {
  sequence: number
  sessionId: string
  type: 'status' | 'user' | 'message' | 'interrupted' | 'error'
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
  readonly id: string
  readonly backend: AgentName
  private readonly worker: SessionBackend

  constructor(
    backend: AgentName,
    worker: SessionBackend,
    id: string,
  ) {
    this.id = id
    this.backend = backend
    this.worker = worker
  }

  async start(): Promise<void> {
    try {
      await this.worker.start((event) => this.receive(event))
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

  send(text: string): Promise<void> {
    if (this.closed || (this.status !== 'ready' && this.status !== 'interrupted')) {
      return Promise.reject(new Error(`Session ${this.status}`))
    }
    if (this.status === 'interrupted') this.setStatus('ready')
    return new Promise((resolve, reject) => {
      this.pending.push({ text, resolve, reject })
      this.pump()
    })
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closed = true
    this.setStatus('stopped')
    this.rejectPending(new Error('Session stopped'))
    this.shutdownPromise = this.closeWorker()
    return this.shutdownPromise
  }

  private receive(event: BackendEvent): void {
    if (this.closed) return
    if (event.type === 'message') this.record({ type: 'message', text: event.text })
    if (event.type === 'interrupted') {
      this.setStatus('interrupted')
      this.rejectPending(new Error('Session interrupted'))
      this.record({ type: 'interrupted', reason: event.reason })
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
      .then(() => {
        this.dispatchScheduled = false
        if (this.closed || this.status !== 'ready' || this.pending[0] !== next) {
          this.pump()
          return
        }
        this.pending.shift()
        this.active = true
        this.record({ type: 'user', text: next.text })
        Promise.resolve()
          .then(() => this.worker.send(next.text))
          .then(next.resolve, next.reject)
          .finally(() => {
            this.active = false
            this.pump()
          })
      })
  }

  private rejectPending(error: Error): void {
    while (this.pending.length) this.pending.shift()?.reject(error)
  }

  private closeWorker(): Promise<void> {
    if (!this.workerShutdownPromise) this.workerShutdownPromise = Promise.resolve().then(() => this.worker.shutdown())
    return this.workerShutdownPromise
  }

  private setStatus(status: SessionStatus): void {
    this.status = status
    this.record({ type: 'status', status })
  }

  private record(event: Omit<SessionEvent, 'sequence' | 'sessionId'>): void {
    const complete = { ...event, sequence: this.sequence++, sessionId: this.id }
    this.history.push(complete)
    this.listeners.forEach((listener) => listener(complete))
  }
}

export class SessionManager {
  private nextId = 1
  private readonly sessions = new Map<string, Session>()

  async start(backend: AgentName, worker: SessionBackend): Promise<Session> {
    const session = new Session(backend, worker, `session-${this.nextId++}`)
    this.sessions.set(session.id, session)
    try {
      await session.start()
      return session
    } catch (error) {
      this.sessions.delete(session.id)
      throw error
    }
  }

  get(id: string): Session | undefined { return this.sessions.get(id) }

  async shutdown(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Unknown session ${id}`)
    await session.shutdown()
  }
}
