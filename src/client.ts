/**
 * golem-kit/client: the browser binding. golem-ui `Records` and `Files` adapters plus `invoke`,
 * all over the app server's HTTP routes — no storage driver or server module reaches the bundle.
 */
import { fileId, RecordRefusedError, VersionConflictError, type FileRef, type FilesAdapter, type RecordsAdapter } from 'golem-ui'

/** Calls an app operation by name, as the signed-in principal the server resolves. */
export function invoke<T = unknown>(operation: string, input: unknown = {}): Promise<T> {
  return call<T>(fetch(`/api/app/operations/${encodeURIComponent(operation)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }))
}

async function call<T>(request: Promise<Response>): Promise<T> {
  const response = await request
  const body = await response.json().catch(() => ({ error: `${response.status} ${response.statusText}` })) as { result?: T; error?: string; name?: string; current?: Record<string, unknown>; fields?: Array<{ field: string; message: string }> }
  if (response.ok) return body.result as T
  if (body.name === 'VersionConflictError') throw new VersionConflictError(body.error ?? 'Changed since it was read', body.current ?? null)
  if (body.name === 'RecordRefusedError') throw new RecordRefusedError(body.error ?? 'Refused', body.fields ?? [])
  throw Object.assign(new Error(body.error ?? `Request failed (${response.status})`), { name: body.name ?? 'Error', status: response.status })
}

const listeners = new Map<string, Set<() => void>>()
let changes: EventSource | undefined

function watch(collection: string, listener: () => void): () => void {
  const set = listeners.get(collection) ?? new Set()
  listeners.set(collection, set.add(listener))
  changes ??= Object.assign(new EventSource('/api/app/changes'), {
    onmessage: (event: MessageEvent) => listeners.get((JSON.parse(event.data) as { collection: string }).collection)?.forEach((one) => one()),
  })
  return () => {
    set.delete(listener)
    if ([...listeners.values()].every((one) => one.size === 0)) { changes?.close(); changes = undefined }
  }
}

export const records: RecordsAdapter = {
  list: (collection, query) => invoke('records.list', { collection, query }),
  get: (collection, id) => invoke('records.get', { collection, id }),
  create: (collection, data) => invoke('records.create', { collection, data }),
  update: (collection, id, patch, options) => invoke('records.update', { collection, id, patch, ...options }),
  remove: async (collection, id) => { await invoke('records.remove', { collection, id }) },
  subscribe: watch,
}

export const files: FilesAdapter = {
  async upload(file, { folder, onProgress }) {
    const ref = await call<FileRef>(fetch(`/api/app/files?${new URLSearchParams({ folder, name: file.name })}`, {
      method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
    }))
    onProgress?.(1)
    return ref
  },
  url: async (ref) => `/api/app/files/${encodeURIComponent(fileId(ref))}`,
  remove: async (ref) => { await invoke('files.remove', { id: fileId(ref) }) },
  list: (folder) => invoke('files.list', { folder }),
  caption: (ref, caption) => invoke('files.caption', { id: fileId(ref), caption }),
  subscribe: (_folder, listener) => watch('_files', listener),
}
