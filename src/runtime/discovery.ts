import { spawn } from 'node:child_process'

export type AgentName = 'claude' | 'codex'
export type ProbeStatus = 'available' | 'missing' | 'failed'

export type AgentDiscovery = {
  agent: AgentName
  executable: string
  status: ProbeStatus
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
    const finish = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ status: 'failed', detail: 'timed out' })
    }, timeoutMs)
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT'
        ? { status: 'missing' }
        : { status: 'failed', detail: error.message })
    })
    child.once('exit', (code, signal) => {
      finish(code === 0
        ? { status: 'available' }
        : { status: 'failed', detail: signal ? `terminated by ${signal}` : `exited with code ${code}` })
    })
  })
}

export async function discoverAgents(
  probe: Probe = probeExecutable,
  timeoutMs = 2_000,
): Promise<AgentDiscovery[]> {
  return Promise.all((Object.entries(executables) as [AgentName, string][]).map(async ([agent, executable]) => ({
    agent,
    executable,
    ...(await probe(executable, ['--version'], timeoutMs)),
  })))
}

export type RuntimeState =
  | { kind: 'setup'; explanation: string }
  | { kind: 'ready'; backend: AgentName }
  | { kind: 'choice-required'; available: AgentName[]; explanation: string }

export function runtimeState(discoveries: AgentDiscovery[]): RuntimeState {
  const available = discoveries.filter(({ status }) => status === 'available').map(({ agent }) => agent)
  if (available.length === 0) {
    return { kind: 'setup', explanation: 'Install Claude Code or Codex to start an agent session.' }
  }
  if (available.length === 1) return { kind: 'ready', backend: available[0] }
  return {
    kind: 'choice-required',
    available,
    explanation: 'Both Claude Code and Codex are available; choose one before starting a session.',
  }
}
