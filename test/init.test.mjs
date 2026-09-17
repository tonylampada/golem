import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

test('init creates the editable boundary and refuses repeat overwrite', { timeout: 30000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'golem-init-'))
  try {
    const first = spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    for (const file of ['package.json', 'golem.config.ts', 'src/app.tsx', 'docs/domain.md', 'golem']) {
      assert.ok(readFileSync(join(root, file)))
    }
    writeFileSync(join(root, 'sentinel.txt'), 'keep')
    const repeat = spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8' })
    assert.equal(repeat.status, 1)
    assert.equal(readFileSync(join(root, 'sentinel.txt'), 'utf8'), 'keep')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
