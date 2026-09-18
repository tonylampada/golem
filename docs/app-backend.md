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

Optional. When the file exists it must default-export an `AppServerModule`:

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
type Principal = { kind: 'anonymous' } | { kind: 'user'; id: string; name: string; roles: string[]; groups: string[]; session?: string }
type OperationContext = { principal; via; records: RecordStore; files: FileStore; permits(record: Row): Promise<boolean> }
```

- **One invoke path.** HTTP (`POST /api/app/operations/<name>`), the raw file routes and in-process agent tools (`app.agentTools(principal)`) all call the same `invoke`: validate input, load the `record` the operation names, `authorize`, run, validate output.
- **Principal** comes from the server, never from request input: local accounts when `accounts` is configured (see below), else `resolvePrincipal`. Without either, every caller is `anonymous` and `authorize` defaults to allowing everything: the local single-person mode existing apps run in.
- **authorize** runs once per call with the target `record` (or `null`), and again per row for `records.list` and `files.list`, where `false` hides the row. App operations that return lists filter with `context.permits(row)`; `context.records` and `context.files` are unfiltered.
- **Builtin operations** back the adapters and go through the same hook: `records.list|get|create|update|remove`, `files.list|upload|read|caption|remove`. File metadata lives in the internal `_files` collection, so `authorize` sees it as `record` for file reads and writes.

## Knowledge files

Markdown the app keeps in its own folders, committed to Git with the code. Opt in from `src/server/index.ts`; only trusted server code names the folders:

```ts
export default {
  knowledge: { handbook: 'knowledge' }, // root name → directory inside the app
  authorize: ({ operation, principal, record }) =>
    !operation.startsWith('knowledge.') || !record?.path?.startsWith('staff/') || principal.groups.includes('staff'),
} satisfies AppServerModule
```

That adds four operations on the usual invoke path. `authorize` sees `record = { id: '<root>/<path>', root, path }` on every call, including for a file not created yet, and again per file for `list` and `search`, where `false` hides it.

| Operation | Input | Result |
| --- | --- | --- |
| `knowledge.list` | `{ root, folder? }` | `{ rows: [{ id: path, path, title, type, version }] }` |
| `knowledge.search` | `{ root, text, limit? }` | `[{ path, line, text }]`, lines are 1-based |
| `knowledge.read` | `{ root, path }` | `{ id: path, root, path, body, version, sha256, type, title }` |
| `knowledge.write` | `{ root, path, body, expectedVersion }` | the file as read; `expectedVersion: 0` creates |

- **Paths** are relative `.md` paths. `..`, hidden segments, absolute paths and backslashes are refused. Nothing between the app root and a file may be a symlink, the configured root included, and a file with a second hard link is refused, so each file has exactly one path. File text is data for the reader and the agent, never instructions to Golem.
- **Versions**: `version` counts the contents Golem has seen, kept in the internal `_knowledge` collection. An edit made on disk shows up as a new version on the next read or save. A write sent with an older version is refused with `VersionConflictError` carrying the current file, so nothing is overwritten.
- **Limit**: Golem's own writes are serialized per file and the disk bytes are compared again right before an atomic rename. An editor outside Golem is not locked: a save from it that lands in that last instant is overwritten. One server process per app.
- `type` and `title` come from the file's frontmatter (see [the knowledge recipe](knowledge.md)); `title` falls back to the first `#` heading, then the file name.

In the browser, `knowledge` from `golem-kit/client` is a golem-ui `RecordsAdapter`: `collection` is the root name, `id` the path, `body` the text. Use it with `Editor` (versioned saves; a conflicting save is merged line by line) and with `RecordList` for navigation:

```tsx
<Editor config={{ collection: 'handbook', id: 'guides/opening.md' }} adapters={{ records: knowledge, clock }} />
```

## Showing a source in the person's view

An agent can offer to open a knowledge file with a passage highlighted. The person accepts or dismisses the offer; nothing moves until they accept, and only the view where they accepted moves.

