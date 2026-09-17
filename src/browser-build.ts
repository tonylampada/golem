import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { resolveUiSource } from '../vite.config.ts';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The one build boundary used by both `./golem build` and `./golem dev`. */
export async function buildBrowser(): Promise<void> {
  const ui = resolveUiSource();
  if (ui) {
    console.log(`Golem source: ${projectRoot} (${gitRevision(projectRoot)})`);
    console.log(`golem-ui source: ${ui.root} (${ui.revision})`);
  }
  await build({ configFile: resolve(projectRoot, 'vite.config.ts') });
  execFileSync(process.execPath, [resolve(projectRoot, 'node_modules/typescript/bin/tsc'), '--noEmit'], {
    cwd: projectRoot,
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
