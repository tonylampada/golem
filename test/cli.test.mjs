import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const wrapper = fileURLToPath(new URL('../golem', import.meta.url));
const run = (...args) => spawnSync(wrapper, args, { encoding: 'utf8', cwd: '/' });

test('local command contract and HTTP lifecycle', { timeout: 15000 }, async (t) => {
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
  const build = run('build');
  assert.equal(build.status, 1);
  assert.match(build.stderr, /not implemented/);
  assert.equal(run('unknown').status, 2);
  assert.equal(run('dev', '--unknown').status, 2);

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
  assert.match(await response.text(), /<h1>Golem<\/h1>/);
  const missing = await fetch('http://127.0.0.1:3000/missing');
  assert.equal(missing.status, 404);
  await missing.text();
  const conflict = run('dev');
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /EADDRINUSE/);
  child.kill('SIGINT');
  assert.deepEqual(await exited, [0, null]);
});
