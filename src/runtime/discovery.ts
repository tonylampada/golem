import { spawn } from 'node:child_process'

export type AgentName = 'claude' | 'codex'
export type ProbeStatus = 'available' | 'missing' | 'failed'

export type AgentDiscovery = {
  agent: AgentName
  executable: string
  status: ProbeStatus
  runnable?: boolean
  detail?: string
}

export type Probe = (executable: string, args: string[], timeoutMs: number) => Promise<ProbeResult>

export type ProbeResult = {
  status: 'available' | 'missing' | 'failed'
  detail?: string
}

const executables: Record<AgentName, string> = { claude: 'claude', codex: 'codex' }

export function probeExecutable(executable: string, args = ['--version'], timeoutMs = 2_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true })
    let settled = false
    let timedOut = false
    let timeoutTimer: NodeJS.Timeout
    let killTimer: NodeJS.Timeout | undefined
    let settleTimer: NodeJS.Timeout | undefined
    const finish = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      if (settleTimer) clearTimeout(settleTimer)
      resolve(result)
    }
    timeoutTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
        settleTimer = setTimeout(() => finish({ status: 'failed', detail: 'timed out' }), 500)
      }, 100)
    }, timeoutMs)
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT'
        ? { status: 'missing' }
        : { status: 'failed', detail: error.message })
    })
    child.once('exit', (code, signal) => {
      finish(timedOut
        ? { status: 'failed', detail: 'timed out' }
        : code === 0
          ? { status: 'available' }
          : { status: 'failed', detail: signal ? `terminated by ${signal}` : `exited with code ${code}` })
    })
  })
}

/**
 * Runnable means a turn can start: Codex needs only its executable; Claude Code also needs
 * `claude auth status` to exit 0 (it exits 1 when signed out). Neither probe starts an agent turn.
 */
export async function discoverAgents(
  probe: Probe = probeExecutable,
  timeoutMs = 2_000,
): Promise<AgentDiscovery[]> {
  return Promise.all((Object.entries(executables) as [AgentName, string][]).map(async ([agent, executable]) => {
    const found = await probe(executable, ['--version'], timeoutMs)
    if (agent !== 'claude' || found.status !== 'available') return { agent, executable, runnable: found.status === 'available', ...found }
    const auth = await probe(executable, ['auth', 'status'], timeoutMs)
    return auth.status === 'available'
      ? { agent, executable, runnable: true, ...found }
      : { agent, executable, runnable: false, ...found, detail: 'not signed in; run `claude auth login`' }
  }))
}

export type RuntimeState =
  | { kind: 'setup'; explanation: string }
  | { kind: 'ready'; backend: AgentName }
  | { kind: 'choice-required'; available: AgentName[]; explanation: string }

export function runtimeState(discoveries: AgentDiscovery[]): RuntimeState {
  const available = discoveries
    .filter(({ status, runnable = true }) => status === 'available' && runnable)
    .map(({ agent }) => agent)
  if (available.length === 0) {
    return { kind: 'setup', explanation: 'Install and sign in to Claude Code or Codex to start an agent session.' }
  }
  if (available.length === 1) return { kind: 'ready', backend: available[0] }
  return {
    kind: 'choice-required',
    available,
    explanation: 'Both Claude Code and Codex are available; choose one before starting a session.',
  }
}
