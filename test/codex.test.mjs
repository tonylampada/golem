import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexBackend } from '../src/runtime/codex.ts'

const fake = (code) => new CodexBackend(process.execPath, ['-e', code])

test('Codex backend parses native JSONL and shuts down a child process', async () => {
  const backend = fake("console.log(JSON.stringify({type:'thread.started',thread_id:'fake-thread'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'REAL_REPLY'}}))")
  const events = []
  await backend.start((event) => events.push(event))
  await backend.send('hello')
  assert.deepEqual(events, [{ type: 'message', text: 'REAL_REPLY' }])
  await backend.shutdown()
})

test('Codex backend interruption terminates an active child cleanly', async () => {
  const backend = fake("setInterval(() => {}, 1000)")
  await backend.start(() => {})
  const pending = backend.send('wait')
  await new Promise((resolve) => setImmediate(resolve))
  await backend.interrupt()
  await pending
  await backend.shutdown()
})
