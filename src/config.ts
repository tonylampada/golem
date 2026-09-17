import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type AppConfig = { host: string; port: number }

export async function loadAppConfig(): Promise<AppConfig> {
  const path = resolve(process.cwd(), 'golem.config.ts')
  let value: unknown
  try {
    value = (await import(pathToFileURL(path).href)).default
  } catch (error) {
    throw new Error(`Cannot load golem.config.ts: ${message(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('golem.config.ts must default-export an object')
  }
  const configured = value as { host?: unknown; port?: unknown }
  const host: unknown = configured.host ?? '127.0.0.1'
  const port: unknown = configured.port ?? 3000
  if (typeof host !== 'string' || !host.trim()) {
    throw new Error('golem.config.ts host must be a nonempty string')
  }
  if (host === '0.0.0.0') {
    throw new Error('golem.config.ts host must not be 0.0.0.0')
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('golem.config.ts port must be an integer from 1 to 65535')
  }
  return { host, port }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function serverUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`
}
