import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The one build boundary used by both `./golem build` and `./golem dev`. */
export async function buildBrowser(): Promise<void> {
  await build({ configFile: resolve(projectRoot, 'vite.config.ts') });
  execFileSync(process.execPath, [resolve(projectRoot, 'node_modules/typescript/bin/tsc'), '--noEmit'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
}
