#!/usr/bin/env tsx
import { startDevServer } from './dev-server.ts';
import { discoverAgents } from './runtime/discovery.ts';
import { buildBrowser } from './browser-build.ts';
import { loadAppConfig, serverUrl } from './config.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const help = `Golem — local project CLI

Usage: ./golem <command>

  help    Show every command (also the default).
  init    Create a minimal app in the current directory.
  dev     Serve the browser shell using golem.config.ts (127.0.0.1:3000 by default).
          Restart after changing settings. Uses local Claude Code or Codex from the browser.
  build   Build the browser shell into dist/.
  lint    Check the app's architecture rules from eslint.config.mjs.
  doctor  Report local shell and backend readiness.
  say     <text> | --file <f>  Post a reply into the chat session that launched this agent
          (GOLEM_SESSION and GOLEM_API are set in its tmux session).

Requires Node.js >=22.18.0. Only \`say\` takes arguments.
Exit codes: 0 success/clean shutdown, 1 unavailable or failed, 2 invalid usage.
`;

const [command = 'help', ...args] = process.argv.slice(2);

if ((args.length && command !== 'say') || !['help', 'init', 'dev', 'build', 'lint', 'doctor', 'say'].includes(command)) {
  console.error('Invalid command or arguments. Run ./golem help.');
  process.exitCode = 2;
} else {
  switch (command) {
    case 'help':
      console.log(help);
      break;
    case 'init':
      try {
        initProject();
        console.log('Initialized Golem app. Run ./golem help.');
      } catch (error) {
        console.error(`Cannot initialize Golem app: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      break;
    case 'doctor':
      console.log(`Golem shell readiness (Node ${process.version})
Ready: local CLI, HTTP shell, golem-ui browser build and agent session seam.
${(await discoverAgents()).map(({ agent, status, runnable, detail }) => `${agent}: ${runnable ? 'runnable' : status === 'missing' ? 'not installed' : detail ?? status}`).join('\n')}
Not implemented: domain storage, accounts, permissions.
The dev server defaults to 127.0.0.1:3000 and uses optional host/port from golem.config.ts.`);
      break;
    case 'say':
      try {
        const text = args[0] === '--file' && args[1] ? readFileSync(args[1], 'utf8') : args.join(' ');
        const { GOLEM_SESSION: session, GOLEM_API: api } = process.env;
        if (!text.trim() || !session || !api) throw new Error('usage: golem say <text> | --file <f>, inside a Golem agent session (GOLEM_SESSION, GOLEM_API)');
        const response = await fetch(`${api.replace(/\/$/, '')}/api/sessions/${session}/say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        if (!response.ok) throw new Error(`${response.status} ${((await response.json().catch(() => ({}))) as { error?: string }).error ?? ''}`.trim());
      } catch (error) {
        console.error(`Cannot say: ${error instanceof Error ? error.message : String(error)}${error instanceof Error && error.cause ? ` (${String(error.cause)})` : ""}`);
        process.exitCode = 1;
      }
      break;
    case 'build':
      try {
        await buildBrowser();
      } catch (error) {
        console.error(`Cannot build Golem browser shell: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      break;
    case 'lint':
      try {
        const { ESLint } = await import('eslint');
        const eslint = new ESLint();
        const results = await eslint.lintFiles(['.']);
        const report = await (await eslint.loadFormatter('stylish')).format(results);
        if (report) console.log(report);
        if (results.some((result) => result.errorCount)) process.exitCode = 1;
        else console.log('Architecture lint passed.');
      } catch (error) {
        console.error(`Cannot lint Golem app: ${error instanceof Error ? error.message : String(error)}
See node_modules/golem-kit/docs/architecture.md to add eslint.config.mjs.`);
        process.exitCode = 1;
      }
      break;
    case 'dev':
      try {
        const config = await loadAppConfig();
        const server = await startDevServer(config.port, undefined, undefined, config.host);
        const stop = () => {
          server.close((error) => {
            process.removeListener('SIGINT', stop);
            process.removeListener('SIGTERM', stop);
            if (error) {
              console.error(error.message);
              process.exitCode = 1;
            } else {
              console.log('Golem dev server stopped.');
            }
          });
          server.closeAllConnections();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        console.log(`Golem shell: ${serverUrl(config.host, config.port)} (Ctrl+C to stop)`);
      } catch (error) {
        console.error(`Cannot start Golem dev server: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
  }
}

function initProject(): void {
  const root = resolve(process.cwd());
  const files = ['golem.config.ts', 'tsconfig.json', 'eslint.config.mjs', 'src/app.tsx', 'src/globals.d.ts', 'docs/domain.md', 'AGENTS.md', 'CLAUDE.md', 'golem', 'brain/index.md', 'brain/log.md'];
  const existing = files.filter((file) => existsSync(resolve(root, file)));
  if (existing.length) throw new Error(`refusing to overwrite existing files: ${existing.join(', ')}`);
  const packagePath = resolve(root, 'package.json');
  const packageExisted = existsSync(packagePath);
  if (existsSync(packagePath)) {
    const current = JSON.parse(readFileSync(packagePath, 'utf8')) as { dependencies?: Record<string, string> };
    if (!current.dependencies?.['golem-kit']) throw new Error('refusing to overwrite existing package.json');
  }
  const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const framework = JSON.parse(readFileSync(resolve(frameworkRoot, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
  mkdirSync(resolve(root, 'src'), { recursive: true });
  mkdirSync(resolve(root, 'docs'), { recursive: true });
  mkdirSync(resolve(root, 'brain'), { recursive: true });
  if (!existsSync(packagePath)) {
    writeFileSync(packagePath, JSON.stringify({
      name: 'golem-app', private: true, type: 'module', packageManager: 'pnpm@10.28.2',
      engines: { node: '>=22.18.0', pnpm: '10.28.2' },
      scripts: { dev: './golem dev', build: './golem build', lint: './golem lint', typecheck: 'tsc --noEmit' },
      ...(process.env.GOLEM_KIT_TARBALL ? {} : { dependencies: { 'golem-kit': framework.version } }),
      // The app's own tsconfig needs a compiler and the React/Node types in the app's tree;
      // golem-kit has them for its own program, and pnpm does not share them with the app.
      devDependencies: Object.fromEntries(['typescript', '@types/node', '@types/react']
        .map((name) => [name, framework.dependencies[name]])),
    }, null, 2) + '\n');
  }
  writeFileSync(resolve(root, 'golem.config.ts'), "export default { title: 'Golem', brain: true }\n");
  writeFileSync(resolve(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler',
      strict: true, noEmit: true, allowImportingTsExtensions: true,
      jsx: 'react-jsx', skipLibCheck: true, types: ['node'],
    },
    include: ['src/**/*', 'golem.config.ts'],
  }, null, 2) + '\n');
  writeFileSync(resolve(root, 'src/globals.d.ts'), `// golem-ui ships its own compiled stylesheet; any class beyond the ones its components use is
// CSS this app writes and imports itself.
declare module '*.css'
`);
  writeFileSync(resolve(root, 'brain/index.md'), `---
okf_version: "0.2"
---
# Brain

This folder is an Open Knowledge Format bundle: one concept per markdown file with \`type\` front matter, this \`index.md\` listing them one \`* [Title](path) - description\` line each, and \`log.md\` recording changes newest first.
`);
  writeFileSync(resolve(root, 'brain/log.md'), '# Log\n');
  writeFileSync(resolve(root, 'src/app.tsx'), `export default function App() {
  return (
    <section className="flex h-full items-center justify-center bg-neutral-50 p-6 text-center">
      <div>
        <h1 className="text-lg font-semibold">Welcome to Golem</h1>
        <p className="mt-2 text-sm text-neutral-500">Edit src/app.tsx to build your app.</p>
      </div>
    </section>
  )
}
`);
  writeFileSync(resolve(root, 'eslint.config.mjs'), `import golem from 'golem-kit/eslint'

// Architecture checks for \`./golem lint\`. To adapt or disable them, see
// node_modules/golem-kit/docs/architecture.md.
export default golem()
`);
  writeFileSync(resolve(root, 'docs/domain.md'), `# App DNA

What this app is for and the rules its code must honor. Update it in the same change as the code it describes.

## Purpose

Who the app helps and the problem it solves.

## Concepts

The words people use for the things this app manages, what each means, and how they relate.

## Operations

What people and the system do: each operation's inputs, result, and the rules it enforces.

## Decisions

Choices already made and why, so later changes keep them or revisit them on purpose.
`);
  writeFileSync(resolve(root, 'AGENTS.md'), `# Golem app

Before changing this app, read \`docs/domain.md\` (this app's DNA) and the installed framework guide \`node_modules/golem-kit/docs/builder.md\`.
`);
  writeFileSync(resolve(root, 'CLAUDE.md'), '@AGENTS.md\n');
  const ignorePath = resolve(root, '.gitignore');
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const additions = ['.golem/', '.env.local'].filter((entry) => !ignore.split(/\r?\n/).includes(entry));
  if (additions.length) writeFileSync(ignorePath, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`);
  if (!packageExisted) {
    const packageSpec = process.env.GOLEM_KIT_TARBALL ?? `golem-kit@${framework.version}`;
    // App code imports golem-ui directly, so pin the same version golem-kit builds with.
    execFileSync('pnpm', ['add', '--save-exact', packageSpec, `golem-ui@${framework.dependencies['golem-ui']}`], { cwd: root, stdio: 'inherit' });
  }
  writeFileSync(resolve(root, 'golem'), "#!/bin/sh\nset -eu\ncd -- \"$(dirname -- \"$0\")\"\n# An exported GOLEM_SOURCE launches from the checkout, so source mode does not depend on what\n# node_modules/golem-kit happens to hold. Anything else (including a bad path, and GOLEM_SOURCE\n# set in .env.local, which only node reads) goes through the installed entry and its errors.\nentry=node_modules/golem-kit/src/entry.mjs\n[ -f \"${GOLEM_SOURCE:-}/src/entry.mjs\" ] && entry=\"$GOLEM_SOURCE/src/entry.mjs\" || true\nexec node --env-file-if-exists=.env.local \"$entry\" \"$@\"\n", { mode: 0o755 });
}
