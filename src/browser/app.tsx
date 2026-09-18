import { useEffect, useRef, useState } from 'react'
import { Auth, Chat, Shell } from 'golem-ui'
import UserApp from '@golem/app'
import projectConfig from '@golem/config'
import { currentSession, identity, type Me } from '../client'
import { anonymousIdentity, chat, currentBrowserSession, forgetBrowserSession, interruptBrowserSession, navigation, restoreBrowserSession, startBrowserSession, subscribeBrowserStatus } from './adapters'
import { Groups } from './groups'

const chatAdapters = { chat }
const authAdapters = { identity, navigation }

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
  const [me, setMe] = useState<Me>()
  const [view, setView] = useState<'app' | 'account'>('app')
  const signedInAs = useRef<string | null>(null)
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
  // Losing build access closes the open conversation; its history stays on the server for later.
  useEffect(() => { if (me && !canBuild) setMode(false) }, [me, canBuild])
  useEffect(() => {
    if (!canBuild) return
    fetch('/api/runtime').then((response) => response.json()).then((result) => {
      const discoveries = result.discoveries as Array<{ agent: string; status: string; runnable: boolean }>
      setRuntime({ codex: discoveries.some((item) => item.agent === 'codex' && item.status === 'available' && item.runnable), claude: false })
    }).catch(() => setError('Runtime discovery unavailable.'))
  }, [canBuild])
  useEffect(() => {
    const unsubscribe = subscribeBrowserStatus(setSessionStatus)
    if (!canBuild) return unsubscribe
    restoreBrowserSession().then((restored) => {
      if (restored) { setSession(currentBrowserSession()); setMode(true) }
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    return unsubscribe
  }, [canBuild])
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
          <div className="golem-browser-header flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 text-sm">
            <span className="font-medium">{mode ? 'Build mode' : 'Conversation mode'}</span>
            <span className={mode ? 'golem-browser-status-connected text-green-700' : 'golem-browser-status-disconnected text-neutral-500'}>{mode ? `${sessionStatus} · ${session}` : 'Not connected'}</span>
            {mode && (sessionStatus === 'ready' || sessionStatus === 'starting') && <button className="golem-browser-interrupt rounded border border-red-300 px-2 py-1 text-red-700" onClick={interrupt}>Interrupt</button>}
          </div>
          {!mode ? <div className="p-4 text-sm">{me && !canBuild && <p className="golem-browser-build-denied mb-3 text-neutral-600">{me.user ? 'Your account may not build this app.' : 'Sign in with an account that may build.'}</p>}<p className="golem-browser-runtime text-neutral-600">Codex: {runtime.codex ? 'available' : 'unavailable'} · Claude: not yet connected</p><button className="golem-browser-enter mt-4 rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40" disabled={!canBuild || !runtime.codex || enteringBuildMode} onClick={enterBuildMode}>Enter build mode</button>{error && <p className="golem-browser-error mt-3 text-red-700">{error}</p>}</div> : <Chat key={session} config={{ agentName: 'Golem Codex', emptyState: 'Ask Codex to inspect or explain this workspace.' }} adapters={chatAdapters} />}
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
