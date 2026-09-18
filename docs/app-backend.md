# App backend

Golem serves an app's records, files and operations from the same local server as the browser shell.
Records are plain JSON values; the store adds `id`, `version`, `createdAt` and `updatedAt`.
Business rules stay in the app; this package supplies storage, the operation boundary and the browser binding.

## Where code lives

| Path | Runs in | Imports |
| --- | --- | --- |
| `src/app.tsx` and other UI files | browser | `golem-ui`, `golem-kit/client`, `src/shared/` |
| `src/shared/` | both | plain types and values only |
| `src/server/index.ts` | server | `golem-kit/server`, `src/shared/`, `src/server/**` |
| `src/server/persistence/` | server | the only place for backend-specific code (`records.native`) |

UI code reaches data only through `golem-kit/client`. Secrets come from `process.env` (loaded from `.env.local`) inside `src/server/`; `golem.config.ts` is bundled into the browser, so it holds no secrets.

## Configuration

`golem.config.ts` keeps `title`, `host` and `port` and adds one optional field:

```ts
export default { title: 'Field Notes', storage: 'sqlite' } // 'jsonl' (default) or 'sqlite'
```

Data lives under `.golem/data/`: `records/<collection>.jsonl` or `records.sqlite`, plus `files/<id>`. Switching `storage` starts from an empty store; there is no migration between the two.

- **jsonl**: one append-only log per collection, fsynced per write and compacted on load. A torn final line from a crash is dropped. One server process per app.
- **sqlite**: one `records` table of JSON documents through the built-in `node:sqlite`, queried with `json_extract`. `records.native` is the open `DatabaseSync` for real SQL in `src/server/persistence/`.

## Browser binding: `golem-kit/client`

```ts
import { files, invoke, records } from 'golem-kit/client'
<RecordList config={...} adapters={{ records }} />
<Upload config={{ folder: 'attachments' }} adapters={{ files }} />
const result = await invoke<{ message: string }>('notes.archive', { id })
```

`records` and `files` implement the golem-ui `RecordsAdapter` and `FilesAdapter`. A stale `update` (one with `expectedVersion`) rejects with golem-ui's `VersionConflictError`, which carries the current row. golem-ui's `RecordForm` sends only the changed fields and no `expectedVersion`, so two people saving the same field of one record means the last save wins; call `records.update` with `expectedVersion` yourself where that matters. `subscribe` listens to the server's change stream, so writes from any caller, the agent included, refresh open lists.

## Server module: `src/server/index.ts`

Optional. Default-export an `AppServerModule`:

```ts
import { defineOperation, z, type AppServerModule } from 'golem-kit/server'

export const archive = defineOperation({
  name: 'notes.archive',
  description: 'Archive one note so it leaves the active list.',
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), version: z.number() }),
  record: (input) => ({ collection: 'notes', id: input.id }),
  async run(input, { records }) {
    const note = await records.update('notes', input.id, { archived: true })
    return { id: note.id, version: note.version }
  },
})

export default {
  operations: [archive],
  authorize: ({ operation, record }) => !(record?.locked === true && operation !== 'records.get'),
} satisfies AppServerModule
```

Exact signatures (source: `src/operations.ts`, `src/backend/app.ts`):

```ts
type AppServerModule = {
  operations?: Operation[]
  authorize?: (request: AuthorizeRequest) => boolean | Promise<boolean>
  resolvePrincipal?: (request: IncomingMessage) => Principal | Promise<Principal>
}
type AuthorizeRequest = { operation: string; input: unknown; principal: Principal; via: 'http' | 'agent' | 'server'; record: Row | null }
type Principal = { kind: 'anonymous' } | { kind: 'user'; id: string; roles: string[] }
type OperationContext = { principal; via; records: RecordStore; files: FileStore; permits(record: Row): Promise<boolean> }
```

- **One invoke path.** HTTP (`POST /api/app/operations/<name>`), the raw file routes and in-process agent tools (`app.agentTools(principal)`) all call the same `invoke`: validate input, load the `record` the operation names, `authorize`, run, validate output.
- **Principal** comes from `resolvePrincipal` on the server, never from request input. Without one, every caller is `anonymous` and `authorize` defaults to allowing everything: the local single-person mode existing apps run in.
- **authorize** runs once per call with the target `record` (or `null`), and again per row for `records.list` and `files.list`, where `false` hides the row. App operations that return lists filter with `context.permits(row)`; `context.records` and `context.files` are unfiltered.
- **Builtin operations** back the adapters and go through the same hook: `records.list|get|create|update|remove`, `files.list|upload|read|caption|remove`. File metadata lives in the internal `_files` collection, so `authorize` sees it as `record` for file reads and writes.

## Errors

Throw these from `golem-kit/server`; the HTTP status and the browser error follow from the name.

| Error | Status | Meaning |
| --- | --- | --- |
| `InvalidError` | 400 | Bad input, name, id, folder or path segment |
| `ForbiddenError` | 403 | `authorize` returned false |
| `NotFoundError` | 404 | No such record, file or operation |
| `VersionConflictError` | 409 | `expectedVersion` no longer matches; carries `current` |
| `RecordRefusedError` | 422 | A business rule refused the write; `fields` name the controls |

Any other thrown error answers 500 with a generic message and is logged on the server.

## Server code reload

After a successful build-mode turn, the dev server rebuilds the browser, then bundles `src/server/index.ts` with every local file it imports and swaps the new operations and hooks in place. Stores, open change streams and conversations continue. Packages stay shared with the running server. If the new module fails to load or validate, the old one keeps serving and the conversation shows the error instead of refreshing. Outside build mode, restart `./golem dev` after editing server code.

## Adding a capability

1. Put shared record shapes in `src/shared/`.
2. Define the operation in `src/server/`, naming its `record` when it acts on one, and add it to `operations`.
3. Add any access rule to `authorize` in terms of `principal`, `operation` and `record`.
4. Call it from the UI with `invoke('<name>', input)`; use `records` and `files` for plain CRUD and uploads.
5. Exercise it in the browser: create, edit, reload the page, restart `./golem dev`, and confirm the data is still there.
