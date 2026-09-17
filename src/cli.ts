#!/usr/bin/env tsx
import { startDevServer } from './dev-server.ts';
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
          Restart after changing settings. Uses the local Codex runtime from the browser.
  build   Build the browser shell into dist/.
  doctor  Report local shell and backend readiness.

Requires Node.js >=22.18.0. Commands accept no additional arguments.
Exit codes: 0 success/clean shutdown, 1 unavailable or failed, 2 invalid usage.
`;

const [command = 'help', ...args] = process.argv.slice(2);

if (args.length || !['help', 'init', 'dev', 'build', 'doctor'].includes(command)) {
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
Ready: local CLI, HTTP shell, golem-ui browser build and Codex session seam.
Claude integration: not yet connected.
Not implemented: Claude integration.
No network exposure is enabled; the dev server binds to loopback.`);
      break;
    case 'build':
      try {
        await buildBrowser();
      } catch (error) {
        console.error(`Cannot build Golem browser shell: ${error instanceof Error ? error.message : String(error)}`);
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
  const files = ['golem.config.ts', 'src/app.tsx', 'docs/domain.md', 'golem'];
  const existing = files.filter((file) => existsSync(resolve(root, file)));
  if (existing.length) throw new Error(`refusing to overwrite existing files: ${existing.join(', ')}`);
  const packagePath = resolve(root, 'package.json');
  const packageExisted = existsSync(packagePath);
  if (existsSync(packagePath)) {
    const current = JSON.parse(readFileSync(packagePath, 'utf8')) as { dependencies?: Record<string, string> };
    if (!current.dependencies?.['golem-kit']) throw new Error('refusing to overwrite existing package.json');
  }
  const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const framework = JSON.parse(readFileSync(resolve(frameworkRoot, 'package.json'), 'utf8')) as { version: string };
  mkdirSync(resolve(root, 'src'), { recursive: true });
  mkdirSync(resolve(root, 'docs'), { recursive: true });
  if (!existsSync(packagePath)) {
    writeFileSync(packagePath, JSON.stringify({
      name: 'golem-app', private: true, type: 'module', packageManager: 'pnpm@10.28.2',
      engines: { node: '>=22.18.0', pnpm: '10.28.2' },
      ...(process.env.GOLEM_KIT_TARBALL ? {} : { dependencies: { 'golem-kit': framework.version } }),
    }, null, 2) + '\n');
  }
  writeFileSync(resolve(root, 'golem.config.ts'), "export default { title: 'Golem' }\n");
  writeFileSync(resolve(root, 'src/app.tsx'), `export default function App() {
  return (
    <section className="flex h-full min-h-64 items-center justify-center bg-neutral-50 p-6 text-center">
      <div>
        <h1 className="text-lg font-semibold">Welcome to Golem</h1>
        <p className="mt-2 text-sm text-neutral-500">Edit src/app.tsx to build your app.</p>
      </div>
    </section>
  )
}
`);
  writeFileSync(resolve(root, 'docs/domain.md'), '# Golem app\n\nA minimal editable app entrypoint.\n');
  const ignorePath = resolve(root, '.gitignore');
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  if (!ignore.split(/\r?\n/).includes('.golem/')) writeFileSync(ignorePath, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}.golem/\n`);
  if (!packageExisted) {
    const packageSpec = process.env.GOLEM_KIT_TARBALL ?? `golem-kit@${framework.version}`;
    execFileSync('pnpm', ['add', '--save-exact', packageSpec], { cwd: root, stdio: 'inherit' });
  }
  writeFileSync(resolve(root, 'golem'), '#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nif [ -n "${GOLEM_SOURCE:-}" ]; then\n  exec node "$GOLEM_SOURCE/src/cli.ts" "$@"\nfi\nexec node_modules/.bin/golem-kit "$@"\n', { mode: 0o755 });
}
