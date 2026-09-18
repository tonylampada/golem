import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const frameworkRoot = fileURLToPath(new URL('..', import.meta.url))

test('init creates the editable boundary and refuses repeat overwrite', { timeout: 30000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'golem-init-'))
  try {
    writeFileSync(join(root, 'package.json'), '{"dependencies":{"golem-kit":"0.1.0"}}\n')
    const packageBefore = readFileSync(join(root, 'package.json'), 'utf8')
    const first = spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), packageBefore)
    for (const file of ['package.json', 'golem.config.ts', 'src/app.tsx', 'docs/domain.md', 'AGENTS.md', 'golem']) {
      assert.ok(readFileSync(join(root, file)))
    }
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.golem\/$/m)
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.env\.local$/m)
    assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /golem-kit\/docs\/builder\.md/)
    assert.match(readFileSync(join(root, 'docs/domain.md'), 'utf8'), /important concepts and rules/)
    writeFileSync(join(root, 'sentinel.txt'), 'keep')
    const repeat = spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8' })
    assert.equal(repeat.status, 1)
    assert.equal(readFileSync(join(root, 'sentinel.txt'), 'utf8'), 'keep')
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), packageBefore)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generated wrapper loads app-local dotenv settings before source selection', () => {
  const root = mkdtempSync(join(tmpdir(), 'golem-wrapper-'))
  const source = join(root, 'source')
  try {
    writeFileSync(join(root, 'package.json'), '{"dependencies":{"golem-kit":"0.1.0"}}\n')
    assert.equal(spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8' }).status, 0)
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    symlinkSync(frameworkRoot, join(root, 'node_modules/golem-kit'), 'dir')
    mkdirSync(join(source, 'src'), { recursive: true })
    writeFileSync(join(source, 'src/cli.ts'), "console.log(`local:${process.env.GOLEM_UI_SOURCE}`)\n")
    writeFileSync(join(root, '.env.local'), `GOLEM_SOURCE=${source}\nGOLEM_UI_SOURCE=ui-from-file\n`)
    const wrapper = join(root, 'golem')
    const fromElsewhere = spawnSync(wrapper, ['help'], { cwd: '/', encoding: 'utf8' })
    assert.equal(fromElsewhere.status, 0, fromElsewhere.stderr)
    assert.match(fromElsewhere.stdout, /local:ui-from-file/)
    const exported = spawnSync(wrapper, ['help'], {
      cwd: '/', encoding: 'utf8', env: { ...process.env, GOLEM_SOURCE: frameworkRoot, GOLEM_UI_SOURCE: 'ui-from-shell' },
    })
    assert.equal(exported.status, 0, exported.stderr)
    assert.match(exported.stdout, /Golem — local project CLI/)
    const invalid = spawnSync(wrapper, ['help'], { cwd: '/', encoding: 'utf8', env: { ...process.env, GOLEM_SOURCE: '/not/a/golem/source' } })
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /GOLEM_SOURCE must point to a Golem checkout containing src\/cli\.ts/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
