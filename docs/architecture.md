# App architecture

How a Golem app keeps its knowledge in the right place, and how `./golem lint` checks the few
boundaries Golem cares about.

## Knowledge ownership

Each piece of knowledge has one owner:

- **The app** owns its business: `docs/domain.md` (the app's DNA) and the code under `src/`.
  Concepts, operations, rules, and decisions specific to this app live only here.
- **golem-kit** owns the shell, CLI, runtime, and this generic guidance. Read it from the
  installed package; the app keeps pointers to it, never copies.
- **golem-ui** owns components and their adapter contracts. Its `README.md` is the reference.

When a change needs reusable framework or UI-kit behavior, propose it for that package instead
of growing a private copy inside the app.

## DNA and code change together

`docs/domain.md` records the app's purpose, concepts, operations, and decisions. When a change
adds or alters a concept, an operation, or a rule, update the DNA in the same change as the
code. Discuss changes to an important decision with the person before implementing them.

## Layout

Golem assumes only this much structure under `src/`:

| Path | Holds | May import |
| --- | --- | --- |
| `src/` (outside `src/server/`) | Browser UI and domain logic | `src/shared/`, browser-safe packages |
| `src/shared/` | Plain types and values used by both sides | Nothing from `src/server/` |
| `src/server/` | Backend modules | Anything except storage drivers |
| `src/server/persistence/` | Storage adapters | Storage drivers |

Everything else, such as module names and folder depth, is the app's choice. Record choices that
matter in `docs/domain.md`.

## Deliberate seams

The UI reaches the backend through the app's declared API, never by importing server modules.
Types the UI and server share go in `src/shared/`, so type-only imports from `src/server/` are
refused too. Components receive data through golem-ui's `config` plus `adapters` shape rather
than opening their own data connections. Storage drivers stay behind persistence adapters, so the
rest of the app depends on the adapter's contract, not on a database client.

## Checking the architecture

`./golem lint` runs ESLint with the app's `eslint.config.mjs`. The generated file uses the shared
config:

```js
import golem from 'golem-kit/eslint'

export default golem()
```

It reports:

- storage driver imports (`pg`, `mysql2`, `better-sqlite3`, `node:sqlite`, `mongodb`, `redis`,
  and similar) outside `src/server/persistence/`;
- imports of `src/server/` modules, `golem-kit/server`, or `node:` built-ins from code outside
  `src/server/`.

These are architectural guardrails an app may adapt, not security boundaries. They read import
specifiers as written: relative paths are matched by directory name, and aliases, bare Node
built-in names such as `fs`, `require()`, and dynamic `import()` are not checked. Keep secrets on
the server and out of browser bundles regardless of what the lint reports.

## Adapting or disabling a rule

Change a rule deliberately and say why in the same change. Pass options to `golem()`:

```js
import golem, { golemDrivers } from 'golem-kit/eslint'

export default golem({
  server: 'src/backend',              // backend directory; false disables the server boundary
  persistence: 'src/backend/storage', // storage adapter directory
  drivers: [...golemDrivers, 'example-db'], // false disables the driver boundary
  serverModules: ['golem-kit/server'],       // packages only the server may import
})
```

For a single justified exception, use ESLint's standard directive with a reason:

```ts
// eslint-disable-next-line no-restricted-imports -- migration script reads the legacy database directly
import pg from 'pg'
```

To turn every Golem check off, replace `golem()` with your own ESLint config, such as
`export default []`. An app created before this config existed can opt in by adding the `eslint.config.mjs` above.
