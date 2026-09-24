import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const wrapper = fileURLToPath(new URL('../golem', import.meta.url));
const run = (...args) => spawnSync(wrapper, args, { encoding: 'utf8', cwd: '/' });

test('local command contract and HTTP lifecycle', { timeout: 30000 }, async (t) => {
  for (const args of [[], ['help']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    for (const command of ['help', 'dev', 'build', 'doctor']) {
      assert.match(result.stdout, new RegExp(`  ${command} +`));
    }
  }
  const doctor = run('doctor');
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /Not implemented:/);
  assert.equal(run('unknown').status, 2);
  assert.equal(run('dev', '--unknown').status, 2);

  // Start from no build output: ./golem dev owns the refresh boundary.
  rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });

  const child = spawn(wrapper, ['dev'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  let output = '';
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
  await Promise.race([
    (async () => {
      for await (const chunk of child.stdout) {
        output += chunk;
        if (output.includes('http://127.0.0.1:3000/')) return;
      }
      assert.fail(`Server exited before readiness: ${errors}`);
    })(),
    exited.then(() => assert.fail(`Server exited before readiness: ${errors}`)),
  ]);
  const response = await fetch('http://127.0.0.1:3000/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /<title>Golem<\/title>/);
  const missing = await fetch('http://127.0.0.1:3000/assets/missing.js');
  assert.equal(missing.status, 404);
  await missing.text();
  const malformed = await fetch('http://127.0.0.1:3000/%E0%A4%A');
  assert.equal(malformed.status, 400);
  const conflict = run('dev');
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /EADDRINUSE/);
  child.kill('SIGINT');
  assert.deepEqual(await exited, [0, null]);

  const build = run('build');
  assert.equal(build.status, 0, build.stderr);
});

test('invalid UI source paths fail clearly', () => {
  const result = spawnSync(wrapper, ['build'], {
    encoding: 'utf8',
    cwd: '/',
    env: { ...process.env, GOLEM_UI_SOURCE: '/definitely/not-a-golem-ui-checkout' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GOLEM_UI_SOURCE must point to a golem-ui checkout/);
});

// pnpm does not link a transitive dependency's bin into the app's node_modules/.bin, so an
// installed golem-kit cannot count on `tsx` being on the app's PATH — and Node refuses to strip
// types from a .ts file under node_modules. The entry must find tsx in its own tree.
test('the installed entry runs the TypeScript CLI without tsx on the app PATH', { timeout: 30000 } , () => {
  const frameworkRoot = fileURLToPath(new URL('..', import.meta.url));
  const app = mkdtempSync(join(tmpdir(), 'golem-installed-'));
  try {
    const kit = join(app, 'node_modules/golem-kit');
    mkdirSync(join(kit, 'src'), { recursive: true });
    mkdirSync(join(kit, 'node_modules'), { recursive: true });
    cpSync(join(frameworkRoot, 'src/entry.mjs'), join(kit, 'src/entry.mjs'));
    writeFileSync(join(kit, 'package.json'), '{"name":"golem-kit","type":"module"}\n');
    writeFileSync(join(kit, 'src/cli.ts'), "const ran: string = 'installed'\nconsole.log(`cli:${ran}`)\n");
    symlinkSync(join(frameworkRoot, 'node_modules/tsx'), join(kit, 'node_modules/tsx'), 'dir');
    const golem = join(app, 'golem');
    writeFileSync(golem, '#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec node node_modules/golem-kit/src/entry.mjs "$@"\n');
    chmodSync(golem, 0o755);
    assert.equal(existsSync(join(app, 'node_modules/.bin')), false, 'the app must have no .bin to fall back to');
    const result = spawnSync(golem, [], { encoding: 'utf8', cwd: '/' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cli:installed/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
