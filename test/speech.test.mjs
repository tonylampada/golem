import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fixtureApp } from './fixtures/app.mjs'

/** A faster-whisper stand-in: it answers `/health` and echoes what the multipart body carried. */
async function fakeWhisper() {
  const seen = []
  const server = createServer((request, response) => {
    if (request.url === '/health') return json(response, { status: 'ok', model: 'large-v3-turbo' })
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1')
      seen.push({ url: request.url, body, type: request.headers['content-type'] })
      json(response, { text: ' abre a questão quarenta e sete ', language: 'pt' })
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

const json = (response, body) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }

test('speech config: both providers are accepted, anything else is refused', async () => {
  const { loadAppConfig } = await import('../src/config.ts')
  const load = (speech) => {
    const root = mkdtempSync(join(tmpdir(), 'golem-speech-config-'))
    writeFileSync(join(root, 'golem.config.ts'), `export default { speech: ${JSON.stringify(speech)} }\n`)
    return loadAppConfig(root)
  }
  assert.deepEqual((await load({ provider: 'whisper', url: 'http://127.0.0.1:8878', language: 'pt' })).speech,
    { provider: 'whisper', url: 'http://127.0.0.1:8878', language: 'pt' })
  assert.deepEqual((await load({ provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' })).speech,
    { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' })
  await assert.rejects(load({ provider: 'deepgram', url: 'http://x' }), /speech\.provider must be 'whisper' or 'openai'/)
  await assert.rejects(load({ provider: 'whisper' }), /speech\.url must be a nonempty string/)
  await assert.rejects(load({ provider: 'whisper', url: 'ws://127.0.0.1:8878' }), /speech\.url must be an http\(s\) URL/)
  await assert.rejects(load({ provider: 'whisper', url: 'http://x', model: 'large' }), /apiKeyEnv and model are openai fields/)
  await assert.rejects(load({ provider: 'openai' }), /speech\.apiKeyEnv must be a nonempty string/)
  await assert.rejects(load({ provider: 'whisper', url: 'http://x', voice: 'alloy' }), /speech has unknown fields: voice/)
})

test('the whisper adapter posts the audio and returns the trimmed text; a dead service is one short message', async () => {
  const { transcribe, probeSpeech } = await import('../src/backend/speech.ts')
  const whisper = await fakeWhisper()
  try {
    const config = { provider: 'whisper', url: `${whisper.url}/`, language: 'pt' }
    assert.equal(await transcribe(config, Buffer.from('fake opus bytes'), 'audio/webm;codecs=opus'), 'abre a questão quarenta e sete')
    const [call] = whisper.seen
    assert.equal(call.url, '/transcribe')
    assert.match(call.body, /name="file"; filename="audio.webm"/)
    assert.match(call.body, /name="language"[\s\S]*pt/)
    assert.match(call.body, /fake opus bytes/)
    assert.match(await probeSpeech(config), /whisper at .* \(large-v3-turbo\)/)
  } finally { whisper.close() }
  const gone = { provider: 'whisper', url: 'http://127.0.0.1:1' }
  await assert.rejects(transcribe(gone, Buffer.from('x'), 'audio/webm'), /The speech service did not answer/)
  assert.match(await probeSpeech(gone), /is not answering/)
})

test('POST /api/speech/transcribe: without `speech` in the config the route is not there at all', { timeout: 120000 }, async () => {
  const root = fixtureApp(mkdtempSync(join(tmpdir(), 'golem-speech-none-')))
  writeFileSync(join(root, 'golem.config.ts'), "export default { title: 'Field Notes', chat: { provider: 'tmux' } }\n")
  // A second dev server in this process would reuse the first root: `appRoot` is read when the module loads.
  writeFileSync(join(root, 'runner.mjs'), `
import { startDevServer } from ${JSON.stringify(resolve(import.meta.dirname, '../src/dev-server.ts'))}
const worker = () => ({ start: async () => {}, send: async () => new Promise(() => {}), interrupt: async () => {}, shutdown: async () => {} })
await startDevServer(3249, worker, ${JSON.stringify(join(root, '.golem'))})
console.log('listening')
`)
  const child = spawn(process.execPath, ['runner.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    await new Promise((done, fail) => { child.stdout.on('data', (chunk) => String(chunk).includes('listening') && done()); child.once('exit', fail) })
    const said = await fetch('http://127.0.0.1:3249/api/speech/transcribe', { method: 'POST', body: Buffer.from('x'), headers: { 'Content-Type': 'audio/webm' } })
    assert.equal(said.status, 404)
    assert.equal((await (await fetch('http://127.0.0.1:3249/api/chat')).json()).speech, undefined)
  } finally { child.kill() }
})

test('POST /api/speech/transcribe: configured, it answers the text; an oversize recording is refused', { timeout: 120000 }, async () => {
  const whisper = await fakeWhisper()
  const root = fixtureApp(mkdtempSync(join(tmpdir(), 'golem-speech-route-')))
  writeFileSync(join(root, 'golem.config.ts'), `export default { title: 'Field Notes', chat: { provider: 'tmux' }, speech: ${JSON.stringify({ provider: 'whisper', url: whisper.url, language: 'pt' })} }\n`)
  process.chdir(root)
  const worker = () => ({ start: async () => {}, send: async () => new Promise(() => {}), interrupt: async () => {}, shutdown: async () => {} })
  const { startDevServer } = await import('../src/dev-server.ts')
  const post = (body, type = 'audio/webm') => fetch('http://127.0.0.1:3248/api/speech/transcribe', { method: 'POST', body, headers: { 'Content-Type': type } })
  const server = await startDevServer(3248, worker, join(root, '.golem'))
  try {
    const said = await post(Buffer.from('fake opus bytes'))
    assert.equal(said.status, 200)
    assert.equal((await said.json()).text, 'abre a questão quarenta e sete')
    // The browser only shows the microphone when the bootstrap says the app has speech.
    assert.equal((await (await fetch('http://127.0.0.1:3248/api/chat')).json()).speech, true)
    const big = await post(Buffer.alloc(16_000_000))
    assert.equal(big.status, 413)
    assert.match((await big.json()).error, /larger than 15000000 bytes/)
  } finally {
    await new Promise((done) => server.close(done))
    whisper.close()
  }
})
