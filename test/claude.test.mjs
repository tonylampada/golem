import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ClaudeBackend } from '../src/runtime/claude.ts'
import { discoverAgents, runtimeState } from '../src/runtime/discovery.ts'

const appRoot = realpathSync(mkdtempSync(join(tmpdir(), 'golem-claude-test-')))
// `--` keeps node from reading Claude's own flags (`-p`) as its options.
const fake = (code, mode = 'danger-full-access', sessionId) => new ClaudeBackend(appRoot, mode, process.execPath, ['-e', code, '--'], sessionId)
const script = (body) => `
  const a = process.argv.slice(1)
  const flag = (name) => a.includes(name) ? a[a.indexOf(name) + 1] : undefined
  const out = (event) => console.log(JSON.stringify(event))
  let input = ''
  process.stdin.on('data', (chunk) => { input += chunk }).on('end', () => { ${body} })
`

test('Claude backend streams native JSON, resumes its session, and sends builder guidance every turn', async () => {
  const backend = fake(script(`
    if (!a.includes('-p') || flag('--output-format') !== 'stream-json') process.exit(3)
    const guide = flag('--append-system-prompt')
    if (!guide || !guide.includes("Golem's in-app builder") || !guide.includes(${JSON.stringify(appRoot)})) process.exit(5)
    if (flag('--permission-mode') !== 'bypassPermissions' || a.includes('--tools') || a.includes('--strict-mcp-config') || process.cwd() !== ${JSON.stringify(appRoot)}) process.exit(4)
    const resumed = flag('--resume')
    if (resumed && resumed !== 'native-1') process.exit(6)
    out({ type: 'system', subtype: 'init', session_id: 'native-1' })
    out({ type: 'assistant', session_id: 'native-1', parent_tool_use_id: 'tool-1', message: { content: [{ type: 'text', text: 'SUBAGENT' }] } })
    out({ type: 'assistant', session_id: 'native-1', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: (resumed ? 'RESUMED:' : 'FRESH:') + input }] } })
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-1', result: 'ignored' })
  `))
  const events = []
  await backend.start((event) => events.push(event))
  await backend.send('hello')
  assert.equal(backend.threadId(), 'native-1')
  await backend.send('followup')
  assert.deepEqual(events, [{ type: 'message', text: 'FRESH:hello' }, { type: 'message', text: 'RESUMED:followup' }])
  await backend.shutdown()
})

test('Claude read-only sessions get only read built-ins and no MCP servers', async () => {
  const backend = fake(script(`
    if (flag('--tools') !== 'Read,Grep,Glob' || flag('--permission-mode') !== 'dontAsk' || a.includes('bypassPermissions')) process.exit(4)
    if (!a.includes('--strict-mcp-config') || flag('--mcp-config') !== '{"mcpServers":{}}') process.exit(7)
    out({ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'RO' }] } })
  `), 'read-only')
  const events = []
  await backend.start((event) => events.push(event))
  await backend.send('hi')
  assert.deepEqual(events, [{ type: 'message', text: 'RO' }])
})

test('Claude sign-in failures surface once as an error, not as an agent reply', async () => {
  const backend = fake(script(`
    out({ type: 'assistant', session_id: 's', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } })
    out({ type: 'result', subtype: 'success', is_error: true, session_id: 's', result: 'Not logged in · Please run /login' })
    process.exitCode = 1
  `))
  const events = []
  await backend.start((event) => events.push(event))
  await assert.rejects(backend.send('hi'), /Not logged in/)
  assert.deepEqual(events, [{ type: 'error', message: 'Not logged in · Please run /login' }])
})

test('Claude interrupt stops the running turn without an error', async () => {
  const backend = fake(script(`out({ type: 'system', subtype: 'init', session_id: 'long' }); setInterval(() => {}, 1000)`))
  const events = []
  await backend.start((event) => events.push(event))
  const pending = backend.send('wait')
  await new Promise((resolve) => setTimeout(resolve, 150))
  await backend.interrupt()
  await pending
  assert.deepEqual(events, [])
  assert.equal(backend.threadId(), 'long')
})

test('Claude is runnable only when installed and signed in; detection never starts a turn', async () => {
  const calls = []
  const probe = (signedIn) => async (executable, args) => {
    calls.push([executable, ...args].join(' '))
    return executable === 'claude' && args[0] === 'auth' && !signedIn ? { status: 'failed', detail: 'exited with code 1' } : { status: 'available' }
  }
  const signedOut = await discoverAgents(probe(false))
  assert.deepEqual(signedOut.map(({ agent, runnable }) => [agent, runnable]), [['claude', false], ['codex', true]])
  assert.match(signedOut[0].detail, /not signed in/)
  assert.deepEqual(runtimeState(signedOut), { kind: 'ready', backend: 'codex' })
  assert.deepEqual(runtimeState(await discoverAgents(probe(true))).kind, 'choice-required')
  assert.deepEqual([...new Set(calls)].sort(), ['claude --version', 'claude auth status', 'codex --version'].sort())
})
