# Local command contract

Use Node.js >=22.18.0 (native TypeScript execution) and pnpm 10.28.2.
Run `pnpm install`, then `./golem help`. The executable wrapper resolves the
project-local CLI relative to itself, including when invoked from another directory.
The browser shell uses the local Vite build and the published `golem-ui` package.

## Source resolution seam

The root wrapper explicitly selects `src/cli.ts` relative to the wrapper's own
directory. This is the sole CLI entrypoint resolution point today; there is no
package-name lookup, published npm path, environment override or resolution
configuration yet. The next card can add source-mode configuration and selection
at this point, retaining checkout-local source as the default.

The CLI imports `./dev-server.ts` relative to the wrapper. The server serves built `dist/`
files and does not resolve packages or depend on
the caller's working directory. Keep source/package selection outside this server
boundary so a hot-source workflow can select the CLI without changing HTTP startup.

## Commands

| Command | Behavior | Exit status |
| --- | --- | --- |
| `./golem help` (or `./golem`) | List all commands | 0 |
| `./golem dev` | Refresh the browser build, then serve it at `http://127.0.0.1:3000/` until SIGINT/SIGTERM | 0 on clean shutdown; 1 on startup failure |
| `./golem build` | Build the browser shell into `dist/` | 0 |
| `./golem doctor` | Report local shell and backend readiness | 0 |

Unknown commands and extra arguments exit 2. Built assets are served directly; extensionless browser
routes fall back to `index.html`, while missing assets return 404. Malformed URLs return 400. The
server binds to loopback only. Port 3000 must be free.
`doctor` succeeding means its report ran, not that the full product is ready.

`src/dev-server.ts` exports `startDevServer(port = 3000)`, resolving to a listening
Node HTTP server. It refreshes the browser build before listening; the CLI owns signal handling and output. `src/browser/app.tsx` is the
composition boundary: anonymous identity and browser navigation are explicit host adapters, while
the chat adapter connects explicit browser build-mode sessions to the local Codex runtime.

Check types with `pnpm exec tsc --noEmit`; run the CLI/HTTP smoke check with
`node --test test/cli.test.mjs` (requires port 3000).

## Future generated projects

`npx golem-kit init` is a proposed generator, not an implemented or published
package in this scaffold. Its intended output is a self-contained project with
an executable `./golem`, project-local CLI and shell sources, a pinned pnpm
`packageManager`, lockfile and TypeScript configuration. After `pnpm install`,
users run `./golem dev` from that project without installing Golem globally.
This repository demonstrates that local command contract only; generation,
production packaging and agent integration are future work.
