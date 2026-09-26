# Local command contract

Use Node.js >=22.18.0 (native TypeScript execution) and pnpm 10.28.2.
Run `pnpm install`, then `./golem help`. The executable wrapper resolves the
project-local CLI relative to itself, including when invoked from another directory.
The browser shell uses the local Vite build and the published `golem-ui` package. Before every
command, the wrapper optionally loads the app-local `.env.local` using Node's standard dotenv-file
support. Values already exported in the shell win; a missing file is ignored.

## Source resolution seam

The root wrapper explicitly selects `src/entry.mjs` relative to the wrapper's own
directory. This is the sole CLI entrypoint resolution point today; there is no
package-name lookup or resolution configuration. Generated app wrappers load `.env.local` before
selecting `GOLEM_SOURCE`, so a local checkout can be selected while keeping the app cwd. An invalid
source path fails clearly; unset it to use the installed pinned package.

The CLI imports `./dev-server.ts` relative to the wrapper. The server serves built `dist/`
files and does not resolve packages or depend on
the caller's working directory. Keep source/package selection outside this server
boundary so a hot-source workflow can select the CLI without changing HTTP startup.

## Commands

| Command | Behavior | Exit status |
| --- | --- | --- |
| `./golem help` (or `./golem`) | List all commands | 0 |
| `./golem dev` | Refresh the browser build, then serve it at the `golem.config.ts` address (default `http://127.0.0.1:3000/`) until SIGINT/SIGTERM | 0 on clean shutdown; 1 on startup failure |
| `./golem build` | Build the browser shell into `dist/` | 0 |
| `./golem lint` | Check the app's architecture rules with ESLint and `eslint.config.mjs` ([architecture guide](architecture.md)) | 0 clean; 1 violations or missing config |
| `./golem doctor` | Report local shell and backend readiness | 0 |
| `./golem say <text>` (or `--file <f>`) | From inside an agent session, post a reply into the chat that launched it | 0; 1 outside a session or when the server refuses |
| `./golem show <action> [key=value… \| --json '<input>']` | From inside an agent session, offer to open one of the app's declared screens in the person's browser | 0; 1 when nobody is looking, the action has no handler, or the input is refused |

Unknown commands exit 2, as do arguments to any command but `say` and `show`. Built assets are served directly; extensionless browser
routes fall back to `index.html`, while missing assets return 404. Malformed URLs return 400. The
default server binds to loopback on port 3000. To use another local port or a
specific tailnet address, export optional root settings from `golem.config.ts`:

```ts
export default { title: 'Golem', host: '100.64.0.10', port: 3000 }
```

`host` must be a nonempty string and `port` an integer from 1 through 65535.
Configuration, build, and bind failures are printed by `./golem dev`. Restart
the server after changing these settings.
`doctor` succeeding means its report ran, not that the full product is ready.

`src/dev-server.ts` exports `startDevServer(port = 3000, backend, stateDirectory, host = '127.0.0.1')`, resolving to a listening
Node HTTP server. It refreshes the browser build before listening; the CLI owns signal handling and output. `src/browser/app.tsx` is the
composition boundary: anonymous identity and browser navigation are explicit host adapters, while
the chat adapter connects explicit browser build-mode sessions to the chosen local Claude Code or Codex runtime.

Check types with `pnpm exec tsc --noEmit`; run the CLI/HTTP smoke check with
`node --test --test-concurrency=1 test/*.mjs` (serial because the CLI test intentionally removes
and rebuilds the shared `dist/` directory; requires port 3000).

## Generated projects

`golem-kit init` creates `package.json`, `golem.config.ts`, `tsconfig.json`, `eslint.config.mjs`,
`src/app.tsx`, `src/globals.d.ts`, `docs/domain.md` (the app's DNA template), small `AGENTS.md` and
`CLAUDE.md` pointers to the installed framework guide, and an executable `./golem`. The generated
`package.json` carries the scripts `dev`, `build`, `lint` (each one the matching `./golem` command)
and `typecheck` (`tsc --noEmit` over `tsconfig.json`), plus the `typescript`, `@types/node` and
`@types/react` devDependencies those scripts need at the versions golem-kit itself uses. Normal initialization writes the
pinned npm dependency `golem-kit@<framework version>` and installs it with pnpm, along with
the exact `golem-ui` version golem-kit uses so app code can import its components directly.
For local packed-tarball acceptance only, set `GOLEM_KIT_TARBALL=/path/to/golem-kit.tgz`.
An existing package is supported only when it already declares `golem-kit`; its
metadata is preserved. It adds `.golem/` and `.env.local` to an existing `.gitignore` without
removing its content. Other nonempty destinations are refused.

Two-checkout development:

```sh
printf '%s\n' 'GOLEM_SOURCE=/path/to/golem' > /path/to/app/.env.local
/path/to/app/golem build
/path/to/app/golem dev
```

The wrapper changes into the app first, so `src/` and `dist/` remain app-owned.
The framework checkout uses its own installed dependencies. Source-mode builds
print framework path and short git revision, plus the same fields for
`GOLEM_UI_SOURCE` when that override is set. Omit both overrides to return to the
installed pinned package.
