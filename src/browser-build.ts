import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { resolveUiSource } from '../vite.config.ts';

const frameworkRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The one build boundary used by both `./golem build` and `./golem dev`. */
export async function buildBrowser(): Promise<void> {
  const ui = resolveUiSource();
  if (ui) {
    console.log(`Golem source: ${frameworkRoot} (${gitRevision(frameworkRoot)})`);
    console.log(`golem-ui source: ${ui.root} (${ui.revision})`);
  }
  await build({ configFile: resolve(frameworkRoot, 'vite.config.ts') });
  execFileSync('pnpm', ['exec', 'tsc', '--noEmit', '-p', resolve(frameworkRoot, 'tsconfig.json')], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}

function gitRevision(root: string): string {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}
