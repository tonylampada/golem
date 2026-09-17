# Local UI source development

The normal Golem checkout uses the pinned published `golem-ui@0.1.1` dependency. For a local
change to `golem-ui`, set `GOLEM_UI_SOURCE` to an isolated UI checkout for that command. Golem
aliases the package entry point and stylesheet to `src/index.ts` and `src/styles.css`, while
deduplicating React with the Golem checkout.

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

No package scripts or lockfiles need to change when switching modes. `golem-ui` itself uses Vite
and its package build is `pnpm build`; source mode consumes its TypeScript entry point directly.

Generated app initialization is not implemented yet. `golem-kit init` is not a working command or
published package, and this workflow does not claim to provide generated-app packaging.
