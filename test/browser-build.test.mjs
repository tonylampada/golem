import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { buildBrowser } from '../src/browser-build.ts'

// Exercises buildBrowser() against real tsc/Vite, on this checkout's own src/app.tsx — the same
// file `./golem build`/`./golem dev` already build. Only proves the two failure shapes below,
// not every possible Rollup/plugin failure mode.
const appTsxPath = resolve(import.meta.dirname, '../src/app.tsx')
const distAssetsDir = resolve(import.meta.dirname, '../dist/assets')
const goodApp = readFileSync(appTsxPath, 'utf8')

function distFingerprint() {
  return readdirSync(distAssetsDir).sort()
    .map((file) => `${file}:${createHash('sha256').update(readFileSync(resolve(distAssetsDir, file))).digest('hex')}`)
    .join('\n')
}

test('a genuine parse failure is rejected without touching the previous dist', { timeout: 30000 }, async () => {
  try {
    await buildBrowser()
    const baseline = distFingerprint()
    writeFileSync(appTsxPath, 'export default function App() {\n  return (\n    <div>\n')
    await assert.rejects(buildBrowser())
    assert.equal(distFingerprint(), baseline, 'a parse failure must not touch dist/')
  } finally {
    writeFileSync(appTsxPath, goodApp)
  }
})

test('a syntactically valid type error is rejected before dist is touched, and repair recovers it', { timeout: 30000 }, async () => {
  try {
    await buildBrowser()
    const baseline = distFingerprint()

    // Valid JS at runtime, invalid TypeScript — esbuild would transpile and ship this; tsc must not.
    writeFileSync(appTsxPath, "export default function App() {\n  const count: number = 'not a number'\n  return <div>{count}</div>\n}\n")
    await assert.rejects(buildBrowser(), /tsc/)
    assert.equal(distFingerprint(), baseline, 'a type-only failure must not touch dist/')

    writeFileSync(appTsxPath, 'export default function App() {\n  return <div>repaired</div>\n}\n')
    await buildBrowser()
    assert.notEqual(distFingerprint(), baseline, 'the repair must actually rebuild dist/')
  } finally {
    writeFileSync(appTsxPath, goodApp)
    await buildBrowser()
  }
})
