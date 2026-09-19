import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { keyForEvent, NAMED, CTRL_KEYS } from '../src/browser/panekeys.ts'

const { KEY_RE } = createRequire(import.meta.url)('../src/runtime/harness/port.js')

test('keyForEvent: named keys, ctrl chords, printable text, and what is left to the browser', () => {
  assert.deepEqual(keyForEvent({ key: 'Enter' }), { key: 'Enter' })
  assert.deepEqual(keyForEvent({ key: 'Backspace' }), { key: 'BSpace' })
  assert.deepEqual(keyForEvent({ key: 'Tab', shiftKey: true }), { key: 'BTab' })
  assert.deepEqual(keyForEvent({ key: 'ArrowUp' }), { key: 'Up' })
  assert.deepEqual(keyForEvent({ key: 'Delete' }), { key: 'DC' })
  assert.deepEqual(keyForEvent({ key: 'Escape' }), { key: 'Escape' })
  assert.deepEqual(keyForEvent({ key: 'c', ctrlKey: true }), { key: 'C-c' })
  assert.deepEqual(keyForEvent({ key: 'a' }), { text: 'a' })
  assert.deepEqual(keyForEvent({ key: ' ' }), { text: ' ' })
  assert.deepEqual(keyForEvent({ key: 'é' }), { text: 'é' })
  assert.equal(keyForEvent({ key: 'v', ctrlKey: true }), null) // paste event must survive
  assert.equal(keyForEvent({ key: 'w', metaKey: true }), null)
  assert.equal(keyForEvent({ key: 'b', altKey: true }), null)
  assert.equal(keyForEvent({ key: 'F5' }), null)
  assert.equal(keyForEvent({ key: 'Shift' }), null)
  assert.equal(keyForEvent({ key: 'F5', ctrlKey: true }), null)
})

test('every key name the browser can emit passes the harness KEY_RE', () => {
  for (const name of [...Object.values(NAMED), 'BTab', ...[...CTRL_KEYS].map((c) => `C-${c}`)]) assert.ok(KEY_RE.test(name), name)
})
