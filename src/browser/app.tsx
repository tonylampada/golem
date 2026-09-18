import { useEffect, useRef, useState } from 'react'
import { Chat, Shell } from 'golem-ui'
import UserApp from '@golem/app'
import projectConfig from '@golem/config'
import { anonymousIdentity, chat, interruptBrowserSession, navigation, restoreBrowserSession, startBrowserSession, subscribeBrowserStatus } from './adapters'

const shellAdapters = { identity: anonymousIdentity, navigation }
const chatAdapters = { chat }

export function App() {
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem('golem.theme') !== 'light' }
    catch { return true }
  })
  useEffect(() => {
    const theme = dark ? 'dark' : 'light'
    document.documentElement.dataset.golemTheme = theme
    document.documentElement.style.colorScheme = theme
    try { localStorage.setItem('golem.theme', theme) } catch { /* Theme still works without storage. */ }
  }, [dark])
  const [mode, setMode] = useState(false)
  const [session, setSession] = useState<string>()
  const [sessionStatus, setSessionStatus] = useState('starting')
  const [enteringBuildMode, setEnteringBuildMode] = useState(false)
  const enteringBuildModeRef = useRef(false)
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
    if (enteringBuildModeRef.current) return
    enteringBuildModeRef.current = true
    setEnteringBuildMode(true)
    setError(undefined)
    try { const started = await startBrowserSession(); setSession(started.id); setMode(true) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { enteringBuildModeRef.current = false; setEnteringBuildMode(false) }
  }
  const interrupt = async () => {
    try { await interruptBrowserSession() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return (
    <Shell
      config={{ title: projectConfig.title, chatSide: 'left', breakpoint: 768 }}
      adapters={shellAdapters}
      chat={
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-3 text-sm">
            <span className="font-medium">{mode ? 'Build mode' : 'Conversation mode'}</span>
            <span className={mode ? 'text-green-700 dark:text-green-400' : 'text-neutral-500 dark:text-neutral-400'}>{mode ? `${sessionStatus} · ${session}` : 'Not connected'}</span>
            {mode && (sessionStatus === 'ready' || sessionStatus === 'starting') && <button className="rounded border border-red-300 dark:border-red-800 px-2 py-1 text-red-700 dark:text-red-400" onClick={interrupt}>Interrupt</button>}
          </div>
          {!mode ? <div className="p-4 text-sm"><p className="text-neutral-600 dark:text-neutral-300">Codex: {runtime.codex ? 'available' : 'unavailable'} · Claude: not yet connected</p><button className="mt-4 rounded bg-neutral-900 dark:bg-neutral-200 px-3 py-2 text-white dark:text-neutral-900 disabled:opacity-40" disabled={!runtime.codex || enteringBuildMode} onClick={enterBuildMode}>Enter build mode</button>{error && <p className="mt-3 text-red-700 dark:text-red-400">{error}</p>}</div> : <Chat key={session} config={{ agentName: 'Golem Codex', emptyState: 'Ask Codex to inspect or explain this workspace.' }} adapters={chatAdapters} />}
        </div>
      }
      canvas={
        <UserApp />
      }
      account={
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setDark((current) => !current)}
            className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
          >
            {dark ? 'Light mode' : 'Dark mode'}
          </button>
          <span className="text-sm text-neutral-500 dark:text-neutral-400">Guest</span>
        </div>
      }
    />
  )
}
