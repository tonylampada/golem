import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexBackend } from '../src/runtime/codex.ts'

const fake = (code) => new CodexBackend(process.execPath, ['-e', code])

test('Codex backend parses native JSONL and shuts down a child process', async () => {
  const backend = fake("const a=process.argv.slice(1); const resume=a.includes('resume'); if ((!resume && (!a.includes('-s') || !a.includes('read-only'))) || (resume && (!a.includes('-c') || !a.includes('sandbox_mode=\\\"read-only\\\"')))) process.exit(4); console.log(JSON.stringify({type:'thread.started',thread_id:'fake-thread'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:resume?'RESUMED_REPLY':'REAL_REPLY'}}))")
  const events = []
  await backend.start((event) => events.push(event))
  await backend.send('hello')
  assert.deepEqual(events, [{ type: 'message', text: 'REAL_REPLY' }])
  await backend.send('followup')
  assert.deepEqual(events, [{ type: 'message', text: 'REAL_REPLY' }, { type: 'message', text: 'RESUMED_REPLY' }])
  await backend.shutdown()
})

test('Codex backend escalates when a child ignores SIGTERM', async () => {
  const backend = fake("process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000)")
  await backend.start(() => {})
  const pending = backend.send('wait')
  await new Promise((resolve) => setImmediate(resolve))
  const started = Date.now()
  await backend.shutdown()
  await assert.rejects(pending)
  assert.ok(Date.now() - started < 1_000)
})
