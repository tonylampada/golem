import { useEffect, useState } from 'react'
import { Chat, Shell } from 'golem-ui'
import UserApp from '@golem/app'
import { anonymousIdentity, chat, interruptBrowserSession, navigation, restoreBrowserSession, startBrowserSession, subscribeBrowserStatus } from './adapters'

const shellAdapters = { identity: anonymousIdentity, navigation }
const chatAdapters = { chat }

export function App() {
  const [mode, setMode] = useState(false)
  const [session, setSession] = useState<string>()
  const [sessionStatus, setSessionStatus] = useState('starting')
  const [runtime, setRuntime] = useState<{ codex: boolean; claude: boolean }>({ codex: false, claude: false })
  const [error, setError] = useState<string>()
  useEffect(() => {
    fetch('/api/runtime').then((response) => response.json()).then((result) => {
      const discoveries = result.discoveries as Array<{ agent: string; status: string; runnable: boolean }>
      setRuntime({ codex: discoveries.some((item) => item.agent === 'codex' && item.status === 'available' && item.runnable), claude: false })
    }).catch(() => setError('Runtime discovery unavailable.'))
  }, [])
  useEffect(() => {
    const unsubscribe = subscribeBrowserStatus(setSessionStatus)
    restoreBrowserSession().then((restored) => {
      if (restored) { setSession(window.sessionStorage.getItem('golem.browser.session') ?? undefined); setMode(true) }
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    return unsubscribe
  }, [])
  const enterBuildMode = async () => {
    setError(undefined)
    try { const started = await startBrowserSession(); setSession(started.id); setMode(true) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const interrupt = async () => {
    try { await interruptBrowserSession() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return (
    <Shell
      config={{ title: 'Golem', chatSide: 'left', breakpoint: 768 }}
      adapters={shellAdapters}
      chat={
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 text-sm">
            <span className="font-medium">{mode ? 'Build mode' : 'Conversation mode'}</span>
            <span className={mode ? 'text-green-700' : 'text-neutral-500'}>{mode ? `${sessionStatus} · ${session}` : 'Not connected'}</span>
            {mode && (sessionStatus === 'ready' || sessionStatus === 'starting') && <button className="rounded border border-red-300 px-2 py-1 text-red-700" onClick={interrupt}>Interrupt</button>}
          </div>
          {!mode ? <div className="p-4 text-sm"><p className="text-neutral-600">Codex: {runtime.codex ? 'available' : 'unavailable'} · Claude: not yet connected</p><button className="mt-4 rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40" disabled={!runtime.codex} onClick={enterBuildMode}>Enter build mode</button>{error && <p className="mt-3 text-red-700">{error}</p>}</div> : <Chat key={session} config={{ agentName: 'Golem Codex', emptyState: 'Ask Codex to inspect or explain this workspace.' }} adapters={chatAdapters} />}
        </div>
      }
      canvas={
        <UserApp />
      }
      account={<span className="shrink-0 text-sm text-neutral-500">Guest</span>}
    />
  )
}
