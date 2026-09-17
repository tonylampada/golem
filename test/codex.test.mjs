import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CodexBackend } from '../src/runtime/codex.ts'

const appRoot = realpathSync(mkdtempSync(join(tmpdir(), 'golem-codex-test-')))
const fake = (code, mode = 'workspace-write') => new CodexBackend(appRoot, mode, process.execPath, ['-e', code])

async function waitFor(check, timeout = 1_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    try { return await check() } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
  }
  return check()
}

async function waitForExit(pid) {
  await waitFor(() => {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    throw new Error('still alive')
  })
}

test('Codex backend parses native JSONL, pins workspace-write to the app root, and shuts down a child process', async () => {
  const backend = fake(`
    const a = process.argv.slice(1)
    const resume = a.includes('resume')
    const sandboxOk = resume
      ? (a.includes('-c') && a.includes('sandbox_mode="workspace-write"'))
      : (a.includes('-s') && a.includes('workspace-write') && a.includes('-C') && a[a.indexOf('-C') + 1] === ${JSON.stringify(appRoot)})
    if (!sandboxOk || process.cwd() !== ${JSON.stringify(appRoot)}) process.exit(4)
    console.log(JSON.stringify({type:'thread.started',thread_id:'fake-thread'}))
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:resume?'RESUMED_REPLY':'REAL_REPLY'}}))
  `)
  const events = []
  await backend.start((event) => events.push(event))
  await backend.send('hello')
  assert.deepEqual(events, [{ type: 'message', text: 'REAL_REPLY' }])
  await backend.send('followup')
  assert.deepEqual(events, [{ type: 'message', text: 'REAL_REPLY' }, { type: 'message', text: 'RESUMED_REPLY' }])
  await backend.shutdown()
})

test('Codex backend defaults to whatever sandbox mode the caller passes, never upgrading it', async () => {
  const backend = fake(`
    const a = process.argv.slice(1)
    if (!a.includes('-s') || !a.includes('read-only') || a.includes('workspace-write')) process.exit(4)
    console.log(JSON.stringify({type:'thread.started',thread_id:'fake-thread'}))
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RO_REPLY'}}))
  `, 'read-only')
  const events = []
  await backend.start((event) => events.push(event))
  await backend.send('hello')
  assert.deepEqual(events, [{ type: 'message', text: 'RO_REPLY' }])
  await backend.shutdown()
})

test('Codex backend escalates when a child ignores SIGTERM', async () => {
  const backend = fake("process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000)")
  await backend.start(() => {})
  const pending = backend.send('wait')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const started = Date.now()
  await Promise.all([backend.shutdown(), assert.rejects(pending)])
  assert.ok(Date.now() - started < 1_000)
})

test('Codex backend shutdown kills inherited children after the parent exits on TERM', { skip: process.platform === 'win32' }, async () => {
  const marker = `/tmp/golem-inherited-${process.pid}-${Date.now()}`
  const child = `const { writeFileSync } = require('node:fs'); process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1_000)`
  const parent = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)`
  let descendant
  try {
    const backend = fake(parent)
    await backend.start(() => {})
    const pending = backend.send('wait')
    descendant = Number(await waitFor(async () => readFile(marker, 'utf8')))
    await backend.shutdown()
    await pending
    await waitForExit(descendant)
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch {} }
    await rm(marker, { force: true })
  }
})
