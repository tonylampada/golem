import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openModel, z } from '../src/backend/index.ts'

const schema = z.object({ title: z.string(), people: z.array(z.string()) })

/** A stand-in `claude` first on PATH: it answers with whatever the script prints, in the CLI's own shape. */
function fakeCli(body) {
  const dir = mkdtempSync(join(tmpdir(), 'golem-model-'))
  const path = join(dir, 'claude')
  writeFileSync(path, `#!/bin/sh\n# The prompt arrives on stdin; a real call reads it, this one only drains it.\ncat > /dev/null\n${body}\n`)
  chmodSync(path, 0o755)
  return dir
}

/** `only` hides every real executable, so a name that is not in `dir` is genuinely missing. */
async function withCli(dir, run, only = false) {
  const path = process.env.PATH
  process.env.PATH = only ? dir : `${dir}:${path}`
  try {
    return await run()
  } finally {
    process.env.PATH = path
  }
}

const answer = (text) => `printf '%s' '${JSON.stringify({ is_error: false, result: text })}'`

test('extract returns the value the schema accepts', async () => {
  const value = await withCli(fakeCli(answer('{"title":"Standup","people":["Ada","Linus"]}')), () =>
    openModel().extract({ schema, text: 'Standup with Ada and Linus.' }))
  assert.deepEqual(value, { title: 'Standup', people: ['Ada', 'Linus'] })
})

test('extract unwraps a fenced answer', async () => {
  const value = await withCli(fakeCli(answer('```json\n{"title":"Standup","people":[]}\n```')), () =>
    openModel().extract({ schema, text: 'Standup, nobody named.' }))
  assert.deepEqual(value, { title: 'Standup', people: [] })
})

test('an answer the schema refuses is a model that is unavailable, not a crash', async () => {
  await withCli(fakeCli(answer('{"title":7}')), async () => {
    await assert.rejects(() => openModel().extract({ schema, text: 'anything' }), { name: 'ModelUnavailableError' })
  })
})

test('a missing runtime, a failed one and a runtime error all read as unavailable', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'golem-model-empty-'))
  await withCli(empty, async () => {
    await assert.rejects(() => openModel().extract({ schema, text: 'x' }), { name: 'ModelUnavailableError', message: /not installed/ })
  }, true)
  await withCli(fakeCli('exit 127'), async () => {
    await assert.rejects(() => openModel().extract({ schema, text: 'x' }), { name: 'ModelUnavailableError', message: /code 127/ })
  })
  await withCli(fakeCli(`printf '%s' '${JSON.stringify({ is_error: true, result: 'Credit balance too low' })}'`), async () => {
    await assert.rejects(() => openModel().extract({ schema, text: 'x' }), { name: 'ModelUnavailableError', message: /Credit balance too low/ })
  })
  await withCli(fakeCli("printf 'not json'"), async () => {
    await assert.rejects(() => openModel().extract({ schema, text: 'x' }), { name: 'ModelUnavailableError' })
  })
})

test('the prompt carries the schema and the text, and never rides in argv', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'golem-model-seen-'))
  const seen = join(dir, 'prompt.txt')
  const path = join(dir, 'claude')
  writeFileSync(path, `#!/bin/sh\ncat > ${seen}\nprintf '%s' "$*" > ${dir}/argv.txt\n${answer('{"title":"t","people":[]}')}\n`)
  chmodSync(path, 0o755)
  await withCli(dir, () => openModel().extract({ schema, text: 'Ada was there.', instructions: 'Be exact.' }))
  const prompt = readFileSync(seen, 'utf8')
  assert.match(prompt, /Be exact\./)
  assert.match(prompt, /Ada was there\./)
  assert.match(prompt, /"people"/)
  assert.doesNotMatch(readFileSync(join(dir, 'argv.txt'), 'utf8'), /Ada was there/)
})
