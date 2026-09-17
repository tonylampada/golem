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
  private operation: Promise<void> = Promise.resolve()
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
      this.setStatus('ready')
    } catch (error) {
      this.setStatus('failed')
      this.record({ type: 'error', text: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  send(text: string): Promise<void> {
    const action = this.operation.then(async () => {
      if (this.status === 'stopped' || this.status === 'failed') throw new Error(`Session ${this.status}`)
      this.record({ type: 'user', text })
      await this.worker.send(text)
    })
    this.operation = action.catch(() => {})
    return action
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async shutdown(): Promise<void> {
    if (this.status === 'stopped') return
    await this.operation
    await this.worker.shutdown()
    this.setStatus('stopped')
  }

  private receive(event: BackendEvent): void {
    if (event.type === 'message') this.record({ type: 'message', text: event.text })
    if (event.type === 'interrupted') {
      this.setStatus('interrupted')
      this.record({ type: 'interrupted', reason: event.reason })
    }
    if (event.type === 'error') {
      this.setStatus('failed')
      this.record({ type: 'error', text: event.message })
    }
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
