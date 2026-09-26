import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Editor } from 'golem-ui'
import { knowledge, viewHandlerRegistry, type SourceOffer, type ViewOffer } from '../client'
import { answerOffer, subscribeChatView } from './adapters'

/** An accepted passage: `line`–`endLine` hold `text` in file `version`. */
export type OpenSource = SourceOffer['input'] & { key: string; version: number; text: string }

/**
 * This tab's view of the open chat: what the agent does here, and the offers it has to ask for first. A
 * `source.open` opens the file in the Editor; an app action runs the handler the app registered with
 * `views.on`, at once unless it was declared `confirm: true`. Either way it lands in this tab alone.
 */
export function useViewOffers(conversation: string | undefined, onOpen: (source: OpenSource) => void) {
  const [offers, setOffers] = useState<ViewOffer[]>([])
  // What an action did without asking, said once under the chat and gone again, so the person sees what moved.
  const [notes, setNotes] = useState<Array<{ id: string; text: string }>>([])
  const [error, setError] = useState<string>()
  const open = useRef(onOpen)
  open.current = onOpen
  useEffect(() => {
    setOffers([])
    setNotes([])
    if (!conversation) return
    return subscribeChatView((event) => {
      if (event.type === 'offer' && event.offer.conversation === conversation) setOffers((list) => [...list.filter((one) => one.id !== event.offer.id), event.offer])
      if (event.type === 'withdrawn') setOffers((list) => list.filter((one) => one.id !== event.id))
      if (event.type !== 'apply') return
      if (event.offer.action === 'source.open') {
        open.current({ ...(event.offer as SourceOffer).input, key: event.offer.id, version: event.version!, text: event.text! })
      } else if (!viewHandlerRegistry.run(event.offer.action, event.offer.input)) {
        setError(`This screen can no longer ${event.offer.action}.`)
      } else if (event.immediate) {
        const note = { id: event.offer.id, text: label(event.offer) }
        setNotes((list) => [...list, note])
        setTimeout(() => setNotes((list) => list.filter((one) => one.id !== note.id)), noteLifetime)
      }
    })
  }, [conversation])
  const answer = async (offer: ViewOffer, accept: boolean) => {
    setError(undefined)
    setOffers((list) => list.filter((one) => one.id !== offer.id))
    try { await answerOffer(offer.id, accept) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const panel = (offers.length > 0 || notes.length > 0 || error) && (
    <div className="golem-browser-offers golem-browser-header border-t border-neutral-200 px-4 py-2 text-sm">
      {offers.map((offer) => (
        <div key={offer.id} className="golem-browser-offer flex flex-wrap items-center gap-2 py-1">
          <span className="golem-browser-runtime min-w-0 flex-1 break-words">{label(offer)}</span>
          <button className="golem-browser-enter rounded bg-neutral-900 px-2 py-1 text-white" onClick={() => void answer(offer, true)}>Open</button>
          <button className="golem-browser-new rounded border border-neutral-300 px-2 py-1" onClick={() => void answer(offer, false)}>Dismiss</button>
        </div>
      ))}
      {notes.map((note) => <p key={note.id} className="golem-browser-runtime py-1 text-neutral-500">{note.text}</p>)}
      {error && <p className="golem-browser-error text-red-700">{error}</p>}
    </div>
  )
  return panel || null
}

const noteLifetime = 6000

/** The one line an action shows: the file and lines for a source, else the app's own description of the action. */
function label(offer: ViewOffer): string {
  if (offer.action !== 'source.open') return offer.label ?? offer.action
  const { path, line, endLine } = (offer as SourceOffer).input
  return `Open ${path}, lines ${line}\u2013${endLine}?`
}

const clock = { now: () => new Date(), timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone }
// `focus` is in golem-ui's Editor after 0.1.1; `version` and `text` let it find the passage in what it
// shows, waiting for that file version and marking nothing it cannot match exactly once. With 0.1.1
// installed the prop is ignored: the file opens at the top and the header's line numbers are the pointer.
type Focus = { line: number; endLine?: number; key?: string; version?: number; text?: string }
type FocusedEditor = (props: ComponentProps<typeof Editor> & { focus?: Focus }) => ReturnType<typeof Editor>
const SourceEditor = Editor as unknown as FocusedEditor
const adapters = { records: knowledge, clock }
// Editor statuses whose text is not yet in the file: an edit waiting to save, a save in flight, a
// refused save or a conflict waiting for the person.
const unsavedStatus = new Set(['dirty', 'saving', 'error', 'conflict'])

/**
 * The accepted sources in one golem-ui Editor, which marks the offered passage where it finds it. It
 * stays mounted for the page's life: moving to another source parks this one's draft or conflict in the
 * Editor, and closing only hides it, so neither loses an edit. Leaving with an edit unsaved asks first.
 */
export function SourcePanel({ source, shown, onClose }: { source: OpenSource; shown: boolean; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null)
  const record = `${source.root}/${source.path}`
  const current = useRef(record)
  current.current = record
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  useEffect(() => {
    const element = root.current
    if (!element) return
    // The last status each source showed; a source moved away from keeps it, since the Editor parks it as it was.
    const read = () => {
      const status = element.querySelector('[data-golem-status]')?.getAttribute('data-golem-status')
      if (status) setStatuses((all) => all[current.current] === status ? all : { ...all, [current.current]: status })
    }
    const observer = new MutationObserver(read)
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-golem-status'] })
    read()
    return () => observer.disconnect()
  }, [])
  const unsaved = Object.keys(statuses).filter((key) => unsavedStatus.has(statuses[key]!))
  useEffect(() => {
    if (!unsaved.length) return
    const ask = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [unsaved.length])
  const focus = useMemo<Focus>(() => ({ line: source.line, endLine: source.endLine, key: source.key, version: source.version, text: source.text }), [source.key])
  const config = useMemo(() => ({ collection: source.root, id: source.path, preview: 'toggle' as const }), [source.root, source.path])
  return (
    <div ref={root} className="golem-browser-source flex h-full flex-col overflow-hidden" style={shown ? undefined : { display: 'none' }}>
      <div className="golem-browser-header flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2 text-sm">
        <span className="golem-browser-runtime min-w-0 truncate"><span className="font-medium">{source.path}</span>, saved lines {source.line}–{source.endLine}</span>
        {unsaved.some((key) => key !== record) && <span className="golem-browser-error shrink-0 text-red-700">Unsaved: {unsaved.filter((key) => key !== record).map((key) => key.slice(key.indexOf('/') + 1)).join(', ')}</span>}
        <button type="button" className="golem-browser-new shrink-0 rounded border border-neutral-300 px-2 py-1" onClick={onClose}>Back to app</button>
      </div>
      <div className="min-h-0 flex-1">
        <SourceEditor config={config} adapters={adapters} focus={focus} />
      </div>
    </div>
  )
}

/** Returns to the open source after Back to app, as the Editor left it. */
export function SourceReturn({ source, onShow }: { source: OpenSource; onShow(): void }) {
  return (
    <div className="golem-browser-header border-t border-neutral-200 px-4 py-2 text-sm">
      <button type="button" className="golem-browser-new rounded border border-neutral-300 px-2 py-1" onClick={onShow}>Show {source.path}</button>
    </div>
  )
}
