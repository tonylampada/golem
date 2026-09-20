import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSourceModule, sourceAliases, sourcePaths } from '../src/source-mode.ts'

function withSources(run) {
  const before = { kit: process.env.GOLEM_SOURCE, ui: process.env.GOLEM_UI_SOURCE }
  process.env.GOLEM_SOURCE = '/checkouts/golem'
  process.env.GOLEM_UI_SOURCE = '/checkouts/golem-ui'
  try { run() } finally {
    if (before.kit === undefined) delete process.env.GOLEM_SOURCE; else process.env.GOLEM_SOURCE = before.kit
    if (before.ui === undefined) delete process.env.GOLEM_UI_SOURCE; else process.env.GOLEM_UI_SOURCE = before.ui
  }
}

test('without the variables nothing is redirected, so an app keeps resolving its node_modules', () => {
  delete process.env.GOLEM_SOURCE
  delete process.env.GOLEM_UI_SOURCE
  assert.deepEqual(sourcePaths(), {})
  assert.deepEqual(sourceAliases(), [])
  assert.equal(resolveSourceModule('golem-kit/server'), undefined)
})

test('source mode answers the app\'s own golem-kit and golem-ui imports from the checkouts', () => {
  withSources(() => {
    // golem-ui from src/, not dist/: a checkout that was never built still resolves.
    assert.equal(resolveSourceModule('golem-ui'), '/checkouts/golem-ui/src/index.ts')
    assert.equal(resolveSourceModule('golem-kit/server'), '/checkouts/golem/src/backend/index.ts')
    assert.equal(resolveSourceModule('golem-kit/client'), '/checkouts/golem/src/client.ts')
    assert.equal(resolveSourceModule('golem-kit/docs/builder.md'), '/checkouts/golem/docs/builder.md')
    assert.equal(resolveSourceModule('react'), undefined)
    assert.deepEqual(sourcePaths()['golem-kit/*'], ['/checkouts/golem/*'])
    const alias = sourceAliases().find(({ find }) => find.test('golem-kit/server'))
    assert.equal('golem-kit/server'.replace(alias.find, alias.replacement), '/checkouts/golem/src/backend/index.ts')
  })
})
