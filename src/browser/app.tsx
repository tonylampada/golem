import { useEffect, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import * as GolemUI from 'golem-ui'
import { Auth, Chat, Shell } from 'golem-ui'
import * as AppModule from '@golem/app'
import projectConfig from '@golem/config'
import { currentSession, identity, type Me } from '../client'
import { anonymousIdentity, brain, chat, currentBrowserBackend, leaveBrowserSession, forgetBrowserSession, navigation, restoreBrowserSession, startBrowserSession, subscribeBrowserSession, subscribeBrowserStatus, type SessionKind } from './adapters'
import { Groups } from './groups'
import { SourcePanel, SourceReturn, useSourceView, type OpenSource } from './sources'
import { Terminal } from './terminal'

const chatAdapters = { chat }
// `Brain` is in golem-ui after 0.1.1; with 0.1.1 installed the panel says so instead of rendering it.
const Brain = (GolemUI as unknown as { Brain?: (props: { config: { title: string; openLocation?: string }; adapters: { brain: typeof brain } }) => ReactNode }).Brain
// The Shell chrome after golem-ui 29acbd5: a menu row, a settings dropdown, the chat behind a toggle. 0.1.1's
// strict schema would reject the keys, so they go in only when `Shell.Setting` (same vintage) is there.
type ShellSetting = (props: { icon: ReactNode; label: string; on?: boolean; onClick: () => void }) => ReactNode
type ShellIcon = (props: { name: 'user' | 'wrench' }) => ReactNode
const { Setting: ShellSetting, Icon: ShellIcon } = Shell as unknown as { Setting?: ShellSetting; Icon?: ShellIcon }
const ShellFrame = Shell as unknown as (props: Omit<ComponentProps<typeof Shell>, 'config'> & {
  config: ComponentProps<typeof Shell>['config'] & { menu?: { id: string; label: string; icon?: string }[]; activeId?: string; chatOpen?: boolean }
  settings?: ReactNode
  onSelect?: (id: string) => void
}) => ReactNode
// An app with more than one screen lists them (`export const screens`); each becomes an item in the
// menu row, and the chosen one's id goes to the app as `screen`. Read through a cast, like the other
// optional things here, because an app that lists none is the single-screen app it always was.
const UserApp = AppModule.default as ComponentType<{ screen?: string }>
type AppScreen = { id: string; label: string; icon?: string }
const appScreens = (AppModule as { screens?: AppScreen[] }).screens ?? []
/** The `?screen=` route param: which of the app's own screens is showing. */
const screenParam = () => new URLSearchParams(window.location.search).get('screen') ?? undefined
const screenUrl = (id?: string) => (id ? `${window.location.pathname}?screen=${encodeURIComponent(id)}` : window.location.pathname)
/** The `?brain=` route param: the location the Brain panel shows, or undefined when the app is showing. */
const brainParam = () => new URLSearchParams(window.location.search).get('brain') ?? undefined
const brainUrl = (location: string) => `${window.location.pathname}?brain=${encodeURIComponent(location)}`
// What the reader opens on its own goes into the URL, so a reload (a Builder rebuild, a sign-in
// change) lands on the same document instead of the root index.
const brainAdapters = { brain: { ...brain, open: (location: string) => navigation.go(brainUrl(location)) } }
const authAdapters = { identity, navigation }
const agentNames: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' }
type Discovery = { agent: string; status: string; runnable?: boolean; detail?: string }

export function App() {
  // Builder mode is app state, kept on the server (`.golem/builder.json`) so a reload comes back in it.
  const [builder, setBuilder] = useState<boolean>()
  const [session, setSession] = useState<string>()
  const [sessionStatus, setSessionStatus] = useState('starting')
  const [sessionBackend, setSessionBackend] = useState<string>()
  const [error, setError] = useState<string>()
  const [chatInfo, setChatInfo] = useState<{ provider: 'tmux' | 'anthropic' | null; agent?: string; available: boolean; detail?: string; views?: boolean }>()
  const [source, setSource] = useState<OpenSource>()
  const [sourceShown, setSourceShown] = useState(false)
  const [me, setMe] = useState<Me>()
  // The Admin screen is app state; any navigation (the title, a Brain item, a chip) leaves it.
  const [view, setView] = useState<'app' | 'account'>('app')
  const [brainAt, setBrainAt] = useState(brainParam)
  const [screenAt, setScreenAt] = useState(screenParam)
  useEffect(() => navigation.subscribe(() => { setBrainAt(brainParam()); setScreenAt(screenParam()); setView('app') }), [])
  const showBrain = (projectConfig as { brain?: boolean }).brain === true && brainAt !== undefined
  // An unknown `?screen=` is the app's first screen, not an error.
  const screen = appScreens.some((one) => one.id === screenAt) ? screenAt : undefined
  const [terminal, setTerminal] = useState(false)
  const signedInAs = useRef<string | null>(null)
  useEffect(() => {
    currentSession().then((next) => { signedInAs.current = next.user?.id ?? null; setMe(next) }, () => setError('Account service unavailable.'))
    // Another person on this browser starts clean: their own build conversation, their own view.
    return identity.subscribe(() => void currentSession().then((next) => {
      if (!next.accounts) return
      if ((next.user?.id ?? null) !== signedInAs.current) {
        // A used invite link must not reopen sign-up on the next load.
        const url = new URL(window.location.href)
        for (const param of ['invite', 'reset']) url.searchParams.delete(param)
        forgetBrowserSession()
        window.location.replace(url)
      }
      else setMe(next)
    }))
  }, [])
  const canBuild = me?.canBuild === true
  const chatting = sessionBackend === 'anthropic'
  const offers = useSourceView(!builder && chatting && chatInfo?.views ? session : undefined, (next) => { setSource(next); setSourceShown(true) })
  useEffect(() => {
    if (!me) return
    fetch('/api/chat').then(async (response) => { if (response.ok) setChatInfo(await response.json()) }).catch(() => {})
    fetch('/api/builder').then(async (response) => setBuilder(response.ok ? Boolean((await response.json()).builder) : false)).catch(() => setBuilder(false))
  }, [me])
  useEffect(() => subscribeBrowserStatus(setSessionStatus), [])
  useEffect(() => subscribeBrowserSession(setSession), [])
  // What the chat column shows: the builder agent, or whatever the app defines for normal mode (maybe nothing).
  const kind: SessionKind | undefined = builder === undefined || !chatInfo ? undefined : builder && canBuild ? 'builder' : chatInfo.provider === 'tmux' ? 'chat' : chatInfo.provider === 'anthropic' ? 'anthropic' : undefined
  useEffect(() => {
    setError(undefined)
    setTerminal(false)
    if (!kind) { leaveBrowserSession(); setSession(undefined); setSessionBackend(undefined); return }
    let cancelled = false
    const open = async () => {
      // A terminal agent: the configured one, else what this computer has (the server picks per intent).
      const runtime = kind === 'anthropic' ? undefined : await fetch('/api/runtime').then((response) => response.json()) as { discoveries: Discovery[]; builder?: string } | undefined
      const ready = runtime?.discoveries?.filter((item) => item.status === 'available' && item.runnable).map((item) => item.agent) ?? []
      const agent = kind === 'anthropic' ? undefined : [kind === 'chat' ? chatInfo?.agent : undefined, runtime?.builder, 'codex', 'claude'].find((one) => one && ready.includes(one))
      if (await restoreBrowserSession(kind)) return
      if (kind !== 'anthropic' && !agent) throw new Error(`No agent to chat with: ${runtime?.discoveries?.map((item) => `${agentNames[item.agent] ?? item.agent} ${item.status === 'missing' ? 'not installed' : item.detail ?? item.status}`).join(', ') || 'checking agents…'}`)
      if (kind === 'anthropic' && !chatInfo?.available) throw new Error(chatInfo?.detail ?? 'Chat is not available.')
      await startBrowserSession(agent, kind)
    }
    open().then(() => { if (!cancelled) { setSessionBackend(currentBrowserBackend()) } }, (cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [kind])
  const toggleBuilder = async (on: boolean) => {
    setBuilder(on)
    const response = await fetch('/api/builder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ builder: on }) })
    if (!response.ok) { setError((await response.json()).error ?? 'Unable to switch mode'); setBuilder(!on) }
  }
  const accounts = me?.accounts
  const authConfig = accounts && { workspaceName: projectConfig.title, mode: 'password' as const, allowSignUp: accounts.allowSignUp, roles: accounts.roles }
  const manages = Boolean(me?.user?.roles.some((role) => accounts?.roles.some((one) => one.id === role && one.manages)))
  // An invite or a reset link opens the Auth card even before anyone is signed in. Read once, so
  // spending the link — which takes its token out of the URL — does not swap the card mid-flow.
  const [invited] = useState(() => ['invite', 'reset'].some((param) => new URLSearchParams(window.location.search).has(param)))
  const shellAdapters = { identity: accounts ? identity : anonymousIdentity, navigation }
  const hasBrain = (projectConfig as { brain?: boolean }).brain === true
  // The bottom menu bar: the app's own screens first, then Brain, then Admin for managers.
  const menu = [
    { id: 'app', label: projectConfig.title, icon: '🏠' },
    ...appScreens.map((one) => ({ id: `screen:${one.id}`, label: one.label, ...(one.icon ? { icon: one.icon } : {}) })),
    ...(hasBrain ? [{ id: 'brain', label: 'Brain', icon: '🧠' }] : []),
    ...(manages ? [{ id: 'admin', label: 'Admin', icon: '🛠️' }] : []),
  ]
  // An app item leaves `?brain=` and the Admin view and carries its own `?screen=`; Brain opens its own.
  const select = (id: string) => {
    if (id === 'brain') { if (!showBrain) navigation.go(brainUrl('index.md')); return }
    const target = id.startsWith('screen:') ? id.slice('screen:'.length) : undefined
    if (showBrain || screenAt !== target) navigation.go(screenUrl(target))
    setView(id === 'admin' ? 'account' : 'app')
  }
  const barButton = 'golem-browser-bar-button flex size-8 items-center justify-center rounded-lg border'
  return (
    <ShellFrame
      config={{ title: projectConfig.title, chatSide: 'left', breakpoint: 768,
        // Builder on raises the chat; a mode that is off leaves the chat where the reader left it.
        ...(ShellSetting ? { menu, activeId: showBrain ? 'brain' : view === 'account' ? 'admin' : screen ? `screen:${screen}` : 'app', chatOpen: builder === true } : {}) }}
      adapters={shellAdapters}
      onSelect={select}
      settings={ShellSetting && canBuild && builder !== undefined && (
        <ShellSetting icon={ShellIcon ? <ShellIcon name="wrench" /> : '🔧'} label="Builder" on={builder} onClick={() => void toggleBuilder(!builder)} />
      )}
      chat={!kind ? null : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="golem-browser-header flex items-center gap-1 whitespace-nowrap border-b border-neutral-200 bg-white px-2 py-2 text-xs">
            <span className="font-medium">{kind === 'builder' ? 'Builder' : 'Chat'}</span>
            <span className={`flex min-w-0 items-center ${session ? 'golem-browser-status-connected text-green-700' : 'golem-browser-status-disconnected text-neutral-500'}`} title={session}>
              <span className="golem-browser-status-dot" aria-hidden="true" />
              <span className="truncate">{session ? <>{sessionStatus} <span className="opacity-60">{session.slice(0, 8)}</span></> : error ? 'Not connected' : 'Connecting…'}</span>
            </span>
            {session && !chatting && <button type="button" className="golem-browser-terminal ml-auto shrink-0 rounded-full border border-neutral-300 px-2 py-1" title="Agent terminal" aria-label="Agent terminal" onClick={() => setTerminal(true)}>🖥️</button>}
          </div>
          {terminal && session && !chatting && <Terminal session={session} onClose={() => setTerminal(false)} />}
          {error && <p className="golem-browser-error px-4 pt-3 text-sm text-red-700">{error}</p>}
          {session && (chatting
            ? <><div className="min-h-0 flex-1"><Chat key={session} config={{ agentName: 'Assistant', emptyState: 'Ask about or update what you can see in this app.' }} adapters={chatAdapters} /></div>{offers}{source && !sourceShown && <SourceReturn source={source} onShow={() => setSourceShown(true)} />}</>
            : <Chat key={kind} config={{ agentName: `Golem ${agentNames[sessionBackend ?? 'codex'] ?? sessionBackend}`, emptyState: kind === 'builder' ? `Ask ${agentNames[sessionBackend ?? 'codex'] ?? sessionBackend} to build or change this app.` : 'Ask about this app.' }} adapters={chatAdapters} />)}
        </div>
      )}
      canvas={
        !me ? null : <>
          {/* Mounted from the first accepted source on, so closing or switching never drops an edit. */}
          {source && <SourcePanel source={source} shown={sourceShown} onClose={() => setSourceShown(false)} />}
          {showBrain && (
            <div className="golem-browser-brain h-full overflow-hidden">
              {Brain ? <Brain config={{ title: projectConfig.title, openLocation: brainAt === 'index.md' ? undefined : brainAt }} adapters={brainAdapters} /> : <p className="p-4 text-sm text-neutral-600">The Brain reader needs golem-ui after 0.1.1 (see docs/source-development.md).</p>}
            </div>
          )}
          <div className="h-full" style={(source && sourceShown) || showBrain ? { display: 'none' } : undefined}>{
          !authConfig ? <UserApp screen={screen} />
          : view === 'account' || (invited && !me.user)
            ? <div className="golem-browser-admin flex h-full flex-col overflow-auto">
                <Auth config={authConfig} adapters={authAdapters} />
                {manages && <Groups />}
              </div>
          : accounts.guests ? <UserApp screen={screen} />
          : <Auth.Guard config={authConfig} adapters={authAdapters}><UserApp screen={screen} /></Auth.Guard>
          }</div>
        </>
      }
      account={
        !authConfig ? <span className="golem-browser-guest text-sm text-neutral-500">Guest</span>
          : me?.user ? <Auth.AccountMenu config={authConfig} adapters={authAdapters} />
          : <button type="button" className={`golem-browser-sign-in ${barButton}`} title="Sign in" aria-label="Sign in" onClick={() => setView('account')}>{ShellIcon ? <ShellIcon name="user" /> : '👤'}</button>
      }
    />
  )
}
