import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Editor } from 'golem-ui'
import { knowledge, type ViewOffer } from '../client'
import { answerOffer, subscribeChatView } from './adapters'

export type OpenSource = ViewOffer['input'] & { key: string }

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
      if (event.type === 'apply') open.current({ ...event.offer.input, key: event.offer.id })
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
// `focus` arrives with golem-ui's Editor after 0.1.1; typed here until the pinned package has it.
type FocusedEditor = (props: ComponentProps<typeof Editor> & { focus?: { line: number; endLine?: number; key?: string } }) => ReturnType<typeof Editor>
const SourceEditor = Editor as unknown as FocusedEditor

/** The accepted source in golem-ui's Editor, scrolled to the offered passage. */
export function SourcePanel({ source, onClose }: { source: OpenSource; onClose(): void }) {
  return (
    <div className="golem-browser-source flex h-full flex-col overflow-hidden">
      <div className="golem-browser-header flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2 text-sm">
        <span className="golem-browser-runtime truncate font-medium">{source.path}</span>
        <button type="button" className="golem-browser-new rounded border border-neutral-300 px-2 py-1" onClick={onClose}>Back to app</button>
      </div>
      <div className="min-h-0 flex-1">
        <SourceEditor
          key={`${source.root}/${source.path}`}
          config={{ collection: source.root, id: source.path, preview: 'toggle' }}
          adapters={{ records: knowledge, clock }}
          focus={{ line: source.line, endLine: source.endLine, key: source.key }}
        />
      </div>
    </div>
  )
}
