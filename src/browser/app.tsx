import { useEffect, useRef, useState } from 'react'
import { Auth, Chat, Shell } from 'golem-ui'
import UserApp from '@golem/app'
import projectConfig from '@golem/config'
import { currentSession, identity, type Me } from '../client'
import { anonymousIdentity, chat, currentBrowserBackend, currentBrowserSession, forgetBrowserSession, interruptBrowserSession, navigation, restoreBrowserSession, startBrowserSession, startChatSession, subscribeBrowserStatus } from './adapters'
import { Groups } from './groups'

const chatAdapters = { chat }
const authAdapters = { identity, navigation }
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
  const [chatInfo, setChatInfo] = useState<{ available: boolean; detail?: string }>()
  const [me, setMe] = useState<Me>()
  const [view, setView] = useState<'app' | 'account'>('app')
  const signedInAs = useRef<string | null>(null)
  const runnable = discoveries.filter((item) => item.status === 'available' && item.runnable).map((item) => item.agent)
  useEffect(() => {
    currentSession().then((next) => { signedInAs.current = next.user?.id ?? null; setMe(next) }, () => setError('Account service unavailable.'))
    // Another person on this browser starts clean: their own build conversation, their own view.
    return identity.subscribe(() => void currentSession().then((next) => {
      if (!next.accounts) return
      if ((next.user?.id ?? null) !== signedInAs.current) {
        // A used invite link must not reopen sign-up on the next load.
        const url = new URL(window.location.href)
        url.searchParams.delete('invite')
        forgetBrowserSession()
        window.location.replace(url)
      }
      else setMe(next)
    }))
  }, [])
  const canBuild = me?.canBuild === true
  const chatting = sessionBackend === 'anthropic'
  // Losing build access closes an open build conversation; its history stays on the server for later.
  useEffect(() => { if (me && !canBuild && !chatting) setMode(false) }, [me, canBuild, chatting])
  useEffect(() => {
    if (!me) return
    fetch('/api/chat').then(async (response) => { if (response.ok) setChatInfo(await response.json()) }).catch(() => {})
  }, [me])
  useEffect(() => {
    if (!canBuild) return
    fetch('/api/runtime').then((response) => response.json()).then((result) => {
      const found = result.discoveries as Discovery[]
      const ready = found.filter((item) => item.status === 'available' && item.runnable).map((item) => item.agent)
      let saved: string | null = null
      try { saved = localStorage.getItem(backendKey) } catch { /* No remembered choice. */ }
      setDiscoveries(found)
      setBackend([saved, result.builder, 'codex', 'claude'].find((agent) => agent && ready.includes(agent)) ?? undefined)
    }).catch(() => setError('Runtime discovery unavailable.'))
  }, [canBuild])
  const chooseBackend = (agent: string) => {
    setBackend(agent)
    try { localStorage.setItem(backendKey, agent) } catch { /* Choice still applies to this page. */ }
  }
  useEffect(() => {
    const unsubscribe = subscribeBrowserStatus(setSessionStatus)
    const discover = canBuild ? 'build' : chatInfo?.available ? 'chat' : undefined
    if (!discover) return unsubscribe
    restoreBrowserSession(discover).then((restored) => {
      if (restored) { setSession(currentBrowserSession()); setSessionBackend(currentBrowserBackend()); setMode(true) }
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    return unsubscribe
  }, [canBuild, chatInfo?.available])
  const accounts = me?.accounts
  const authConfig = accounts && { workspaceName: projectConfig.title, mode: 'password' as const, allowSignUp: accounts.allowSignUp, roles: accounts.roles }
  const manages = Boolean(me?.user?.roles.some((role) => accounts?.roles.some((one) => one.id === role && one.manages)))
  const invited = new URLSearchParams(window.location.search).has('invite')
  const shellAdapters = { identity: accounts ? identity : anonymousIdentity, navigation }
  const enterBuildMode = async () => {
    if (enteringBuildModeRef.current) return
    enteringBuildModeRef.current = true
    setEnteringBuildMode(true)
    setError(undefined)
    try { const started = await startBrowserSession(backend); setSession(started.id); setSessionBackend(started.backend); setMode(true) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { enteringBuildModeRef.current = false; setEnteringBuildMode(false) }
  }
  const startChat = async () => {
    setError(undefined)
    try { const started = await startChatSession(); setSession(started.id); setSessionBackend(started.backend); setMode(true) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
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
            <span className="font-medium">{mode ? (chatting ? 'Chat' : 'Build mode') : 'Conversation mode'}</span>
            <span className={mode ? 'golem-browser-status-connected text-green-700' : 'golem-browser-status-disconnected text-neutral-500'}>{mode ? `${sessionStatus} · ${session}` : 'Not connected'}</span>
            {mode && <button className="golem-browser-new rounded border border-neutral-300 px-2 py-1" onClick={() => setMode(false)}>New conversation</button>}
            {mode && (sessionStatus === 'ready' || sessionStatus === 'starting') && <button className="golem-browser-interrupt rounded border border-red-300 px-2 py-1 text-red-700" onClick={interrupt}>Interrupt</button>}
          </div>
          {!mode ? (
            <div className="p-4 text-sm">
              {chatInfo && (
                <div className="mb-4">
                  <button className="golem-browser-chat rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40" disabled={!chatInfo.available} onClick={startChat}>Start a chat</button>
                  {chatInfo.detail && <p className="golem-browser-chat-detail mt-2 text-neutral-600">{chatInfo.detail}</p>}
                </div>
              )}
              {me && !canBuild && <p className="golem-browser-build-denied mb-3 text-neutral-600">{me.user ? 'Your account may not build this app.' : 'Sign in with an account that may build.'}</p>}
              <p className="golem-browser-runtime text-neutral-600">
                {discoveries.length ? discoveries.map((item) => `${agentNames[item.agent] ?? item.agent}: ${item.status === 'available' && item.runnable ? 'available' : item.status === 'missing' ? 'not installed' : item.detail ?? 'unavailable'}`).join(' · ') : 'Checking agents…'}
              </p>
              {runnable.length > 1 && (
                <label className="golem-browser-runtime mt-3 flex items-center gap-2">
                  Agent
                  <select className="golem-browser-backend rounded border border-neutral-300 px-2 py-1" value={backend} onChange={(event) => chooseBackend(event.target.value)}>
                    {runnable.map((agent) => <option key={agent} value={agent}>{agentNames[agent] ?? agent}</option>)}
                  </select>
                </label>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
              <button className="golem-browser-enter rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40" disabled={!canBuild || !backend || enteringBuildMode} onClick={enterBuildMode}>Enter build mode{backend ? ` with ${agentNames[backend] ?? backend}` : ''}</button>
              {session && <button className="golem-browser-new rounded border border-neutral-300 px-3 py-2" onClick={() => setMode(true)}>Back to conversation</button>}
              </div>
              {error && <p className="golem-browser-error mt-3 text-red-700">{error}</p>}
            </div>
          ) : chatting
            ? <Chat key={session} config={{ agentName: 'Assistant', emptyState: 'Ask about or update what you can see in this app.' }} adapters={chatAdapters} />
            : <Chat key={session} config={{ agentName: `Golem ${agentNames[sessionBackend ?? 'codex'] ?? sessionBackend}`, emptyState: `Ask ${agentNames[sessionBackend ?? 'codex'] ?? sessionBackend} to inspect or explain this workspace.` }} adapters={chatAdapters} />}
        </div>
      }
      canvas={
        !me ? null
          : !authConfig ? <UserApp />
          : view === 'account' || (invited && !me.user)
            ? <div className="flex h-full flex-col overflow-auto">
                <button type="button" className="golem-browser-back m-4 self-start rounded border border-neutral-300 px-2 py-1 text-sm" onClick={() => setView('app')}>Back to app</button>
                <Auth config={authConfig} adapters={authAdapters} />
                {manages && <Groups />}
              </div>
          : accounts.guests ? <UserApp />
          : <Auth.Guard config={authConfig} adapters={authAdapters}><UserApp /></Auth.Guard>
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
          {!authConfig ? <span className="golem-browser-guest text-sm text-neutral-500">Guest</span>
            : me?.user ? <>
                {manages && <button type="button" className="golem-browser-members rounded border border-neutral-300 px-2 py-1 text-sm" onClick={() => setView('account')}>Members</button>}
                <Auth.AccountMenu config={authConfig} adapters={authAdapters} />
              </>
            : <button type="button" className="golem-browser-sign-in rounded border border-neutral-300 px-2 py-1 text-sm" onClick={() => setView('account')}>Sign in</button>}
        </div>
      }
    />
  )
}
