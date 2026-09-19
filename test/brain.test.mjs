import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { citations, openBrain } from '../src/brain.ts'
import { Session } from '../src/runtime/session.ts'

test('citations: path#Lstart-Lend in a reply become sources, deduplicated, brain/ prefix dropped', () => {
  assert.deepEqual(citations('See brain/concepts/opening.md#L4-L9 and concepts/opening.md#L4-L9, also `fleet.md#L2` (fleet.md#L2-3).'), ['concepts/opening.md#L4-L9', 'fleet.md#L2-L2', 'fleet.md#L2-L3'])
  assert.deepEqual(citations('No brain here, just a #L12 mention and notes.txt#L1-L2.'), [])
})

test('a message the agent posts carries its citations as sources on the chat event', () => {
  const session = new Session('claude', { async start() {}, async send() {}, async shutdown() {} }, 'test')
  session.receive({ type: 'message', text: 'Plain answer.' })
  session.receive({ type: 'message', text: 'Grounded: concepts/opening.md#L4-L9.' })
  const messages = session.history.filter((event) => event.type === 'message')
  assert.equal(messages[0].sources, undefined)
  assert.deepEqual(messages[1].sources, ['concepts/opening.md#L4-L9'])
})

test('brain: index, list, read and search over an OKF bundle on disk; paths stay inside it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'golem-brain-'))
  mkdirSync(join(dir, 'concepts'))
  writeFileSync(join(dir, 'index.md'), '---\nokf_version: "0.2"\n---\n# Brain\n')
  writeFileSync(join(dir, 'concepts/opening.md'), '---\ntype: Playbook\ndescription: "How the day starts."\n---\n# Opening\n\nUnlock the side door first.\n')
  writeFileSync(join(dir, 'concepts/notes.txt'), 'not markdown')
  const brain = openBrain(dir)
  assert.match(await brain.index(), /okf_version/)
  assert.equal(await brain.index('concepts'), '# concepts\n\n* [opening.md](opening.md) - How the day starts.\n')
  assert.deepEqual(await brain.list(), [{ path: 'concepts', kind: 'dir' }, { path: 'index.md', kind: 'file' }])
  assert.match(await brain.read('concepts/opening.md'), /side door/)
  assert.deepEqual(await brain.search('SIDE door'), [{ path: 'concepts/opening.md', line: 7, excerpt: 'Unlock the side door first.' }])
  await assert.rejects(brain.read('../package.json'), /Invalid brain path/)
  await assert.rejects(brain.read('concepts/notes.txt'), /Not a markdown file/)
})
