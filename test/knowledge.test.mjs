import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { anonymous, createApp, diskFiles, jsonlStore } from '../src/backend/index.ts'

const handbook = `---
type: Playbook
title: Opening the workshop
---
# Opening the workshop

Unlock the side door first.
Switch on the dust extractor before any saw.
Check the first-aid kit is stocked.
`

/** A neutral app root with one public and one restricted knowledge folder, plus a secret outside both. */
function appRoot() {
  const root = mkdtempSync(join(tmpdir(), 'golem-knowledge-'))
  mkdirSync(join(root, 'knowledge/guides'), { recursive: true })
  mkdirSync(join(root, 'knowledge/staff'), { recursive: true })
  writeFileSync(join(root, 'knowledge/guides/opening.md'), handbook)
  writeFileSync(join(root, 'knowledge/staff/rota.md'), '---\ntype: Reference\n---\n# Rota\n\nDust extractor filters: Fridays.\n')
  writeFileSync(join(root, 'secret.md'), 'outside the root\n')
  return root
}

const member = (id, session, groups = []) => ({ kind: 'user', id, name: id, roles: ['member'], groups, session })
// Only the staff group may see anything under staff/, on every knowledge operation.
const authorize = ({ operation, principal, record }) => !operation.startsWith('knowledge.') || !record?.path?.startsWith('staff/') || principal.groups?.includes('staff')

async function open(root, live = new Set()) {
  const records = await jsonlStore(join(root, '.golem/data/records'))
  const identity = {
    requireUser: false,
    resolve: async () => anonymous,
    refresh: async (principal) => {
      if (principal.kind === 'user' && !live.has(principal.session)) throw Object.assign(new Error('Session ended'), { name: 'UnauthorizedError' })
      return principal
    },
    resolveAccount: async () => { throw new Error('unused') },
  }
  const app = createApp({ records, files: (watched) => diskFiles(join(root, '.golem/data/files'), watched), root }, { knowledge: { handbook: 'knowledge' }, authorize }, identity)
  return { app, records }
}

test('knowledge files: navigate, read, versioned writes, disk edits, restart', async () => {
  const root = appRoot()
  let { app, records } = await open(root)
  const reader = member('ann', 's1')
  const call = (name, input, principal = reader) => app.invoke(name, input, principal, 'http')

  const listed = await call('knowledge.list', { root: 'handbook' })
  assert.deepEqual(listed.rows.map((row) => [row.path, row.type, row.title]), [['guides/opening.md', 'Playbook', 'Opening the workshop']], 'staff/ is hidden per row')
  assert.equal(listed.rows[0].body, undefined)
  assert.deepEqual(await call('knowledge.search', { root: 'handbook', text: 'dust extractor' }), [{ path: 'guides/opening.md', line: 8, text: 'Switch on the dust extractor before any saw.' }])

  const read = await call('knowledge.read', { root: 'handbook', path: 'guides/opening.md' })
  assert.equal(read.body, handbook)
  assert.equal(read.version, 1)

  const saved = await call('knowledge.write', { root: 'handbook', path: 'guides/opening.md', body: handbook.replace('side door', 'side door and the shutter'), expectedVersion: 1 })
  assert.equal(saved.version, 2)
  const stale = await call('knowledge.write', { root: 'handbook', path: 'guides/opening.md', body: 'lost?', expectedVersion: 1 }).catch((error) => error)
  assert.equal(stale.name, 'VersionConflictError')
  assert.match(stale.current.body, /shutter/, 'the conflict carries the current text')

  // Someone edits the file outside Golem: the next save against the old version is refused.
  writeFileSync(join(root, 'knowledge/guides/opening.md'), `${saved.body}Sweep the floor last.\n`)
  const outside = await call('knowledge.write', { root: 'handbook', path: 'guides/opening.md', body: 'overwrite', expectedVersion: 2 }).catch((error) => error)
  assert.equal(outside.name, 'VersionConflictError')
  assert.equal(outside.current.version, 3)
  assert.match(readFileSync(join(root, 'knowledge/guides/opening.md'), 'utf8'), /Sweep the floor/, 'nothing lost')

  const created = await call('knowledge.write', { root: 'handbook', path: 'guides/closing.md', body: '---\ntype: Playbook\n---\n# Closing\n', expectedVersion: 0 })
  assert.equal(created.version, 1)
  assert.equal((await call('knowledge.write', { root: 'handbook', path: 'guides/closing.md', body: 'again', expectedVersion: 0 }).catch((error) => error)).name, 'VersionConflictError')

  // Two writers racing on one version: exactly one wins.
  const race = await Promise.allSettled(['A', 'B'].map((who) => call('knowledge.write', { root: 'handbook', path: 'guides/closing.md', body: who, expectedVersion: 1 })))
  assert.deepEqual(race.map((one) => one.status).sort(), ['fulfilled', 'rejected'])

  await records.close()
  ;({ app, records } = await open(root))
  const reopened = await app.invoke('knowledge.read', { root: 'handbook', path: 'guides/opening.md' }, reader, 'http')
  assert.equal(reopened.version, 3)
  assert.match(reopened.body, /shutter/)
  await records.close()
})

