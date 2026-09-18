import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Editor, type RecordsAdapter } from 'golem-ui'
import { knowledge, type ViewOffer } from '../client'
import { answerOffer, subscribeChatView } from './adapters'

/** An accepted passage: `line`–`endLine` hold `text` in file `version`. */
export type OpenSource = ViewOffer['input'] & { key: string; version: number; text: string }

/**
 * This tab's view of the open chat: the assistant's offers to open a source, answered here. Only an
 * offer the person accepts in this tab opens, and only here.
 */
export function useSourceView(conversation: string | undefined, onOpen: (source: OpenSource) => void) {
  const [offers, setOffers] = useState<ViewOffer[]>([])
  const [error, setError] = useState<string>()
  const open = useRef(onOpen)
  open.current = onOpen
  useEffect(() => {
    setOffers([])
    if (!conversation) return
    return subscribeChatView((event) => {
      if (event.type === 'offer' && event.offer.conversation === conversation) setOffers((list) => [...list.filter((one) => one.id !== event.offer.id), event.offer])
      if (event.type === 'withdrawn') setOffers((list) => list.filter((one) => one.id !== event.id))
      if (event.type === 'apply') open.current({ ...event.offer.input, key: event.offer.id, version: event.version, text: event.text })
    })
  }, [conversation])
  const answer = async (offer: ViewOffer, accept: boolean) => {
    setError(undefined)
    setOffers((list) => list.filter((one) => one.id !== offer.id))
    try { await answerOffer(offer.id, accept) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const panel = (offers.length > 0 || error) && (
    <div className="golem-browser-offers golem-browser-header border-t border-neutral-200 px-4 py-2 text-sm">
      {offers.map((offer) => (
        <div key={offer.id} className="golem-browser-offer flex flex-wrap items-center gap-2 py-1">
          <span className="golem-browser-runtime min-w-0 flex-1 break-words">Open {offer.input.path}, lines {offer.input.line}–{offer.input.endLine}?</span>
          <button className="golem-browser-enter rounded bg-neutral-900 px-2 py-1 text-white" onClick={() => void answer(offer, true)}>Open</button>
          <button className="golem-browser-new rounded border border-neutral-300 px-2 py-1" onClick={() => void answer(offer, false)}>Dismiss</button>
        </div>
      ))}
      {error && <p className="golem-browser-error text-red-700">{error}</p>}
    </div>
  )
  return panel || null
}

const clock = { now: () => new Date(), timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone }
// `focus` is in golem-ui's Editor after 0.1.1. With 0.1.1 installed the prop is ignored: the file opens
// at the top and the header's line numbers are the only pointer to the passage.
type FocusedEditor = (props: ComponentProps<typeof Editor> & { focus?: { line: number; endLine?: number; key?: string } }) => ReturnType<typeof Editor>
const SourceEditor = Editor as unknown as FocusedEditor
// The latest version of each file the Editor was handed, and its body, so a passage is marked only
// once the Editor shows the text its lines were counted in.
type Seen = { version: number; body: string; at: number }
const seen = new Map<string, Seen>()
const seenListeners = new Set<() => void>()
const settle = 150
const note = (root: string, path: string, record: unknown, body?: string) => {
  const found = record as { version?: unknown; body?: unknown } | null | undefined
  if (typeof found?.version !== 'number') return
  const text = typeof found.body === 'string' ? found.body : body
  if (text === undefined) return
  const before = seen.get(`${root}/${path}`)
  if (before && before.version > found.version) return
  seen.set(`${root}/${path}`, { version: found.version, body: text, at: Date.now() })
  // The Editor takes the record after this returns; look again once it has had time to show it.
  setTimeout(() => { for (const listener of seenListeners) listener() }, settle)
}
const tracked: RecordsAdapter = {
  ...knowledge,
  get: async <T,>(root: string, path: string) => { const record = await knowledge.get<T>(root, path); note(root, path, record); return record },
  update: async <T,>(root: string, path: string, patch: Record<string, unknown>, options?: Parameters<RecordsAdapter['update']>[3]) => {
    try {
      const record = await knowledge.update<T>(root, path, patch, options)
      note(root, path, record, typeof patch.body === 'string' ? patch.body : undefined)
      return record
    } catch (error) { note(root, path, (error as { record?: unknown }).record); throw error }
  },
}
const adapters = { records: tracked, clock }
// Editor statuses whose text is not yet in the file: an edit waiting to save, a save in flight, a
// refused save or a conflict waiting for the person.
const unsavedStatus = new Set(['dirty', 'saving', 'error', 'conflict'])

/**
 * The accepted sources in one golem-ui Editor, scrolled to the offered passage. It stays mounted for the
 * page's life: moving to another source parks this one's draft or conflict in the Editor, and closing
 * only hides it, so neither loses an edit. Leaving the page with an edit unsaved asks first.
 */
export function SourcePanel({ source, shown, onClose }: { source: OpenSource; shown: boolean; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null)
  const record = `${source.root}/${source.path}`
  const current = useRef(record)
  current.current = record
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  // The accepted passage waits here until the Editor shows its version or a later one, then is found in the text on screen.
  const wanted = useRef<OpenSource | undefined>(undefined)
  const [focus, setFocus] = useState<{ line: number; endLine: number; key: string }>()
  const [marked, setMarked] = useState<{ line: number; endLine: number }>()
  const [unmarked, setUnmarked] = useState<string>()
  const check = useRef(() => {})
  check.current = () => {
    const want = wanted.current
    const element = root.current
    if (!want || !element || current.current !== `${want.root}/${want.path}`) return
    const has = seen.get(`${want.root}/${want.path}`)
    const editor = element.querySelector('[data-golem-status]')
    const status = editor?.getAttribute('data-golem-status')
    // The Editor must hold the passage's version or a later one, merged into what is on screen.
    const version = Number(element.querySelector('[data-golem-version]')?.getAttribute('data-golem-version') ?? NaN)
    const taken = Number.isFinite(version) ? version : has && Date.now() - has.at >= settle ? has.version : -1
    if (taken < want.version || !has) return
    // A load or a conflict waiting for the person: the text on screen is about to change.
    if (status !== 'saved' && status !== 'dirty' && status !== 'saving' && status !== 'error') return
    const text = element.querySelector<HTMLTextAreaElement>('[data-golem-pane="source"] textarea')?.value ?? (status === 'saved' ? has.body : undefined)
    // A clean save at that version for a status of 'saved' that has not re-rendered yet: wait for it.
    if (status === 'saved' && text !== has.body) return
    wanted.current = undefined
    // Only the file exactly as counted vouches for the offered lines; any other text is searched.
    const clean = status === 'saved' && has.version === want.version
    const found = text === undefined ? { lines: [] } : locate(text, want, clean)
    if (found.lines.length === 1) {
      const [line] = found.lines as [number]
      const endLine = line + want.endLine - want.line
      setMarked({ line, endLine })
      setFocus({ line, endLine, key: want.key })
    } else setUnmarked(found.lines.length > 1 ? 'the passage appears more than once in your text' : 'the passage is not in the text on screen')
  }
  useEffect(() => {
    wanted.current = source
    setFocus(undefined)
    setMarked(undefined)
    setUnmarked(undefined)
    check.current()
  }, [source.key])
  useEffect(() => {
    const element = root.current
    if (!element) return
    // The last status each source showed; a source moved away from keeps it, since the Editor parks it as it was.
    const read = () => {
      const status = element.querySelector('[data-golem-status]')?.getAttribute('data-golem-status')
      if (status) setStatuses((all) => all[current.current] === status ? all : { ...all, [current.current]: status })
      check.current()
    }
    const observer = new MutationObserver(read)
    observer.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-golem-status'] })
    const onSeen = () => check.current()
    seenListeners.add(onSeen)
    read()
    return () => { observer.disconnect(); seenListeners.delete(onSeen) }
  }, [])
  const unsaved = Object.keys(statuses).filter((key) => unsavedStatus.has(statuses[key]!))
  useEffect(() => {
    if (!unsaved.length) return
    const ask = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [unsaved.length])
  const config = useMemo(() => ({ collection: source.root, id: source.path, preview: 'toggle' as const }), [source.root, source.path])
  return (
    <div ref={root} className="golem-browser-source flex h-full flex-col overflow-hidden" style={shown ? undefined : { display: 'none' }}>
      <div className="golem-browser-header flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2 text-sm">
        <span className="golem-browser-runtime min-w-0 truncate"><span className="font-medium">{source.path}</span>, lines {(marked ?? source).line}–{(marked ?? source).endLine}{unmarked && ` (not marked: ${unmarked})`}</span>
        {unsaved.some((key) => key !== record) && <span className="golem-browser-error shrink-0 text-red-700">Unsaved: {unsaved.filter((key) => key !== record).map((key) => key.slice(key.indexOf('/') + 1)).join(', ')}</span>}
        <button type="button" className="golem-browser-new shrink-0 rounded border border-neutral-300 px-2 py-1" onClick={onClose}>Back to app</button>
      </div>
      <div className="min-h-0 flex-1">
        <SourceEditor config={config} adapters={adapters} focus={focus} />
      </div>
    </div>
  )
}

/**
 * Where `want.text` is in the text on screen, as 1-based start lines: the offered lines when the screen
 * shows the file they were counted in, otherwise every exact match of the whole passage, so a caller
 * can refuse to guess between two.
 */
function locate(text: string, want: OpenSource, clean: boolean): { lines: number[] } {
  const lines = text.split('\n')
  const passage = want.text.split('\n')
  if (!want.text.trim()) return { lines: [] }
  const at = (start: number) => passage.every((one, index) => lines[start + index] === one)
  if (clean && at(want.line - 1)) return { lines: [want.line] }
  const starts: number[] = []
  for (let start = 0; start + passage.length <= lines.length; start++) if (at(start)) starts.push(start + 1)
  return { lines: starts }
}

/** Returns to the open source after Back to app, as the Editor left it. */
export function SourceReturn({ source, onShow }: { source: OpenSource; onShow(): void }) {
  return (
    <div className="golem-browser-header border-t border-neutral-200 px-4 py-2 text-sm">
      <button type="button" className="golem-browser-new rounded border border-neutral-300 px-2 py-1" onClick={onShow}>Show {source.path}</button>
    </div>
  )
}
