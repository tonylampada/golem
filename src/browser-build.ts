import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { resolveUiSource } from '../vite.config.ts';

const frameworkRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * The one build boundary used by both `./golem build` and `./golem dev`.
 * Typecheck runs before the Vite build on purpose: Vite's own `dist/` write only happens once
 * its build succeeds, so checking types first means a type-only failure never touches `dist/`
 * either, matching the same previous-build-preserved-on-failure guarantee a parse failure gets.
 */
export async function buildBrowser(): Promise<void> {
  const ui = resolveUiSource();
  if (process.env.GOLEM_SOURCE) console.log(`Golem source: ${frameworkRoot} (${gitRevision(frameworkRoot)})`);
  if (ui) {
    console.log(`Golem source: ${frameworkRoot} (${gitRevision(frameworkRoot)})`);
    console.log(`golem-ui source: ${ui.root} (${ui.revision})`);
  }
  const tsc = resolve(frameworkRoot, 'node_modules/.bin/tsc');
  const typeRoots = existsSync(resolve(frameworkRoot, 'node_modules/@types'))
    ? resolve(frameworkRoot, 'node_modules/@types')
    : resolve(frameworkRoot, '../@types');
  execFileSync(tsc, ['--noEmit', '-p', resolve(frameworkRoot, 'tsconfig.json')], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  execFileSync(tsc, [
    '--ignoreConfig', '--noEmit', '--jsx', 'react-jsx', '--module', 'ESNext',
    '--moduleResolution', 'Bundler', '--skipLibCheck', '--types', 'node,react,react-dom',
    '--typeRoots', typeRoots,
    resolve(process.cwd(), 'src/app.tsx'), resolve(process.cwd(), 'golem.config.ts'),
    ...[resolve(process.cwd(), 'src/server/index.ts')].filter(existsSync),
  ], { cwd: process.cwd(), stdio: 'inherit' });
  await build({ configFile: resolve(frameworkRoot, 'vite.config.ts') });
}

let buildInFlight: Promise<void> | undefined
let queued = false

/**
 * Server-owned rebuild trigger for after a build-mode turn. Coalesces overlapping calls into
 * one rerun instead of racing concurrent `buildBrowser()` invocations.
 */
export function rebuild(): Promise<void> {
  if (buildInFlight) { queued = true; return buildInFlight }
  buildInFlight = runQueuedBuilds()
  return buildInFlight
}

async function runQueuedBuilds(): Promise<void> {
  try {
    do {
      queued = false
      await buildBrowser()
    } while (queued)
  } finally {
    buildInFlight = undefined
  }
}

function gitRevision(root: string): string {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}