- **Conversations** belong to the agent runtime. It installs `app.views.useConversations({ owner(request, principal), owns(conversation, owner) })`: `owner` derives a trusted key from the real request and its server-resolved principal (an account id, or a key for the runtime's own browser cookie, which is how anonymous visitors are told apart), `null` to refuse; `owns` says whether that key owns the conversation. Until they are installed, no view opens and no offer is made.
- **View**: each browser tab showing a conversation calls `openView(conversation, listener)` from `golem-kit/client`. The server issues an unguessable view id bound to the tab's principal and sign-in session, its owner key and that conversation. Every later call on the view checks all three again.
- **Message**: before accepting a chat message that names a view, the runtime calls `app.views.bound(view, { principal, owner, conversation })` and refuses the message when it is `false`.
- **Offer**: the runtime builds the agent's tools with `app.agentTools(principal, { owner, conversation, view })`, `view` being the one the message came from. With knowledge configured, this adds `view.actions` (the catalog, no data) and `view.request { action: 'source.open', input: { root, path, quote? | line?, endLine? } }`; the same call is `app.views.request({ principal, owner, conversation, view }, action, input)`. The server reads the file as the principal first; a denied or missing file refuses with the same `Cannot open that source`. The offer `{ id, conversation, input: { root, path, line, endLine } }` goes to that one view. Without `view` it is only returned (`delivered: false`) for the chat to show.
- **Answer**: `answer(offer, true)` from the view checks the person and the file again, then sends `apply` to that view only. If the file changed since the offer, the offered lines are found again where they now are; if they are gone, the answer fails with `VersionConflictError` and the agent has to offer again. Consent is per offer; an unanswered offer expires after ten minutes, and a closed tab's view is dropped. Render the file with `Editor` and move to `line`–`endLine`. `apply` carries the file `version` those lines were counted in; accepting may be what notices a change on disk, so give `Editor` the `focus` once the file it shows has that version, or the passage is marked in the text it is about to replace.

## Accounts

Optional local accounts: email and password, server sessions, roles and groups. Without `accounts` in `golem.config.ts` the app stays anonymous and nobody signs in.

```ts
export default {
  title: 'Field Notes',
  accounts: {
    guests: false,       // default: signed-out visitors see only the sign-in screen
    allowSignUp: false,  // default: people join through invite links
    roles: [             // golem-ui Auth roles; ids are unique
      { id: 'member', label: 'Member' },
      { id: 'builder', label: 'Builder' },
      { id: 'admin', label: 'Admin', manages: true },
    ],
  },
  origin: 'https://notes.example.test', // only when served behind a proxy or HTTPS; see below
}
```

The roles above are the default. A role with `manages: true` may invite, change roles and groups, remove members, and build. The `builder` role may build. Every other role is for the app's own `authorize`. At least one role must manage, and the last member holding one cannot be demoted or removed. An invite carries its role. A sign-up without one (`allowSignUp: true`) gets the first role that neither manages nor is `builder`, whatever the order.

- **guests: false**: `invoke` refuses `anonymous` with `UnauthorizedError` on every path (HTTP, agent tools, server code). Signed-out `/api/app/*` calls, the change stream included, answer 401, and the shell shows golem-ui's sign-in screen.
- **guests: true**: signed-out callers run as `anonymous` through `authorize`. The default `authorize` allows everything, so write one that refuses what guests may not do.
- **Policy** stays in `authorize`: check `principal.roles`, `principal.groups` and `record`. Without an `authorize`, every signed-in member may do everything.
- **Build mode** needs a signed-in member who may build; `/api/runtime` and every `/api/sessions` route answer 401 or 403 to anyone else. A build conversation belongs to the member who started it. Conversations saved before accounts were enabled are visible to managers only. Losing build access, or signing out everywhere, interrupts a running build turn.
- **Managing**: managers get a Members button in the shell: golem-ui's member list for invites, roles and removal, plus a groups editor. Apps can use `identity` and `setGroups` from `golem-kit/client`.
- **Identity in the UI**: `identity` from `golem-kit/client` is golem-ui's `IdentityAdapter`. Pass it to `Auth.Guard` or `Timeline`. It exposes nothing a server rule trusts.

### First admin and recovery

When the store has no account yet, `./golem dev` prints a one-use admin invite link that expires in 24 hours. Open it and sign up. There are no default credentials. A running app never creates another admin link by itself. If every admin is locked out, stop the server and run `GOLEM_ADMIN_INVITE=1 ./golem dev`. It prints a fresh admin invite link to the terminal only. Anyone who can start the server already owns `.golem/data`.

### Agents and jobs

- `app.agentTools(principal)` refreshes the principal before every call. A principal with a `session` works only while that browser session is live; after sign-out its calls fail with `UnauthorizedError` and never fall back to anonymous.
- Server-owned work that acts for a person (a scheduled job) stores the account id and calls `app.resolveAccount(id)` on every run. It gets the current roles and groups, no session, and `ForbiddenError` once the account is removed. Nothing a browser sends becomes a principal.

### Security boundary

- Passwords are hashed with Node's scrypt and a random salt.
- The session cookie is a random 256-bit token. It is `HttpOnly` and `SameSite=Lax`, is `Secure` when `origin` is https, and expires after 14 days. The server stores only its SHA-256 in the reserved `_sessions` collection. Sign-out and member removal delete it.
- Accounts, sessions and invites live in reserved `_` collections. The records operations refuse those collections, and the change stream never names them.
- Five failed sign-ins lock that email, and separately that client address, for 15 minutes.
- Browser writes must come from this origin. Without `origin`, the `Origin` header must match the `Host` header. Behind a proxy, set `origin` to the public origin; then it is the only one accepted. Forwarding headers such as `X-Forwarded-For` are never read, so behind a proxy the per-address lockout counts the proxy's address.
- This protects one app's data between people who use it. It is not a hosted identity provider: there is no email verification, password reset (a manager removes and re-invites), external sign-in or two-factor. Server code and anyone with the data directory can read everything.

## Errors

Throw these from `golem-kit/server`; the HTTP status and the browser error follow from the name.

| Error | Status | Meaning |
| --- | --- | --- |
| `InvalidError` | 400 | Bad input, name, id, folder or path segment |
| `UnauthorizedError` | 401 | Not signed in, or the session ended |
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
