import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

/** A stand-in `codex` on PATH: it answers in `codex exec --json` JSONL, and records its argv. */
function fakeCodex(events, dir = mkdtempSync(join(tmpdir(), 'golem-model-codex-'))) {
  const path = join(dir, 'codex')
  writeFileSync(path, `#!/bin/sh\ncat > ${dir}/prompt.txt\nprintf '%s' "$*" > ${dir}/argv.txt\ncat <<'JSONL'\n${events.map((event) => JSON.stringify(event)).join('\n')}\nJSONL\n`)
  chmodSync(path, 0o755)
  return dir
}

test('the codex runtime answers with its last agent message and is asked for the configured model', async () => {
  const dir = fakeCodex([
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: '{"title":"Standup","people":["Ada"]}' } },
    { type: 'turn.completed', usage: {} },
  ])
  const value = await withCli(dir, () => openModel({ runtime: 'codex', name: 'gpt-5.6-sol' }).extract({ schema, text: 'Standup with Ada.' }))
  assert.deepEqual(value, { title: 'Standup', people: ['Ada'] })
  const argv = readFileSync(join(dir, 'argv.txt'), 'utf8')
  assert.match(argv, /^exec -m gpt-5\.6-sol /)
  assert.doesNotMatch(argv, /Standup with Ada/)
  assert.match(readFileSync(join(dir, 'prompt.txt'), 'utf8'), /Standup with Ada\./)
})

test('a failed codex turn and a missing codex both read as unavailable', async () => {
  const failed = fakeCodex([{ type: 'turn.failed', error: { message: 'The model is not supported' } }])
  await withCli(failed, async () => {
    await assert.rejects(() => openModel({ runtime: 'codex' }).extract({ schema, text: 'x' }), { name: 'ModelUnavailableError', message: /not supported/ })
  })
  const empty = mkdtempSync(join(tmpdir(), 'golem-model-empty-'))
  await withCli(empty, async () => {
    await assert.rejects(() => openModel({ runtime: 'codex' }).extract({ schema, text: 'x' }), { name: 'ModelUnavailableError', message: /codex is not installed/ })
  }, true)
})

test('the codex runtime hands each image to the CLI as -i, in order, and the prompt says how many', async () => {
  const dir = fakeCodex([
    { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: '{"title":"Board","people":[]}' } },
    { type: 'turn.completed', usage: {} },
  ])
  const a = join(dir, 'a.png')
  const b = join(dir, 'b.png')
  writeFileSync(a, 'png')
  writeFileSync(b, 'png')
  await withCli(dir, () => openModel({ runtime: 'codex' }).extract({ schema, text: 'Read the board.', images: [a, b] }))
  assert.match(readFileSync(join(dir, 'argv.txt'), 'utf8'), new RegExp(`^exec -i ${a} -i ${b} --skip-git-repo-check `))
  assert.match(readFileSync(join(dir, 'prompt.txt'), 'utf8'), /Images: 2 attached, in the order given\./)
})

test('no images leaves the codex argv and the prompt exactly as they were', async () => {
  const dir = fakeCodex([
    { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: '{"title":"t","people":[]}' } },
    { type: 'turn.completed', usage: {} },
  ])
  await withCli(dir, () => openModel({ runtime: 'codex', name: 'gpt-5.6-sol' }).extract({ schema, text: 'x' }))
  assert.equal(readFileSync(join(dir, 'argv.txt'), 'utf8'), 'exec -m gpt-5.6-sol --skip-git-repo-check --ephemeral -s read-only --json -')
  assert.doesNotMatch(readFileSync(join(dir, 'prompt.txt'), 'utf8'), /Images:/)
})

test('the claude runtime reads no images and says so before it spawns anything', async () => {
  // The fake marks the disk the moment it runs, so an unspawned CLI is a marker that is not there.
  const dir = fakeCli(`touch "$(dirname "$0")/spawned"\n${answer('{"title":"t","people":[]}')}`)
  const image = join(dir, 'a.png')
  writeFileSync(image, 'png')
  await withCli(dir, async () => {
    await assert.rejects(() => openModel().extract({ schema, text: 'x', images: [image] }), {
      name: 'ModelUnavailableError',
      message: /reads no images/,
    })
  })
  assert.equal(existsSync(join(dir, 'spawned')), false)
})

test('a path that is missing, relative or past the cap is bad input, on either runtime, and never spawns', async () => {
  const codex = fakeCodex([{ type: 'turn.completed', usage: {} }])
  const claude = fakeCli(`touch "$(dirname "$0")/spawned"\n${answer('{"title":"t","people":[]}')}`)
  const present = join(codex, 'a.png')
  writeFileSync(present, 'png')
  const cases = [
    [join(codex, 'nope.png'), /Image not readable: nope\.png/],
    ['a.png', /Image not readable: a\.png/],
  ]
  for (const [image, message] of cases) {
    await withCli(codex, async () => {
      await assert.rejects(() => openModel({ runtime: 'codex' }).extract({ schema, text: 'x', images: [image] }), { name: 'InvalidError', message })
    })
    await withCli(claude, async () => {
      await assert.rejects(() => openModel().extract({ schema, text: 'x', images: [image] }), { name: 'InvalidError', message })
    })
  }
  await withCli(codex, async () => {
    await assert.rejects(() => openModel({ runtime: 'codex' }).extract({ schema, text: 'x', images: Array(11).fill(present) }), {
      name: 'InvalidError',
      message: /At most 10 images per call\./,
    })
  })
  assert.equal(existsSync(join(codex, 'argv.txt')), false)
  assert.equal(existsSync(join(claude, 'spawned')), false)
})