test('knowledge files: permissions, roots, traversal and symlinks', async () => {
  const root = appRoot()
  symlinkSync(join(root, 'secret.md'), join(root, 'knowledge/guides/linked.md'))
  symlinkSync(root, join(root, 'knowledge/escape'))
  const { app, records } = await open(root)
  const reader = member('ann', 's1')
  const staff = member('bo', 's2', ['staff'])
  const call = (name, input, principal = reader) => app.invoke(name, input, principal, 'agent')

  await assert.rejects(call('knowledge.read', { root: 'handbook', path: 'staff/rota.md' }), { name: 'ForbiddenError' })
  await assert.rejects(call('knowledge.write', { root: 'handbook', path: 'staff/rota.md', body: 'x', expectedVersion: 1 }), { name: 'ForbiddenError' })
  assert.deepEqual(await call('knowledge.search', { root: 'handbook', text: 'filters' }), [], 'search skips denied files')
  assert.equal((await call('knowledge.read', { root: 'handbook', path: 'staff/rota.md' }, staff)).title, 'Rota')
  assert.equal((await call('knowledge.search', { root: 'handbook', text: 'filters' }, staff)).length, 1)

  for (const path of ['../secret.md', '/etc/passwd.md', 'guides/../../secret.md', '.hidden.md', 'guides\\x.md', 'notes.txt']) {
    await assert.rejects(call('knowledge.read', { root: 'handbook', path }), { name: 'InvalidError' }, path)
  }
  await assert.rejects(call('knowledge.read', { root: 'elsewhere', path: 'a.md' }), { name: 'NotFoundError' })
  await assert.rejects(call('knowledge.read', { root: 'handbook', path: 'guides/linked.md' }), { name: 'ForbiddenError' })
  await assert.rejects(call('knowledge.read', { root: 'handbook', path: 'escape/secret.md' }), { name: 'ForbiddenError' })
  await assert.rejects(call('knowledge.write', { root: 'handbook', path: 'escape/new/x.md', body: 'x', expectedVersion: 0 }), { name: 'ForbiddenError' })
  await assert.rejects(call('knowledge.write', { root: 'handbook', path: 'guides/linked.md', body: 'x', expectedVersion: 1 }), { name: 'ForbiddenError' })
  assert.equal(readFileSync(join(root, 'secret.md'), 'utf8'), 'outside the root\n')
  assert.deepEqual((await call('knowledge.list', { root: 'handbook' })).rows.map((row) => row.path), ['guides/opening.md'], 'links are not listed')
  assert.throws(() => createApp({ records, files: () => ({}), root }, { knowledge: { handbook: '../outside' } }), /inside the app/)
  await assert.rejects(call('knowledge.list', { root: 'handbook', folder: 'escape' }), { name: 'ForbiddenError' }, 'a symlinked folder is not walked')

  // A hard link is a second name for the same bytes; it is refused rather than versioned twice.
  linkSync(join(root, 'secret.md'), join(root, 'knowledge/guides/hard.md'))
  await assert.rejects(call('knowledge.read', { root: 'handbook', path: 'guides/hard.md' }), { name: 'ForbiddenError' })
  assert.equal((await call('knowledge.search', { root: 'handbook', text: 'outside the root' })).length, 0)

  // Configured roots are held to the same rule: a root that is, or passes through, a symlink is refused.
  const outside = mkdtempSync(join(tmpdir(), 'golem-outside-'))
  writeFileSync(join(outside, 'x.md'), '---\ntype: Note\n---\nnot the app\n')
  symlinkSync(outside, join(root, 'elsewhere'))
  symlinkSync(join(root, 'knowledge'), join(root, 'alias'))
  const linkedRoots = createApp({ records, files: () => ({}), root }, { knowledge: { away: 'elsewhere', alias: 'alias/guides' } })
  for (const [name, path] of [['away', 'x.md'], ['alias', 'opening.md']]) {
    await assert.rejects(linkedRoots.invoke('knowledge.read', { root: name, path }, reader, 'agent'), { name: 'ForbiddenError' }, name)
    await assert.rejects(linkedRoots.invoke('knowledge.list', { root: name }, reader, 'agent'), { name: 'ForbiddenError' }, name)
  }
  await records.close()
})

