# Golem

*Design preview: the commands and capabilities below describe the intended product.*

![Golem mascot](assets/golem-mascot.png)

## What is Golem?

Golem is a framework for building applications with AI. **Your app is its own IDE:** talk to an agent inside the application to build and evolve it while you use it, all in the same environment.

## Getting Started

Install Node.js, pnpm and tmux, and sign in to Claude Code or Codex. Then:

```sh
mkdir my-app
cd my-app
npx golem-kit init
```

Do this once to create the application. It does not launch it. The generated project includes an executable `golem` wrapper at its root, so you can discover and run its commands without writing package scripts:

```sh
./golem help
./golem dev
```

Open the browser address printed in the terminal and select **Enter build mode**. The agent takes over onboarding: tell it what you want and start building together.

## What You Get

- 💬 **Build through conversation.** Use the app and change it from the same screen.
- 🧬 **Readable DNA.** Your app's concepts and rules in Markdown, kept in sync with its code.
- 🧩 **Shared building blocks.** UI components, libraries, skills and prompts supplied by the framework.
- 🔌 **One application API.** Documented operations shared by the UI and agents.
- 🤖 **Your choice of agent.** Claude Code, Codex or API-backed chat, with permissions suited to the task.
- 🔐 **Access that fits.** Optional login, groups and record-level permissions for users and their agents.
- 💾 **Pragmatic storage.** JSONL, databases or Markdown knowledge folders, according to your needs.
- 🏗️ **Room to grow.** TypeScript, shared types, loosely coupled modules and architectural lint defaults you can adapt.
