import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { anonymous, createApp, diskFiles, jsonlStore, z } from '../src/backend/index.ts'
import { chatInstructions } from '../src/runtime/tmux.ts'

const wrapper = fileURLToPath(new URL('../golem', import.meta.url))
// A plainly invented business: a reading app whose screens an agent may point at.
const views = [
  { name: 'chapter.open', description: 'Open one chapter full-screen. Use when the person asks to see or go to a chapter you named.', input: z.object({ id: z.string() }).strict() },
  // A one-way door, so this one keeps the Open / Dismiss offer.
  { name: 'chapter.burn', description: 'Burn one chapter. Use when the person asks to destroy a chapter you named.', input: z.object({ id: z.string() }).strict(), confirm: true },
]

async function open(module) {
  const root = mkdtempSync(join(tmpdir(), 'golem-view-actions-'))
  const records = await jsonlStore(join(root, '.golem/data/records'))
  return createApp({ records, files: (watched) => diskFiles(join(root, '.golem/data/files'), watched), root }, module)
}

test('a reload validates declared UI actions and lists the good ones for an agent', async () => {
  const app = await open({ views })
  assert.deepEqual(app.views.actions().map((one) => one.name), ['chapter.open', 'chapter.burn'])
  assert.deepEqual(app.views.actions().map((one) => one.confirm), [false, true])
  assert.deepEqual(app.views.actions()[0].inputSchema.properties, { id: { type: 'string' } })

  const refused = [
    [{ views: {} }, /views must be an array/],
    [{ views: [{ ...views[0], name: 'open' }] }, /needs a namespaced name/],
    [{ views: [{ ...views[0], description: '' }] }, /needs a description/],
    [{ views: [{ name: 'chapter.open', description: 'x' }] }, /needs an input schema/],
    [{ views: [{ ...views[0], name: 'source.open' }] }, /source\.\* names are Golem's own/],
    [{ views: [views[0], views[0]] }, /defined twice/],
    [{ views: [{ ...views[0], confirm: 'yes' }] }, /confirm must be a boolean/],
  ]
  for (const [module, message] of refused) assert.throws(() => app.use(module), message)
  // A refused module changes nothing: the old one keeps serving.
  assert.deepEqual(app.views.actions().map((one) => one.name), ['chapter.open', 'chapter.burn'])
  app.use({})
  assert.deepEqual(app.views.actions(), [], 'no declaration, nothing to offer')
})

test('an app action applies at once in the tab that handles it, and only a confirm action is offered', async () => {
  const app = await open({ views })
  const request = { headers: {} }
  app.views.useConversations({ owner: () => 'local', owns: (id) => id === 'chat-1' })
  const events = new Map()
  const tab = async () => {
    const { id } = await app.views.open(request, anonymous, 'chat-1')
    events.set(id, [])
    await app.views.connect(request, anonymous, id, (event) => events.get(id).push(event))
    return id
  }
  const reading = await tab()
  const plain = await tab()
  await app.views.handlers(request, anonymous, reading, ['chapter.open', 'chapter.burn'])

  const binding = { principal: anonymous, owner: 'local', conversation: 'chat-1' }
  // A tab with no handler for it is refused at request time, so the agent can say so.
  await assert.rejects(app.views.request({ ...binding, view: plain }, 'chapter.open', { id: '7' }), /Nothing in the person's open app handles chapter\.open/)
  await assert.rejects(app.views.request(binding, 'chapter.open', { id: '7' }), /Nothing in the person's open app handles chapter\.open/, 'and so is no tab at all')
  // A bad input comes back as the schema's own message.
  await assert.rejects(app.views.request({ ...binding, view: reading }, 'chapter.open', { chapter: 7 }), /chapter\.open: .*id/s)

  // A round trip: it lands in the bound tab as an apply, with nothing for the person to accept.
  const { offer, delivered, applied } = await app.views.request({ ...binding, view: reading }, 'chapter.open', { id: '7' })
  assert.deepEqual([delivered, applied], [true, true])
  assert.deepEqual(events.get(reading), [{ type: 'apply', offer, immediate: true }], 'no offer, just the effect')
  assert.deepEqual(offer.input, { id: '7' })
  assert.equal(offer.label, 'Open one chapter full-screen.', 'the line the chat shows is the app\'s own words')
  assert.deepEqual(events.get(plain), [], 'only the tab the request named')
  await assert.rejects(app.views.answer(request, anonymous, reading, offer.id, true), { name: 'NotFoundError' }, 'nothing left to answer')

  // A one-way door still asks.
  const burn = await app.views.request({ ...binding, view: reading }, 'chapter.burn', { id: '7' })
  assert.deepEqual([burn.delivered, burn.applied], [true, false])
  assert.deepEqual(events.get(reading).at(-1), { type: 'offer', offer: burn.offer })

  await assert.rejects(app.views.answer(request, anonymous, plain, burn.offer.id, true), { name: 'NotFoundError' }, 'answered in its own tab')
  await app.views.answer(request, anonymous, reading, burn.offer.id, true)
  assert.deepEqual(events.get(reading).at(-1), { type: 'apply', offer: burn.offer }, 'no file version: the app handler takes the input')
  await assert.rejects(app.views.answer(request, anonymous, reading, burn.offer.id, true), { name: 'NotFoundError' }, 'answered once')

  const dismissed = (await app.views.request({ ...binding, view: reading }, 'chapter.burn', { id: '9' })).offer
  await app.views.answer(request, anonymous, reading, dismissed.id, false)
  assert.deepEqual(events.get(reading).at(-1), { type: 'withdrawn', id: dismissed.id })
})

test('the chat brief teaches the exact command for each app action', async () => {
  const app = await open({ views })
  const brief = chatInstructions('/tmp/reading-app', app.views.actions())
  assert.match(brief, /`\.\/golem show chapter\.open id=<id>`/)
  assert.match(brief, /Use when the person asks to see or go to a chapter you named\. \(runs at once\)/)
  assert.match(brief, /Use when the person asks to destroy a chapter you named\. \(the person confirms first\)/)
  assert.equal(chatInstructions('/tmp/reading-app').includes('golem show'), false, 'an app with no actions gets no such block')
})

test('golem show sends the action and its input, and reports a refusal', async () => {
  const seen = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      seen.push({ url: request.url, body: JSON.parse(body) })
      const refuse = seen.length > 2
      response.writeHead(refuse ? 400 : 202, { 'content-type': 'application/json' })
      response.end(JSON.stringify(refuse ? { error: 'chapter.open: invalid input' } : { offered: 'chapter.open', applied: seen.length === 1 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = { ...process.env, GOLEM_SESSION: 'session-1', GOLEM_API: `http://127.0.0.1:${server.address().port}` }
  // Never spawnSync here: the stub server lives in this process and cannot answer while the loop is blocked.
  const show = (...args) => promisify(execFile)(wrapper, ['show', ...args], { encoding: 'utf8', cwd: '/', env })
    .then((done) => ({ status: 0, ...done }), (error) => ({ status: error.code, stdout: error.stdout, stderr: error.stderr }))
  try {
    const ok = await show('chapter.open', 'id=7')
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /Showed chapter\.open\. The screen has already changed/)
    assert.deepEqual(seen[0], { url: '/api/sessions/session-1/show', body: { action: 'chapter.open', input: { id: '7' } } })

    const offered = await show('chapter.open', '--json', '{"id":"7"}')
    assert.equal(offered.status, 0)
    assert.match(offered.stdout, /Offered chapter\.open\. The person sees an Open button/, 'a confirm action reports the button')
    assert.deepEqual(seen[1].body.input, { id: '7' })

    const refused = await show('chapter.open', 'id=nope')
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /Cannot show: chapter\.open: invalid input/)

    const malformed = await show('chapter.open', 'id')
    assert.equal(malformed.status, 1)
    assert.match(malformed.stderr, /not a key=value argument: id/)
    assert.equal(seen.length, 3, 'a malformed argument never reaches the server')
    assert.equal((await show()).status, 1, 'an action name is required')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
