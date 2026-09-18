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
- `ordinary` turns on the **Start a chat** button. Leave it out and there is no ordinary chat.
- `ordinary.model` defaults to `claude-opus-5`.
- `golem.config.ts` is bundled into the browser. Keep the API key in `.env.local` or the server environment, never in this file.

## What ordinary chat enforces

- **Operations**: the agent gets a tool for each listed operation and nothing else. It cannot build, run commands, read files, or enter build mode. A message cannot add a tool.
- **Permissions**: each tool call goes through the same `authorize` as a browser call, as the person who sent the message, refreshed on every call. A call the person may not make fails with the same `Not allowed: <operation>` error the app's own UI would get. Signing out stops a running turn.
- **Collections**: with `collections`, the built-in `records.*` operations refuse any other collection. Custom operations are limited only by being listed and by `authorize`; `collections` does not confine what their code touches.
- **Refused**: a terminal backend (`'codex'` or `'claude'`) for ordinary chat, because its file access cannot be limited to the listed operations. Also `files.upload` and `files.read`, which carry file bytes. Golem stops at startup instead of ignoring the setting.

## Conversations

- An ordinary chat belongs to the account that started it, or, for a signed-out visitor where the app allows guests, to that browser (an opaque `HttpOnly` cookie). Nobody else can read or continue it, managers included.
- Chats are saved in `.golem/` with the model's context, tool results included, and restored after a restart. Nothing runs again by itself: a turn cut off by a restart or **Interrupt** stays stopped, and a tool call whose outcome is unknown is reported to the model as unknown.
- **Interrupt** during a tool call lets that call finish; the model is not called again for that turn.
- Provider failures appear in the chat as a plain message. They never include the key.
