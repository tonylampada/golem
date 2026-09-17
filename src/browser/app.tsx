import { useEffect, useState } from 'react'
import { Chat, Shell } from 'golem-ui'
import { anonymousIdentity, chat, navigation, startBrowserSession } from './adapters'

const shellAdapters = { identity: anonymousIdentity, navigation }
const chatAdapters = { chat }

export function App() {
  const [mode, setMode] = useState(false)
  const [session, setSession] = useState<string>()
  const [runtime, setRuntime] = useState<{ codex: boolean; claude: boolean }>({ codex: false, claude: false })
  const [error, setError] = useState<string>()
  useEffect(() => {
    fetch('/api/runtime').then((response) => response.json()).then((result) => {
      const discoveries = result.discoveries as Array<{ agent: string; status: string; runnable: boolean }>
      setRuntime({ codex: discoveries.some((item) => item.agent === 'codex' && item.status === 'available' && item.runnable), claude: false })
    }).catch(() => setError('Runtime discovery unavailable.'))
  }, [])
  const enterBuildMode = async () => {
    setError(undefined)
    try { const started = await startBrowserSession(); setSession(started.id); setMode(true) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return (
    <Shell
      config={{ title: 'Golem', chatSide: 'left', breakpoint: 768 }}
      adapters={shellAdapters}
      chat={
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 text-sm">
            <span className="font-medium">{mode ? 'Build mode' : 'Conversation mode'}</span>
            <span className={mode ? 'text-green-700' : 'text-neutral-500'}>{mode ? `Connected · ${session}` : 'Not connected'}</span>
          </div>
          {!mode ? <div className="p-4 text-sm"><p className="text-neutral-600">Codex: {runtime.codex ? 'available' : 'unavailable'} · Claude: not yet connected</p><button className="mt-4 rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40" disabled={!runtime.codex} onClick={enterBuildMode}>Enter build mode</button>{error && <p className="mt-3 text-red-700">{error}</p>}</div> : <Chat key={session} config={{ agentName: 'Golem Codex', emptyState: 'Ask Codex to inspect or explain this workspace.' }} adapters={chatAdapters} />}
        </div>
      }
      canvas={
        <section className="flex h-full min-h-64 items-center justify-center bg-neutral-50 p-6 text-center">
          <div>
            <h1 className="text-lg font-semibold">Canvas</h1>
            <p className="mt-2 text-sm text-neutral-500">The agent workspace will appear here.</p>
          </div>
        </section>
      }
      account={<span className="shrink-0 text-sm text-neutral-500">Guest</span>}
    />
  )
}
