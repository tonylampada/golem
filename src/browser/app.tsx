import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as GolemUI from 'golem-ui'
import { Auth, Chat, Shell } from 'golem-ui'
import UserApp from '@golem/app'
import projectConfig from '@golem/config'
import { currentSession, identity, type Me } from '../client'
import { anonymousIdentity, brain, chat, currentBrowserBackend, currentBrowserSession, forgetBrowserSession, navigation, restoreBrowserSession, startBrowserSession, startChatSession, subscribeBrowserStatus } from './adapters'
import { Groups } from './groups'
import { SourcePanel, SourceReturn, useSourceView, type OpenSource } from './sources'

const chatAdapters = { chat }
// `Brain` is in golem-ui after 0.1.1; with 0.1.1 installed the panel says so instead of rendering it.
const Brain = (GolemUI as unknown as { Brain?: (props: { config: { title: string; openLocation?: string }; adapters: { brain: typeof brain } }) => ReactNode }).Brain
const brainAdapters = { brain }
/** The `?brain=` route param: the location the Brain panel shows, or undefined when the app is showing. */
const brainParam = () => new URLSearchParams(window.location.search).get('brain') ?? undefined
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
  const [chatInfo, setChatInfo] = useState<{ available: boolean; detail?: string; views?: boolean }>()
  const [source, setSource] = useState<OpenSource>()
  const [sourceShown, setSourceShown] = useState(false)
  const [me, setMe] = useState<Me>()
  const [view, setView] = useState<'app' | 'account'>('app')
  const [brainAt, setBrainAt] = useState(brainParam)
  useEffect(() => navigation.subscribe(() => setBrainAt(brainParam())), [])
  const showBrain = (projectConfig as { brain?: boolean }).brain === true && brainAt !== undefined
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
  const offers = useSourceView(mode && chatting && chatInfo?.views ? session : undefined, (next) => { setSource(next); setSourceShown(true) })
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
    restoreBrowserSession(discover).then((restored) => restored || discover === 'chat' || !chatInfo?.available ? restored : restoreBrowserSession('chat')).then((restored) => {
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
  return (
    <Shell
      config={{ title: projectConfig.title, chatSide: 'left', breakpoint: 768 }}
      adapters={shellAdapters}
      chat={
        <div className="flex h-full min-h-0 flex-col">
          <div className="golem-browser-header flex items-center gap-1 whitespace-nowrap border-b border-neutral-200 bg-white px-2 py-2 text-xs">
            <span className="font-medium">{mode ? (chatting ? 'Chat' : 'Build mode') : 'Conversation mode'}</span>
            <span className={`flex min-w-0 items-center ${mode ? 'golem-browser-status-connected text-green-700' : 'golem-browser-status-disconnected text-neutral-500'}`} title={mode ? session : undefined}>
              <span className="golem-browser-status-dot" aria-hidden="true" />
              <span className="truncate">{mode ? <>{sessionStatus} <span className="opacity-60">{session?.slice(0, 8)}</span></> : 'Not connected'}</span>
            </span>
            {mode && <button className="golem-browser-new ml-auto shrink-0 rounded-full border border-neutral-300 px-2 py-1" title="New conversation" onClick={() => setMode(false)}>New</button>}
          </div>
          {!mode ? (
            <div className="p-4 text-sm">
              {chatInfo && (
                <div className="mb-4">
                  <button className="golem-browser-chat golem-browser-enter rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40" disabled={!chatInfo.available} onClick={startChat}>Start a chat</button>
                  {chatInfo.detail && <p className="golem-browser-chat-detail golem-browser-runtime mt-2 text-neutral-600">{chatInfo.detail}</p>}
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
            ? <><div className="min-h-0 flex-1"><Chat key={session} config={{ agentName: 'Assistant', emptyState: 'Ask about or update what you can see in this app.' }} adapters={chatAdapters} /></div>{offers}{source && !sourceShown && <SourceReturn source={source} onShow={() => setSourceShown(true)} />}</>
            : <Chat key={session} config={{ agentName: `Golem ${agentNames[sessionBackend ?? 'codex'] ?? sessionBackend}`, emptyState: `Ask ${agentNames[sessionBackend ?? 'codex'] ?? sessionBackend} to inspect or explain this workspace.` }} adapters={chatAdapters} />}
        </div>
      }
      canvas={
        !me ? null : <>
          {/* Mounted from the first accepted source on, so closing or switching never drops an edit. */}
          {source && <SourcePanel source={source} shown={sourceShown} onClose={() => setSourceShown(false)} />}
          {showBrain && (
            <div className="golem-browser-brain flex h-full flex-col overflow-hidden">
              <div className="golem-browser-header flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2 text-sm">
                <span className="golem-browser-runtime min-w-0 truncate font-medium">{brainAt}</span>
                <button type="button" className="golem-browser-new shrink-0 rounded border border-neutral-300 px-2 py-1" onClick={() => navigation.go(window.location.pathname)}>Back to app</button>
              </div>
              <div className="min-h-0 flex-1">
                {Brain ? <Brain config={{ title: projectConfig.title, openLocation: brainAt === 'index.md' ? undefined : brainAt }} adapters={brainAdapters} /> : <p className="p-4 text-sm text-neutral-600">The Brain reader needs golem-ui after 0.1.1 (see docs/source-development.md).</p>}
              </div>
            </div>
          )}
          <div className="h-full" style={(source && sourceShown) || showBrain ? { display: 'none' } : undefined}>{
          !authConfig ? <UserApp />
          : view === 'account' || (invited && !me.user)
            ? <div className="flex h-full flex-col overflow-auto">
                <button type="button" className="golem-browser-back m-4 self-start rounded border border-neutral-300 px-2 py-1 text-sm" onClick={() => setView('app')}>Back to app</button>
                <Auth config={authConfig} adapters={authAdapters} />
                {manages && <Groups />}
              </div>
          : accounts.guests ? <UserApp />
          : <Auth.Guard config={authConfig} adapters={authAdapters}><UserApp /></Auth.Guard>
          }</div>
        </>
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
          {(projectConfig as { brain?: boolean }).brain === true && !showBrain && <button type="button" className="golem-browser-brain-open rounded border border-neutral-300 px-2 py-1 text-sm" onClick={() => navigation.go(`${window.location.pathname}?brain=index.md`)}>Brain</button>}
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
