# Agents

A Golem app has two kinds of agent. They are configured separately and never share access.

| | Builder | Ordinary chat |
|---|---|---|
| Purpose | Change the app's code | Use the app: find, read and change its data |
| Who may start one | Anyone without accounts; with accounts, managers and the `builder` role | Anyone who may use the app |
| Runs as | This computer's account (Codex or Claude Code CLI) | The person chatting, through the app's operations |
| Can reach | The file system, like any terminal agent | Only the operations the app lists |
| Credential | The CLI's own sign-in | `ANTHROPIC_API_KEY` in the server environment |

## Configuration

```ts
// golem.config.ts
export default {
  title: 'Field Notes',
  agents: {
    builder: 'claude', // or 'codex': the agent build mode starts with
    builderModel: 'claude-opus-5-5', // pins that CLI's model
    ordinary: {
      backend: 'anthropic',
      operations: ['records.list', 'records.get', 'records.update', 'notes.archive'],
      collections: ['notes'],
      instructions: 'Notes belong to field teams. Quote a note title before changing it.',
    },
  },
}
```

- `builder` is the default choice in build mode. A person's own pick in the browser still wins and is remembered.
- `builderModel` pins the builder CLI's model, in that CLI's own spelling (`--model` for Claude Code, `-m` for Codex). A terminal chat pins its own the same way: `chat: { provider: 'tmux', agent: 'codex', model: 'gpt-6-luna' }`. Both survive a resume. Left out, each CLI picks its default.
- Change `chat.agent` (or `agents.builder`) and the conversation saved on the old agent is retired on the next server start, so its pin never follows it: it stays readable in `.golem/conversations.json`, marked `retired`, and the next message opens a fresh conversation on the configured agent.
- `chat.sandbox` picks the terminal chat's launch profile: `'read-only'` (the default) is the CLI's own read-only sandbox, `'none'` is the builder's bypass profile. Use `'none'` where the sandbox cannot start, e.g. codex's `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` under `kernel.apparmor_restrict_unprivileged_userns=1`.
- `ordinary` turns on the **Start a chat** button. Leave it out and there is no ordinary chat.
- `ordinary.model` defaults to `claude-opus-5`.
- `golem.config.ts` is bundled into the browser. Keep the API key in `.env.local` or the server environment, never in this file.

## What ordinary chat enforces

- **Operations**: the agent gets a tool for each listed operation and nothing else. It cannot build, run commands, read files, or enter build mode. A message cannot add a tool.
- **Permissions**: each tool call goes through the same `authorize` as a browser call, as the person who sent the message, refreshed on every call. A call the person may not make fails with the same `Not allowed: <operation>` error the app's own UI would get. Signing out stops a running turn.
- **Collections and roots**: with `collections`, the built-in `records.*` operations refuse any other collection; with `roots`, the `knowledge.*` operations and source offers refuse any other knowledge root. Custom operations are limited only by being listed and by `authorize`; `collections` does not confine what their code touches.
- **Refused**: a terminal backend (`'codex'` or `'claude'`) for ordinary chat, because its file access cannot be limited to the listed operations. Also `files.upload` and `files.read`, which carry file bytes, and operations whose tool names would be invalid or the same (`a.b` and `a__b` both become `a__b`). Golem stops at startup instead of ignoring the setting.

## Showing sources

With knowledge roots (see `knowledge.md`) and `view.actions` and `view.request` listed in `operations`, the assistant can offer to open a knowledge file at a passage. The offer appears under the chat in the tab the message came from, with **Open** and **Dismiss**. Nothing opens until the person chooses **Open**; then that tab alone shows the file in the Editor, headed by its path and the passage's line numbers. Other tabs on the same sign-in are not moved.

- **Marking the passage needs a newer golem-ui.** The shell hands the Editor the passage through its `focus` prop: the lines, the file version they were counted in, and their text. The Editor waits until it has that version or a later one and no conflict is open. It then marks the passage where that exact text appears once in what it shows, so unsaved edits above it are allowed for. It marks nothing when the text is missing or appears twice, and it never changes the draft. The released golem-ui 0.1.1 has no `focus`: the file opens at the top, and the header's saved line numbers are the only pointer. To get the mark before a release, run against a golem-ui checkout that has it, with `GOLEM_UI_SOURCE` (see `source-development.md`).
- **Edits are kept.** Opened sources share one Editor for the life of the page. Opening another source parks the current one's unsaved draft or open conflict in the Editor without writing it, and opening it again restores it. **Back to app** hides the Editor, and **Show** under the chat brings it back as it was. A header note names any other source with unsaved edits. Leaving or reloading the page while a source has unsaved edits, a save in flight or an open conflict asks the browser to confirm first.

## Opening a screen of the app

With `views` in the server module (see `app-backend.md`), both agents can point the app at one of its own
screens. The offer appears under the chat in the tab the message came from, with **Open** and **Dismiss**,
and the handler the app registered with `views.on` runs when the person taps **Open**.

- **Ordinary chat** asks through `view.request` (list them with `view.actions`), so `operations` must include
  both, as for source offers.
- **A terminal chat agent** runs `./golem show <action> key=value…` from the app root, or
  `./golem show <action> --json '<input>'` for an input that is not all strings. Its launch brief lists the
  app's actions, one line each with the exact command. The offer goes to the tab the person's last message
  came from; with nobody looking, or with no handler for that action, the command fails and says why.
- An input the action's schema refuses comes back as the zod message, for the agent to correct.

## Conversations

- An ordinary chat belongs to the account that started it, or, for a signed-out visitor where the app allows guests, to that browser (an opaque `HttpOnly` cookie). Nobody else can read or continue it, managers included.
- Chats are saved in `.golem/` with the model's context, tool results included, and restored after a restart. Nothing runs again by itself: a turn cut off by a restart or **Interrupt** stays stopped, and a tool call whose outcome is unknown is reported to the model as unknown.
- **Interrupt** during a tool call lets that call finish; the model is not called again for that turn.
- Provider failures appear in the chat as a plain message. They never include the key.

## Provider

Ordinary chat calls the Anthropic Messages API through `@anthropic-ai/sdk` with a manual tool loop: each listed operation is a client tool (`.` becomes `__`, since tool names must match `^[a-zA-Z0-9_-]{1,128}$`), and each call is answered with a `tool_result`, marked `is_error` when the operation refuses.

- Tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview and https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- Models (`claude-opus-5`): https://platform.claude.com/docs/en/about-claude/models/overview

The tests run against a scripted stand-in for this API, `test/fixtures/messages-api.mjs`; point `ANTHROPIC_BASE_URL` at it to try chat without a key.
