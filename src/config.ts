import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Browser-visible settings: never put secrets in golem.config.ts. */
export type AppConfig = { host: string; port: number; storage: 'jsonl' | 'sqlite'; origin?: string; accounts?: AccountsConfig }

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
  const configured = value as { host?: unknown; port?: unknown; storage?: unknown; origin?: unknown; accounts?: unknown }
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
  return { host, port, storage, ...(origin === undefined ? {} : { origin }), ...(configured.accounts === undefined ? {} : { accounts: accounts(configured.accounts) }) }
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
