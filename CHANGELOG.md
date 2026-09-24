# Changelog

## 0.2.5

- A manager resets a member's password from the member list instead of removing and re-inviting them. **Reset password** mints a one-use link, good for 24 hours, that opens the sign-in card in choose-a-new-password mode; the account keeps its id, email, roles and groups, and every session it had is revoked. New: `accounts.reset`, `POST /api/auth/members/<id>/reset` and `POST /api/auth/password`, on golem-ui 0.2.1.

## 0.2.4

- Chat and builder no longer fight over one Stop hook: the turn-end relay asks tmux which window it ran in instead of trusting the key baked in when it was installed, so a chat message sent after the builder was opened gets its reply and the composer unlocks. `installHooks` also keeps exactly one entry for itself, matched by script name, so a source-pin change between releases replaces it instead of stacking another.

## 0.2.3

- A model pin follows its agent: change `chat.agent` (or `agents.builder`) and the conversation saved on the old agent is retired on the next start instead of resumed with the new agent's pin. It stays readable in `.golem/conversations.json`, marked, and the next message opens a fresh conversation on the configured agent.
- `chat: { provider: 'tmux', sandbox: 'none' }` launches the chat agent on the builder's bypass profile, for boxes where the CLI's own sandbox cannot start.

## 0.2.2

- An app pins the model its terminal agents run on: `chat: { provider: 'tmux', agent, model }` for normal-mode chat and `agents.builderModel` for the builder. The pin rides the launch args (`-m` for Codex, `--model` for Claude Code) and is replayed on resume.

## 0.2.1

- `./golem` runs on a fresh `pnpm install`: the installed entry resolves `tsx` from golem-kit's own tree instead of the app's `node_modules/.bin`.
- `init` leaves a typecheckable app: a `tsconfig.json`, `src/globals.d.ts`, `dev`/`build`/`lint`/`typecheck` scripts, and the `typescript`, `@types/node`, `@types/react` devDependencies they need.
- `./golem build` sees the app's own `src/*.d.ts`, so an app can `import './app.css'` without `@ts-ignore`.
- The new-app scaffold uses only classes golem-ui's packaged stylesheet ships; an app styles the rest with its own CSS.

## 0.2.0

- `golem-kit/server` export and an `exports` map, so an app imports the backend by name instead of by path.
- App backend: records, files and server-defined operations, documented in `docs/app-backend.md`.
- App server code can call a model: `context.model.extract` takes free text and returns a schema-shaped value; the app chooses the model, and reads images too.
- Durable scheduled and long-running app jobs, with their runs visible in the sample app.
- Optional local accounts, groups and build access: invites, open sign-up, guests refused from `invoke`, signed-out and demoted pages cleared live.
- App brain: a `brain/` Open Knowledge Format bundle served read-only, a Brain reader beside the app, and agent citations rendered as source chips.
- Knowledge files and consented source views: sources offered from chat, opened only on consent, drafts kept across switching and closing, symlinked roots refused.
- Ordinary chat: an API agent limited to the app's listed operations, configured apart from the builder.
- Chat belongs to a role: `chat.roles` gates every chat route, and build keeps its own permission. No chat means no chat rights.
- Tmux chat provider: one persistent agent session per app (`golem-<app>`), `golem say` to post back into it, `/reset`, and resume of legacy harness refs into `golem-<app>:builder`.
- Normal-mode tmux chat runs read-only, with a launch profile per window replayed on resume.
- Terminal popup in build mode: a live tmux pane stream, with keys going straight to the pane.
- Browser shell bottom bar: the app / Brain / Admin in the menu row, Builder and theme in the gear; an app with more than one screen gets its own items.
- Builder mode is app state, with a Shell toggle and an app-defined normal chat.
- Build-mode chat: a Stop pill via `chat.interrupt`, and a one-row compact header at 320px chat width.
- Build mode reloads the page only when the bundle changed, and paints the theme before the first frame.
- Persistent dark mode toggle, and the framework's dark styles packaged.
- Source mode covers the app's own code, not just the shell (`GOLEM_SOURCE`, `GOLEM_UI_SOURCE`).
- Claude Code runs builds beside Codex; a new conversation picks its agent.
- App server code reloads after build-mode rebuilds, and the last good module is kept when an edit is malformed.
- Shared architecture lint (`golem-kit/eslint`, `./golem lint`) and an App DNA template in new apps.
- New apps install `golem-ui` directly, pinned to the version golem-kit builds with.
- Requires `golem-ui` 0.2.0.

## 0.1.1

First published release: the local CLI, the dev server, the browser shell and the Codex build session.
