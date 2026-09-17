# Local command contract

Use Node.js >=22.18.0 (native TypeScript execution) and pnpm 10.28.2.
Run `pnpm install`, then `./golem help`. The executable wrapper resolves the
project-local CLI relative to itself, including when invoked from another directory.
The browser shell uses the local Vite build and the published `golem-ui` package.

## Source resolution seam

The root wrapper explicitly selects `src/cli.ts` relative to the wrapper's own
directory. This is the sole CLI entrypoint resolution point today; there is no
package-name lookup or resolution configuration. Generated app wrappers add an
explicit `GOLEM_SOURCE=/path/to/golem` opt-in for running a framework checkout
while keeping the app cwd. Unset it to use the installed pinned package.

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
| `./golem doctor` | Report local shell and backend readiness | 0 |

Unknown commands and extra arguments exit 2. Built assets are served directly; extensionless browser
routes fall back to `index.html`, while missing assets return 404. Malformed URLs return 400. The
default server binds to loopback on port 3000. To use another local port or a
specific tailnet address, export optional root settings from `golem.config.ts`:

```ts
export default { title: 'Golem', host: '100.114.197.65', port: 3000 }
```

`host` must be a nonempty string and `port` an integer from 1 through 65535;
`0.0.0.0` is not accepted. Configuration, build, and bind failures are printed
by `./golem dev`. Restart the server after changing these settings.
`doctor` succeeding means its report ran, not that the full product is ready.

`src/dev-server.ts` exports `startDevServer(port = 3000, backend, stateDirectory, host = '127.0.0.1')`, resolving to a listening
Node HTTP server. It refreshes the browser build before listening; the CLI owns signal handling and output. `src/browser/app.tsx` is the
composition boundary: anonymous identity and browser navigation are explicit host adapters, while
the chat adapter connects explicit browser build-mode sessions to the local Codex runtime.

Check types with `pnpm exec tsc --noEmit`; run the CLI/HTTP smoke check with
`node --test --test-concurrency=1 test/*.mjs` (serial because the CLI test intentionally removes
and rebuilds the shared `dist/` directory; requires port 3000).

## Generated projects

`golem-kit init` creates `package.json`, `golem.config.ts`, `src/app.tsx`,
`docs/domain.md`, and an executable `./golem`. Normal initialization writes the
pinned npm dependency `golem-kit@<framework version>` and installs it with pnpm.
For local packed-tarball acceptance only, set `GOLEM_KIT_TARBALL=/path/to/golem-kit.tgz`.
An existing package is supported only when it already declares `golem-kit`; its
metadata is preserved. Other nonempty destinations are refused.

Two-checkout development:

```sh
GOLEM_SOURCE=/path/to/golem /path/to/app/golem build
GOLEM_SOURCE=/path/to/golem /path/to/app/golem dev
```

The wrapper changes into the app first, so `src/` and `dist/` remain app-owned.
The framework checkout uses its own installed dependencies. Source-mode builds
print framework path and short git revision, plus the same fields for
`GOLEM_UI_SOURCE` when that override is set. Omit both overrides to return to the
installed pinned package.
