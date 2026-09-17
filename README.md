# Golem

![Golem mascot](assets/golem-mascot.png)

## What is Golem?

Golem is an early local application shell for building applications with AI. **Your app is its own IDE:** enter build mode, ask a locally authenticated Codex to edit the app, and keep using it in the same browser shell.

## Getting Started

Install Node.js >=22.18.0 and pnpm 10.28.2. Then run:

```sh
mkdir my-app
cd my-app
npx golem-kit init
```

Start the application:

```sh
./golem dev
```

Open the browser address printed in the terminal, enter build mode, and start a conversation. Build chat requires the Codex CLI installed and authenticated on the same machine. After a successful build-mode change, the browser shell rebuilds and refreshes; conversations are saved in `.golem/` and restored when the server restarts.

`./golem build` writes the browser shell to `dist/`. `./golem dev` defaults to
`127.0.0.1:3000`; set an optional `host` and `port` in `golem.config.ts`, then restart
the dev server. The terminal prints the usable address.

## Local source development

Use an installed package by default, or opt into a durable checkout while developing Golem:

```sh
GOLEM_SOURCE=/path/to/golem ./golem dev
```

See [the local CLI guide](docs/local-cli.md) for the complete command contract.

## Current scope

Claude integration, domain storage, accounts, and permissions are planned, not part of this release.
