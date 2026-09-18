import { useEffect, useRef, useState } from 'react'
import { Chat, Shell } from 'golem-ui'
import UserApp from '@golem/app'
import projectConfig from '@golem/config'
import { anonymousIdentity, chat, currentBrowserBackend, currentBrowserSession, interruptBrowserSession, navigation, restoreBrowserSession, startBrowserSession, subscribeBrowserStatus } from './adapters'

const shellAdapters = { identity: anonymousIdentity, navigation }
const chatAdapters = { chat }
const agentNames: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' }
type Discovery = { agent: string; status: string; runnable?: boolean; detail?: string }
const backendKey = 'golem.backend'

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
  const [discoveries, setDiscoveries] = useState<Discovery[]>([])
  const [backend, setBackend] = useState<string>()
  const [sessionBackend, setSessionBackend] = useState<string>()
  const [error, setError] = useState<string>()
  const runnable = discoveries.filter((item) => item.status === 'available' && item.runnable).map((item) => item.agent)
  useEffect(() => {
    fetch('/api/runtime').then((response) => response.json()).then((result) => {
      const found = result.discoveries as Discovery[]
      const ready = found.filter((item) => item.status === 'available' && item.runnable).map((item) => item.agent)
      let saved: string | null = null
      try { saved = localStorage.getItem(backendKey) } catch { /* No remembered choice. */ }
      setDiscoveries(found)
      setBackend([saved, 'codex', 'claude'].find((agent) => agent && ready.includes(agent)) ?? undefined)
    }).catch(() => setError('Runtime discovery unavailable.'))
  }, [])
  const chooseBackend = (agent: string) => {
    setBackend(agent)
    try { localStorage.setItem(backendKey, agent) } catch { /* Choice still applies to this page. */ }
  }
  useEffect(() => {
    const unsubscribe = subscribeBrowserStatus(setSessionStatus)
    restoreBrowserSession().then((restored) => {
      if (restored) { setSession(currentBrowserSession()); setSessionBackend(currentBrowserBackend()); setMode(true) }
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    return unsubscribe
  }, [])
  const enterBuildMode = async () => {
    if (enteringBuildModeRef.current) return
    enteringBuildModeRef.current = true
    setEnteringBuildMode(true)
    setError(undefined)
    try { const started = await startBrowserSession(backend); setSession(started.id); setSessionBackend(started.backend); setMode(true) }
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
          <div className="golem-browser-header flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 text-sm">
            <span className="font-medium">{mode ? 'Build mode' : 'Conversation mode'}</span>
            <span className={mode ? 'golem-browser-status-connected text-green-700' : 'golem-browser-status-disconnected text-neutral-500'}>{mode ? `${sessionStatus} · ${session}` : 'Not connected'}</span>
            {mode && (sessionStatus === 'ready' || sessionStatus === 'starting') && <button className="golem-browser-interrupt rounded border border-red-300 px-2 py-1 text-red-700" onClick={interrupt}>Interrupt</button>}
          </div>
          {!mode ? (
            <div className="p-4 text-sm">
              <p className="golem-browser-runtime text-neutral-600">
                {discoveries.length ? discoveries.map((item) => `${agentNames[item.agent] ?? item.agent}: ${item.status === 'available' && item.runnable ? 'available' : item.status === 'missing' ? 'not installed' : item.detail ?? 'unavailable'}`).join(' · ') : 'Checking agents…'}
              </p>
              {runnable.length > 1 && (
                <label className="mt-3 flex items-center gap-2">
                  Agent
                  <select className="golem-browser-backend rounded border border-neutral-300 px-2 py-1" value={backend} onChange={(event) => chooseBackend(event.target.value)}>
                    {runnable.map((agent) => <option key={agent} value={agent}>{agentNames[agent] ?? agent}</option>)}
                  </select>
                </label>
              )}
              <button className="golem-browser-enter mt-4 rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40" disabled={!backend || enteringBuildMode} onClick={enterBuildMode}>Enter build mode{backend ? ` with ${agentNames[backend] ?? backend}` : ''}</button>
              {error && <p className="golem-browser-error mt-3 text-red-700">{error}</p>}
            </div>
          ) : <Chat key={session} config={{ agentName: `Golem ${agentNames[sessionBackend ?? 'codex'] ?? sessionBackend}`, emptyState: `Ask ${agentNames[sessionBackend ?? 'codex'] ?? sessionBackend} to inspect or explain this workspace.` }} adapters={chatAdapters} />}
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
            className="golem-browser-theme-toggle rounded border border-neutral-300 px-2 py-1 text-sm"
          >
            {dark ? 'Light mode' : 'Dark mode'}
          </button>
          <span className="golem-browser-guest text-sm text-neutral-500">Guest</span>
        </div>
      }
    />
  )
}
