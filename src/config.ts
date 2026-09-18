import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Browser-visible settings: never put secrets in golem.config.ts. */
export type AppConfig = { host: string; port: number; storage: 'jsonl' | 'sqlite' }

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
  const configured = value as { host?: unknown; port?: unknown; storage?: unknown }
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
  return { host, port, storage }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function serverUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`
}
