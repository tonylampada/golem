import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
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
