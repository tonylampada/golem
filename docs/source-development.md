# Local UI source development

The normal Golem checkout uses the pinned published `golem-ui@0.1.1` dependency. For a local
change to `golem-ui`, set `GOLEM_UI_SOURCE` to an isolated UI checkout for that command. Golem
aliases the package entry point and stylesheet to `src/index.ts` and `src/styles.css`, while
deduplicating React with the Golem checkout. It also loads the UI checkout's installed
`@tailwindcss/vite` plugin and adds the checkout as a Tailwind `@source`, so utility classes in
edited UI components are compiled and scanned.

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

Generated app initialization is not implemented yet. `golem-kit init` is not a working command or
published package, and this workflow does not claim to provide generated-app packaging.
