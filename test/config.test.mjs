import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  server.close()
  await once(server, 'close')
  return port
}

test('dev reads host and port from the application config', { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'golem-config-'))
  const port = await freePort()
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, 'src/app.tsx'), 'export default function App() { return <p>Configured</p> }\n')
  writeFileSync(join(root, 'golem.config.ts'), `export default { title: 'Golem', host: '127.0.0.1', port: ${port} }\n`)
  const child = spawn(process.execPath, [cli, 'dev'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }) })
  let output = ''
  let errors = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${errors}`)), 20_000)
    const interval = setInterval(() => {
      if (output.includes(`http://127.0.0.1:${port}/`)) { clearTimeout(timer); clearInterval(interval); resolve() }
    }, 25)
    child.once('exit', () => { clearTimeout(timer); clearInterval(interval); reject(new Error(`Server exited: ${errors}`)) })
  })
  const response = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(response.status, 200)
  const conflict = spawnSync(process.execPath, [cli, 'dev'], { cwd: root, encoding: 'utf8' })
  assert.equal(conflict.status, 1)
  assert.match(conflict.stderr, /EADDRINUSE/)
  child.kill('SIGINT')
  assert.deepEqual(await once(child, 'exit'), [0, null])
})

test('invalid configuration fails before localhost fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'golem-invalid-config-'))
  try {
    for (const source of [
      "export default { title: 'Golem', host: '' }\n",
      "export default { title: 'Golem', port: 3000.5 }\n",
      "export default { title: 'Golem', host: '0.0.0.0' }\n",
      'export default {\n',
    ]) {
      writeFileSync(join(root, 'golem.config.ts'), source)
      const result = spawnSync(process.execPath, [cli, 'dev'], { cwd: root, encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /Cannot start Golem dev server: (golem\.config\.ts|Cannot load golem\.config\.ts)/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
