import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { toolNameProblem } from './runtime/tool-names.ts'

/** Browser-visible settings: never put secrets in golem.config.ts. */
export type AppConfig = { host: string; port: number; storage: 'jsonl' | 'sqlite'; origin?: string; accounts?: AccountsConfig; agents?: AgentsConfig; brain?: boolean; chat?: ChatConfig }
/**
 * Normal-mode chat, the app's rule: `false` (or absent) means no chat column outside builder mode.
 * `anthropic` is the API agent (same shape as `agents.ordinary`, which it fills); `tmux` is a
 * terminal agent in the `chat` window of the app's tmux session, briefed from `docs/chat.md`.
 */
export type ChatConfig = { provider: 'anthropic' } | { provider: 'tmux'; agent?: 'codex' | 'claude' }
/** `brain: true` serves the app's `brain/` folder read-only and mounts the Brain reader beside the app. */

/**
 * `builder` is the agent build mode starts with. `ordinary` turns on everyday chat: an API agent
 * whose only tools are the listed app operations, run as the person chatting.
 */
export type AgentsConfig = { builder?: 'codex' | 'claude'; ordinary?: OrdinaryAgentConfig }
export type OrdinaryAgentConfig = { backend: 'anthropic'; model: string; operations: string[]; collections?: string[]; roots?: string[]; instructions?: string }

/** golem-ui's Auth role shape: `manages` roles run accounts and may build; `builder` may build. */
export type AccountRole = { id: string; label: string; manages: boolean }
export type AccountsConfig = { guests: boolean; allowSignUp: boolean; roles: AccountRole[] }

const defaultRoles: AccountRole[] = [
  { id: 'member', label: 'Member', manages: false },
  { id: 'builder', label: 'Builder', manages: false },
  { id: 'admin', label: 'Admin', manages: true },
]

