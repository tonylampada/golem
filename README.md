# Golem

Build an application by talking to an agent. Keep changing it as your needs change.

> **README-first design draft.** This page describes the intended product so we can review the experience before building it. The package and commands below are proposed; they are not available yet.

Golem starts with a conversation beside an empty application. Describe what you want, work out the details with the agent, and ask it to build. Your app appears alongside the chat, ready for you and other people to use.

The agent records the application's purpose, concepts and rules in readable Markdown: its **DNA**. As you request changes, it updates the DNA and the application code together. You can discuss and edit the DNA without having to read the code.

## Start an application

You need a computer or server with:

- Node.js and npm.
- tmux.
- Claude Code or Codex installed and ready to use with your account.

Create an empty folder and start Golem:

```sh
mkdir my-app
cd my-app
npx @tonylampada/golem init
```

Golem detects your available coding agents, lets you choose if necessary, installs the application dependencies and starts the app. Open the browser address it prints.

Select **Enter build mode** and tell the agent what you want. For example:

> I run a bicycle repair shop. Help me build an app to track repairs, assign them to mechanics and tell customers when their bikes are ready.

The agent helps you describe the app's concepts and operations in its DNA. When you're ready, tell it to build. Try the result in the application beside the chat, then ask for changes.

## Use it and change it

Leave build mode to use the application normally. Enter it explicitly whenever you want the coding agent to change the app; the UI makes the active mode visible.

Build mode belongs to your session. Other people can keep using the app, though changes to shared code can affect them. You and the agent decide whether a separate development environment is useful.

Your application can also have an agent for everyday work. Ask it to find information or perform application actions on your behalf. That agent follows your application permissions; it can help you inspect sources and relevant passages alongside the conversation.

Closing the browser leaves ongoing agent work running on the server. Reopen the app to return to the conversation. If a backend failure interrupts a task, Golem shows the interruption and waits for your decision.

To start the application again later:

```sh
cd my-app
npm start
```

## Choose what your app needs

Describe the capabilities you need to the builder: login, user groups, shared records, a searchable knowledge folder, or background tasks. Golem supplies shared implementations and guidance; the agent configures them for your application.

Start with simple choices. A small local app might keep records in JSONL files and knowledge in Markdown. Another app might need a database and company login. Authentication is optional; when you choose no authentication, you decide who can reach the application.

You choose where the app runs and how other people reach it. The initial target is a running computer or server with file and process access.

## Your application stays yours

Your project contains its DNA, configuration and application-specific code. Shared libraries, skills and prompts come from versioned Golem packages, including the [golem-ui component kit](https://github.com/tonylampada/golem-ui).

When you want a framework upgrade, ask the builder. It reads the release notes and adapts your application when a version introduces breaking changes.

Golem offers architectural guidance and dependency lint checks by default. You and your agent can adapt those defaults when your project needs a different approach.
