# Local UI source development

The normal Golem checkout uses the pinned published `golem-ui@0.1.1` dependency. For a local
change to `golem-ui`, set `GOLEM_UI_SOURCE` to an isolated UI checkout for that command. Golem
aliases the package entry point and stylesheet to `src/index.ts` and `src/styles.css`, while
deduplicating React with the Golem checkout. It also loads the UI checkout's installed
`@tailwindcss/vite` plugin and adds the checkout as a Tailwind `@source`, so utility classes in
edited UI components are compiled and scanned.

## Pinned golem-ui

The published `golem-ui@0.1.1` predates the `Brain` component and `ChatMessage.sources`. This
checkout is developed against golem-ui commit `e26476d` (MNC-187 Shell chrome: the menu row, the
settings dropdown, the chat toggle; `initialTab` is gone); until that ships as a package version, run
with `GOLEM_UI_SOURCE` pointing at a checkout of it to get the Brain reader, the source chips, the
slash-command picker, a chat-less normal mode, and the Brain, Admin and Builder controls. With 0.1.1
installed the shell still builds with the old chrome and none of those controls, and the Brain panel
says what is missing.

## Clean checkout

```sh
git clone https://github.com/tonylampada/golem.git
git clone https://github.com/tonylampada/golem-ui.git
cd golem
pnpm install
cd ../golem-ui
pnpm install
cd ../golem
```

Run the Golem checkout against the checked-out UI source:

```sh
GOLEM_UI_SOURCE=../golem-ui ./golem dev
```

The build prints both checkout paths and their short git revisions in source mode. `./golem
build` accepts the same override. The path must contain the golem-ui `package.json`, `src/index.ts`,
and `src/styles.css`; invalid paths fail with an explanatory error.

To return to the published dependency, omit the variable:

```sh
./golem dev
```

With the server running, these direct browser assertions check the expected placeholder, computed
font/display, and desktop/mobile chat/canvas geometry. Install Playwright and its managed Chromium
in a temporary directory. Set GOLEM_BROWSER_EXECUTABLE only when using another browser binary:

```sh
browser_tools=$(mktemp -d)
npm --prefix "$browser_tools" install --no-save playwright
"$browser_tools/node_modules/.bin/playwright" install chromium
export PLAYWRIGHT_MODULE="$browser_tools/node_modules/playwright/index.mjs"
GOLEM_UI_SOURCE=../golem-ui GOLEM_EXPECTED_PLACEHOLDER='Message the agent…' GOLEM_BROWSER_SCREENSHOT=.artifacts/source \
  node scripts/browser-assertions.mjs
unset GOLEM_UI_SOURCE GOLEM_EXPECTED_PLACEHOLDER
GOLEM_BROWSER_SCREENSHOT=.artifacts/published node scripts/browser-assertions.mjs
rm -rf "$browser_tools"
```

For example, an explicit browser binary can be selected with `GOLEM_BROWSER_EXECUTABLE=/path/to/chrome`.

For a temporary source marker experiment, set GOLEM_EXPECTED_PLACEHOLDER to the marker after
editing the isolated UI checkout. Ordinary source mode expects the normal Message the agent… placeholder.
No package scripts or lockfiles need to change when switching modes. `golem-ui` itself uses Vite
and its package build is `pnpm build`; source mode consumes its TypeScript entry point directly.

## An app against the checkouts

For generated apps, `GOLEM_SOURCE=/path/to/golem /path/to/app/golem dev` opts into
the framework checkout while preserving the app cwd and lockfile. Omit
`GOLEM_SOURCE` to use the installed pinned `golem-kit`; combine it with
`GOLEM_UI_SOURCE=/path/to/golem-ui` when developing both checkouts. Source-mode
builds print each source path and short git revision.

Source mode covers the app's own code too, not only the shell's. An app that imports
`golem-kit/server` in `src/server/index.ts`, `golem-kit/client` or `golem-ui` in `src/app.tsx`
resolves those imports from the checkouts, in all three places the app's code is read:

- the **app typecheck** (`tsc` over `src/app.tsx`, `golem.config.ts` and `src/server/index.ts`),
  through a generated tsconfig whose `paths` point at the checkouts;
- the **browser bundle**, through Vite aliases;
- the **app server bundle**, where `golem-kit/server` resolves to the checkout's file and stays
  external, so the app and the running server share one module instance.

Nothing is written into the app folder and `node_modules` is never edited: the app keeps the
published `golem-kit` and `golem-ui` it installed, and drops back to them the moment the
variables are absent. `golem-ui` is read from its `src/`, so its checkout needs no `pnpm build`.

An exported `GOLEM_SOURCE` also decides which `entry.mjs` the app's `./golem` script launches, so
source mode works even when the installed `golem-kit` is older than the checkout. `GOLEM_SOURCE`
set in `.env.local` is read by node instead, which needs the installed `golem-kit` to be recent
enough to have `src/entry.mjs`.