export async function loadAppConfig(root = process.cwd()): Promise<AppConfig> {
  const path = resolve(root, 'golem.config.ts')
  let value: unknown
  try {
    value = (await import(pathToFileURL(path).href)).default
  } catch (error) {
    throw new Error(`Cannot load golem.config.ts: ${message(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('golem.config.ts must default-export an object')
  }
  const configured = value as { host?: unknown; port?: unknown; storage?: unknown; origin?: unknown; accounts?: unknown; agents?: unknown; brain?: unknown; chat?: unknown }
  if (configured.brain !== undefined && typeof configured.brain !== 'boolean') throw new Error('golem.config.ts brain must be a boolean')
  const host: unknown = configured.host === undefined ? '127.0.0.1' : configured.host
  const port: unknown = configured.port === undefined ? 3000 : configured.port
  if (typeof host !== 'string' || !host.trim()) {
    throw new Error('golem.config.ts host must be a nonempty string')
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('golem.config.ts port must be an integer from 1 to 65535')
  }
  const storage = configured.storage ?? 'jsonl'
  if (storage !== 'jsonl' && storage !== 'sqlite') {
    throw new Error("golem.config.ts storage must be 'jsonl' or 'sqlite'")
  }
  const origin = configured.origin
  if (origin !== undefined && (typeof origin !== 'string' || !/^https?:$/.test(safeUrl(origin)?.protocol ?? '') || safeUrl(origin)?.origin !== origin)) {
    throw new Error("golem.config.ts origin must be an exact origin like 'https://notes.example.com'")
  }
  const config: AppConfig = { host, port, storage, ...(origin === undefined ? {} : { origin }), ...(configured.accounts === undefined ? {} : { accounts: accounts(configured.accounts) }), ...(configured.agents === undefined ? {} : { agents: agents(configured.agents) }), ...(configured.brain ? { brain: true } : {}) }
  if (configured.chat !== undefined && configured.chat !== false) {
    if (!configured.chat || typeof configured.chat !== 'object' || Array.isArray(configured.chat)) throw new Error('golem.config.ts chat must be false or { provider, ... }')
    const { provider, ...rest } = configured.chat as Record<string, unknown>
    if (provider === 'anthropic') {
      config.agents = { ...config.agents, ordinary: ordinaryAgent({ backend: 'anthropic', ...rest }) }
      config.chat = { provider }
    } else if (provider === 'tmux') {
      const { agent, ...unknown } = rest
      if (Object.keys(unknown).length) throw new Error(`golem.config.ts chat has unknown fields: ${Object.keys(unknown).join(', ')}`)
      if (agent !== undefined && agent !== 'codex' && agent !== 'claude') throw new Error("golem.config.ts chat.agent must be 'codex' or 'claude'")
      config.chat = { provider, ...(agent ? { agent } : {}) }
    } else throw new Error("golem.config.ts chat.provider must be 'anthropic' or 'tmux'")
  } else if (config.agents?.ordinary) config.chat = { provider: 'anthropic' }
  return config
}

function accounts(value: unknown): AccountsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('golem.config.ts accounts must be an object')
  const { guests = false, allowSignUp = false, roles = defaultRoles, ...unknown } = value as Record<string, unknown>
  if (Object.keys(unknown).length) throw new Error(`golem.config.ts accounts has unknown fields: ${Object.keys(unknown).join(', ')}`)
  if (typeof guests !== 'boolean' || typeof allowSignUp !== 'boolean') throw new Error('golem.config.ts accounts guests and allowSignUp must be booleans')
  if (!Array.isArray(roles) || !roles.length) throw new Error('golem.config.ts accounts roles must be a nonempty list')
  const parsed = roles.map((role: { id?: unknown; label?: unknown; manages?: unknown }) => {
    if (typeof role?.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(role.id) || typeof role.label !== 'string' || (role.manages !== undefined && typeof role.manages !== 'boolean')) {
      throw new Error('golem.config.ts accounts roles need { id, label, manages? }')
    }
    return { id: role.id, label: role.label, manages: role.manages === true }
  })
  if (new Set(parsed.map((role) => role.id)).size !== parsed.length) throw new Error('golem.config.ts accounts role ids must be unique')
  if (!parsed.some((role) => role.manages)) throw new Error('golem.config.ts accounts roles need one role with manages: true')
  if (allowSignUp && !parsed.some(isPlain)) throw new Error("golem.config.ts accounts allowSignUp needs a role that neither manages nor is 'builder'")
  return { guests, allowSignUp, roles: parsed }
}

function agents(value: unknown): AgentsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('golem.config.ts agents must be an object')
  const { builder, ordinary, ...unknown } = value as Record<string, unknown>
  if (Object.keys(unknown).length) throw new Error(`golem.config.ts agents has unknown fields: ${Object.keys(unknown).join(', ')}`)
  if (builder !== undefined && builder !== 'codex' && builder !== 'claude') throw new Error("golem.config.ts agents.builder must be 'codex' or 'claude'")
  return { ...(builder ? { builder } : {}), ...(ordinary === undefined ? {} : { ordinary: ordinaryAgent(ordinary) }) }
}

// Operations whose input or output is raw bytes, which a chat tool cannot carry.
const byteOperations = ['files.upload', 'files.read']

function ordinaryAgent(value: unknown): OrdinaryAgentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('golem.config.ts agents.ordinary must be an object')
  const { backend, model = 'claude-opus-5', operations, collections, roots, instructions, ...unknown } = value as Record<string, unknown>
  if (Object.keys(unknown).length) throw new Error(`golem.config.ts agents.ordinary has unknown fields: ${Object.keys(unknown).join(', ')}`)
  if (backend === 'codex' || backend === 'claude') {
    throw new Error(`golem.config.ts agents.ordinary.backend '${backend}' is not supported: a terminal agent runs with this computer account's file access, which Golem cannot limit to the listed operations. Use 'anthropic'.`)
  }
  if (backend !== 'anthropic') throw new Error("golem.config.ts agents.ordinary.backend must be 'anthropic'")
  if (typeof model !== 'string' || !model) throw new Error('golem.config.ts agents.ordinary.model must be a nonempty string')
  const names = (list: unknown, field: string) => {
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string' && item)) throw new Error(`golem.config.ts agents.ordinary.${field} must be a list of names`)
    return list as string[]
  }
  const allowed = names(operations, 'operations')
  const refused = allowed.filter((name) => byteOperations.includes(name))
  if (refused.length) throw new Error(`golem.config.ts agents.ordinary.operations cannot include ${refused.join(', ')}: chat tools carry no file bytes`)
  const problem = toolNameProblem(allowed)
  if (problem) throw new Error(`golem.config.ts agents.ordinary.operations: ${problem}`)
  if (instructions !== undefined && typeof instructions !== 'string') throw new Error('golem.config.ts agents.ordinary.instructions must be a string')
  return {
    backend, model, operations: allowed,
    ...(collections === undefined ? {} : { collections: names(collections, 'collections') }),
    ...(roots === undefined ? {} : { roots: names(roots, 'roots') }),
    ...(instructions === undefined ? {} : { instructions }),
  }
}

/** Neither manages accounts nor builds: what an open sign-up may receive. */
export const isPlain = (role: AccountRole) => !role.manages && role.id !== 'builder'

function safeUrl(value: string): URL | undefined {
  try { return new URL(value) } catch { return undefined }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function serverUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`
}
