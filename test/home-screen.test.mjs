import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixtureApp } from './fixtures/app.mjs'

/** A valid PNG of `size`×`size`: signature, IHDR (what the manifest reads), one IDAT, IEND. */
function png(size) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

test('config: icon is an optional path, title defaults to Golem', async () => {
  const { loadAppConfig } = await import('../src/config.ts')
  const load = (fields) => {
    const root = mkdtempSync(join(tmpdir(), 'golem-icon-config-'))
    writeFileSync(join(root, 'golem.config.ts'), `export default ${JSON.stringify(fields)}\n`)
    return loadAppConfig(root)
  }
  assert.equal((await load({ title: 'Isaac HUD', icon: 'art/isaac.png' })).icon, 'art/isaac.png')
  assert.equal((await load({ title: 'Isaac HUD' })).icon, undefined)
  assert.equal((await load({})).title, 'Golem')
  await assert.rejects(load({ icon: 42 }), /icon must be a nonempty path to a square PNG/)
  await assert.rejects(load({ title: '  ' }), /title must be a nonempty string/)
})

test('the app title, icon and manifest reach the browser; without an icon only the title changes', { timeout: 180000 }, async () => {
  const root = fixtureApp(mkdtempSync(join(tmpdir(), 'golem-home-screen-')))
  writeFileSync(join(root, 'golem.config.ts'), "export default { title: 'Field <Notes>', storage: 'sqlite' }\n")
  process.chdir(root)
  const { startDevServer } = await import('../src/dev-server.ts')
  const base = 'http://127.0.0.1:3245'

  // No icon anywhere: the two routes are absent and the head gains nothing but the escaped title.
  let server = await startDevServer(3245, () => ({ async start() {}, async send() {}, async shutdown() {} }), join(root, '.golem'))
  try {
    const page = await (await fetch(base)).text()
    assert.match(page, /<title>Field &lt;Notes&gt;<\/title>/)
    assert.doesNotMatch(page, /manifest|apple-touch-icon/)
    assert.match(page, /viewport-fit=cover/)
    assert.equal((await fetch(`${base}/icon.png`)).status, 404)
    assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 404)
  } finally { await new Promise((done) => server.close(done)) }

  // `.golem/icon.png` is found without any config, and its real pixel size reaches the manifest.
  mkdirSync(join(root, '.golem'), { recursive: true })
  writeFileSync(join(root, '.golem/icon.png'), png(1024))
  server = await startDevServer(3245, () => ({ async start() {}, async send() {}, async shutdown() {} }), join(root, '.golem'))
  try {
    for (const path of ['/', '/notes/42']) {
      const page = await (await fetch(`${base}${path}`)).text()
      const tags = page.match(/<(?:link|meta)[^>]*(?:icon\.png|webmanifest|apple-mobile-web-app|theme-color)[^>]*>/g)
      assert.equal(tags.length, 7, `${path}: ${tags}`)
      assert.match(page, /<meta name="apple-mobile-web-app-title" content="Field &lt;Notes&gt;">/)
      assert.match(page, /black-translucent/)
    }
    const icon = await fetch(`${base}/icon.png`)
    assert.equal(icon.headers.get('content-type'), 'image/png')
    assert.equal(Buffer.from(await icon.arrayBuffer()).length, png(1024).length)
    const manifest = await fetch(`${base}/manifest.webmanifest`)
    assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/)
    assert.deepEqual(await manifest.json(), {
      name: 'Field <Notes>', short_name: 'Field <Notes>', start_url: '/', scope: '/', display: 'standalone',
      background_color: '#0e131a', theme_color: '#0e131a',
      icons: [{ src: '/icon.png', type: 'image/png', sizes: '1024x1024', purpose: 'any' }],
    })
  } finally { await new Promise((done) => server.close(done)) }
})