test('view offers go to the view the message came from and apply only where accepted', async () => {
  const root = appRoot()
  const live = new Set(['s1', 's1b', 's2'])
  const { app, records } = await open(root, live)
  const ann = member('ann', 's1')
  const conversation = 'conversation-1'
  // A fake runtime: account ids own their conversations; anonymous visitors are told apart by a cookie.
  const conversationOwners = { 'conversation-1': 'ann', 'conversation-2': 'ann', 'guest-conversation': 'browser:a' }
  const browser = (visitor) => ({ headers: { cookie: visitor ? `visitor=${visitor}` : '' } })
  const request = browser()
  await assert.rejects(app.views.open(request, ann, conversation), { name: 'NotFoundError' }, 'no runtime checks installed: no views')
  app.views.useConversations({
    owner: (req, principal) => principal.kind === 'user' ? principal.id : (/visitor=(\w+)/.exec(req.headers.cookie)?.[1] ? `browser:${/visitor=(\w+)/.exec(req.headers.cookie)[1]}` : null),
    owns: (id, owner) => conversationOwners[id] === owner,
  })
  const events = new Map()
  const view = async (principal, which = conversation, req = request) => {
    const { id } = await app.views.open(req, principal, which)
    events.set(id, [])
    await app.views.connect(req, principal, id, (event) => events.get(id).push(event))
    return id
  }
  const tabA = await view(ann)
  const tabB = await view(ann)
  const otherConversation = await view(ann, 'conversation-2')
  const otherBrowser = await view(member('ann', 's1b'))
  await assert.rejects(app.views.open(request, member('bo', 's2'), conversation), { name: 'NotFoundError' }, 'someone else\'s conversation')
  await assert.rejects(app.views.open(request, ann, 'made-up-conversation'), { name: 'NotFoundError' })
  await assert.rejects(app.views.connect(request, member('bo', 's2'), tabA, () => {}), { name: 'NotFoundError' }, 'a view id is not transferable')
  await assert.rejects(app.views.connect(request, member('ann', 's1b'), tabA, () => {}), { name: 'NotFoundError' }, 'nor across sign-in sessions')

  const binding = { principal: ann, owner: 'ann', conversation }
  assert.equal(await app.views.bound(tabA, binding), true)
  assert.equal(await app.views.bound(tabA, { ...binding, conversation: 'conversation-2' }), false)
  assert.equal(await app.views.bound(tabA, { ...binding, principal: member('ann', 's1b') }), false)
  assert.equal(await app.views.bound('made-up-view', binding), false)

  const tools = Object.fromEntries(app.agentTools(ann, { ...binding, view: tabA }).map((tool) => [tool.name, tool]))
  assert.deepEqual((await tools['view.actions'].call({})).map((one) => one.name), ['source.open'])
  assert.equal(app.agentTools(ann).some((tool) => tool.name.startsWith('view.')), false, 'no conversation, no view tools')

  const { offer, delivered } = await tools['view.request'].call({ action: 'source.open', input: { root: 'handbook', path: 'guides/opening.md', quote: 'switch on the dust  extractor' } })
  assert.equal(delivered, true)
  assert.deepEqual(offer.input, { root: 'handbook', path: 'guides/opening.md', line: 8, endLine: 8 })
  assert.deepEqual(events.get(tabA), [{ type: 'offer', offer }])
  for (const id of [tabB, otherConversation, otherBrowser]) assert.deepEqual(events.get(id), [], 'only the view the message came from')
  await assert.rejects(app.views.answer(request, ann, tabB, offer.id, true), { name: 'NotFoundError' }, 'a targeted offer is answered in its view')
  await app.views.answer(request, ann, tabA, offer.id, true)
  assert.deepEqual(events.get(tabA).slice(-2).map((one) => one.type), ['withdrawn', 'apply'])
  assert.equal(events.get(tabB).some((one) => one.type === 'apply'), false, 'the other tab does not move')
  await assert.rejects(app.views.answer(request, ann, tabA, offer.id, true), { name: 'NotFoundError' }, 'answered once')

  // Without a view the offer is only returned, for the chat to show; any of this person's views of it may accept.
  const chatOnly = Object.fromEntries(app.agentTools(ann, binding).map((tool) => [tool.name, tool]))
  const shown = await chatOnly['view.request'].call({ action: 'source.open', input: { root: 'handbook', path: 'guides/opening.md', line: 6, endLine: 7 } })
  assert.equal(shown.delivered, false)
  assert.equal([tabA, tabB].some((id) => events.get(id).some((one) => one.offer?.id === shown.offer.id)), false, 'not broadcast')
  await assert.rejects(app.views.answer(request, ann, otherConversation, shown.offer.id, true), { name: 'NotFoundError' })
  await assert.rejects(app.views.answer(request, member('ann', 's1b'), otherBrowser, shown.offer.id, true), { name: 'NotFoundError' })
  await app.views.answer(request, ann, tabB, shown.offer.id, true)
  assert.deepEqual(events.get(tabB).at(-1), { type: 'apply', offer: shown.offer })

  // The file changes before the person answers: the same passage is highlighted where it now is.
  const moving = (await tools['view.request'].call({ action: 'source.open', input: { root: 'handbook', path: 'guides/opening.md', quote: 'first-aid kit' } })).offer
  assert.deepEqual([moving.input.line, moving.input.endLine], [9, 9])
  const file = join(root, 'knowledge/guides/opening.md')
  writeFileSync(file, readFileSync(file, 'utf8').replace('# Opening the workshop\n', '# Opening the workshop\n\nRead this first.\nThen this.\n'))
  await app.views.answer(request, ann, tabA, moving.id, true)
  assert.deepEqual(events.get(tabA).at(-1), { type: 'apply', offer: { ...moving, input: { ...moving.input, line: 12, endLine: 12 } } })
  // Gone from the file: refused visibly, nothing applied, a fresh offer is needed.
  const vanishing = (await tools['view.request'].call({ action: 'source.open', input: { root: 'handbook', path: 'guides/opening.md', quote: 'Then this.' } })).offer
  writeFileSync(file, readFileSync(file, 'utf8').replace('Then this.\n', ''))
  await assert.rejects(app.views.answer(request, ann, tabA, vanishing.id, true), { name: 'VersionConflictError' })
  assert.equal(events.get(tabA).at(-1).type, 'withdrawn')

  // Denied and missing sources refuse alike, with nothing from the file in the error.
  for (const path of ['staff/rota.md', 'guides/missing.md']) {
    await assert.rejects(tools['view.request'].call({ action: 'source.open', input: { root: 'handbook', path, line: 1 } }), { name: 'ForbiddenError', message: 'Cannot open that source' })
  }
  await assert.rejects(tools['view.request'].call({ action: 'records.remove', input: {} }), { name: 'NotFoundError' })
  const foreign = Object.fromEntries(app.agentTools(ann, { ...binding, conversation: 'made-up-conversation' }).map((tool) => [tool.name, tool]))
  await assert.rejects(foreign['view.request'].call({ action: 'source.open', input: { root: 'handbook', path: 'guides/opening.md' } }), { name: 'NotFoundError' })

  // A session that ended since the offer gets nothing applied.
  const late = (await tools['view.request'].call({ action: 'source.open', input: { root: 'handbook', path: 'guides/opening.md', line: 5 } })).offer
  live.delete('s1')
  await assert.rejects(app.views.answer(request, ann, tabA, late.id, true), { name: 'UnauthorizedError' })
  assert.notEqual(events.get(tabA).at(-1).type, 'apply')
  assert.equal(await app.views.bound(tabA, binding), false)

  // Anonymous visitors: the runtime's browser key decides; a leaked view id alone is not enough.
  await assert.rejects(app.views.open(browser(), anonymous, 'guest-conversation'), { name: 'NotFoundError' }, 'no cookie yet')
  await assert.rejects(app.views.open(browser('b'), anonymous, 'guest-conversation'), { name: 'NotFoundError' }, 'another visitor')
  const guestA = await view(anonymous, 'guest-conversation', browser('a'))
  await assert.rejects(app.views.connect(browser('b'), anonymous, guestA, () => {}), { name: 'NotFoundError' })
  const guest = { principal: anonymous, owner: 'browser:a', conversation: 'guest-conversation' }
  assert.equal(await app.views.bound(guestA, guest), true)
  assert.equal(await app.views.bound(guestA, { ...guest, owner: 'browser:b' }), false)
  const guestTools = Object.fromEntries(app.agentTools(anonymous, { ...guest, view: guestA }).map((tool) => [tool.name, tool]))
  const guestOffer = (await guestTools['view.request'].call({ action: 'source.open', input: { root: 'handbook', path: 'guides/opening.md', line: 5 } })).offer
  assert.deepEqual(events.get(guestA), [{ type: 'offer', offer: guestOffer }])
  await assert.rejects(app.views.answer(browser('b'), anonymous, guestA, guestOffer.id, true), { name: 'NotFoundError' })
  await app.views.answer(browser('a'), anonymous, guestA, guestOffer.id, false)
  assert.deepEqual(events.get(guestA).at(-1), { type: 'withdrawn', id: guestOffer.id })
  await records.close()
})
