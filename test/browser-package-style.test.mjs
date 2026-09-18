import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { buildBrowser } from '../src/browser-build.ts'

test('package-mode build includes framework dark status and interrupt styles', { timeout: 30000 }, async () => {
  const source = process.env.GOLEM_UI_SOURCE
  try {
    delete process.env.GOLEM_UI_SOURCE
    await buildBrowser()
    const css = readdirSync(resolve(import.meta.dirname, '../dist/assets'))
      .filter((file) => file.endsWith('.css'))
      .map((file) => readFileSync(resolve(import.meta.dirname, '../dist/assets', file), 'utf8')).join('\n')
    assert.match(css, /golem-browser-status-connected/)
    assert.match(css, /golem-browser-interrupt/)
  } finally {
    if (source === undefined) delete process.env.GOLEM_UI_SOURCE
    else process.env.GOLEM_UI_SOURCE = source
  }
})
