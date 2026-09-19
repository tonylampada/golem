# golem — for the agent working here

Golem is the runtime and shell that turns a described app into a running one: the local CLI, the dev
server, the agent session behind build-mode chat, and the browser shell that mounts the app beside
that chat. Its components come from `golem-ui`; its business comes from the app. This repo owns
neither.

## Which repo owns a change

Three owners, and a change lands with exactly one of them:

- **`golem-ui`** owns what an app screen is made of: components, their config schemas, the adapter
  interfaces and their docs. A new capability a component needs from the world is a new adapter
  method there, never a fetch inside this repo's browser code.
- **`golem`** (this repo) owns the plumbing: `src/cli.ts`, `src/dev-server.ts`, `src/runtime/`, the
  browser shell in `src/browser/` that wires golem-ui components to the runtime through adapters, and
  the builder's instructions in `docs/builder.md`.
- **The app** owns its domain: business language, rules, records, its `src/app.tsx`, its
  `golem.config.ts`, its brain. Nothing app-specific is written here; a fixture in this repo is a
  plainly invented business.

When a change wants two owners, split it into two commits in two repos, contract first
(golem-ui), consumer second (golem), and pin the consumer to the contract's commit.

## Read before you write

- `docs/builder.md` is the **in-app agent's** launch prompt, not yours. Edit it to change how that
  agent behaves in a user's app; read it to know what an app can expect from the shell.
- `docs/source-development.md` is how an app runs against a checkout of this repo (`GOLEM_SOURCE`,
  `GOLEM_UI_SOURCE` in the app's `.env.local`); `docs/local-cli.md` is the command contract.
- `src/runtime/session.ts` is the session contract every backend implements; the browser event
  stream (`SessionEvent`) is the shape the shell consumes. A new backend keeps both.

## Verification bar

`pnpm test` green (plain `node --test`, one worker), then the real path: a scratch app initialised
from this checkout, `./golem dev`, the change exercised in a browser. A done report names that path.

## Delivery

Work lands on `main` directly. Rebase on `origin/main` before pushing; a rejected push means rebase
again, never force.
