import { useEffect, useRef, useState } from 'react'
import { ansiToHtml } from './ansi'
import { keyForEvent } from './panekeys'

// Interrupts skip the send queue: Ctrl-C exists to arrive when the pane is not keeping up.
const JUMPS_QUEUE = new Set(['C-c', 'C-d', 'C-z', 'C-\\'])

// The Terminal popup, a port of Bridge Commander's ui/js/pane.js: the agent's live tmux screen (whole-screen
// frames over SSE, replaced not appended) that is itself focusable. Keys go straight to the pane, paste is a
// literal paste, text stays selectable. No terminal emulator: keys go out, frames come back.
export function Terminal({ session, onClose }: { session: string; onClose: () => void }) {
  const preRef = useRef<HTMLPreElement>(null)
  const [message, setMessage] = useState<string>()
  const [live, setLive] = useState(false)
  const [typing, setTyping] = useState(false)
  const [flash, setFlash] = useState<string>()
  const base = `/api/sessions/${encodeURIComponent(session)}/pane/`
  useEffect(() => {
    const es = new EventSource(`${base}stream`)
    const fail = (text: string) => { es.close(); setLive(false); setMessage(text) }
    es.addEventListener('frame', (event) => {
      const pre = preRef.current
      if (!pre) return
      // Stick to the bottom only when the user was already there: a scroll-up must survive the next frame.
      const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 12
      pre.innerHTML = ansiToHtml(String(JSON.parse((event as MessageEvent).data)))
      if (stick) pre.scrollTop = pre.scrollHeight
      setLive(true)
    })
    es.addEventListener('unsupported', () => fail('this agent has no live terminal'))
    es.addEventListener('busy', () => fail('too many terminals open; close one and try again'))
    es.addEventListener('no-pane', (event) => {
      let reason = ''
      try { reason = JSON.parse((event as MessageEvent).data).reason ?? '' } catch { /* plain message */ }
      fail(`no live terminal${reason ? `: ${reason}` : ''}`)
    })
    es.onerror = () => setLive(false)
    return () => es.close()
  }, [base])
  // Escape closes the overlay only while the screen is NOT focused; focused, it belongs to the agent
  // (the pane's own keydown stops propagation before it gets here).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // One POST per keystroke, chained: same-origin fetches can complete out of order, and out-of-order
  // keystrokes scramble typed text ("abc" → "acb"). Each hop is bounded by a timeout so one stall cannot wedge the rest.
  const chain = useRef(Promise.resolve())
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const post = (payload: { text?: string; key?: string }) => fetch(`${base}input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) })
    .then(async (response) => { if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`) })
    // A rejected keystroke was preventDefaulted away from the browser: it must not vanish in silence.
    .catch((error: unknown) => { setFlash(error instanceof Error ? error.message : String(error)); clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlash(undefined), 4000) })
  const send = (payload: { text?: string; key?: string }) => {
    if (payload.key && JUMPS_QUEUE.has(payload.key)) { void post(payload); return }
    chain.current = chain.current.then(() => post(payload))
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    const payload = keyForEvent(event)
    if (!payload) return // browser/OS chord: leave it alone (Ctrl-V, ⌘W, F5…)
    event.preventDefault()
    event.stopPropagation()
    send(payload)
  }
  // Paste rides the literal path: the harness switches to a bracketed paste for multi-line text.
  const onPaste = (event: React.ClipboardEvent) => {
    event.preventDefault()
    const text = event.clipboardData.getData('text')
    if (text) send({ text })
  }
  const hint = flash ? `⚠ ${flash}` : typing ? 'typing — keys go to the pane · Esc too · ✕ or click outside to close' : 'click the screen to type'
  return (
    <div className="golem-terminal-overlay fixed inset-0 z-50 flex items-center justify-center p-4" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="golem-terminal flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border shadow-xl" role="dialog" aria-label="Agent terminal">
        <div className="golem-terminal-head flex items-center gap-2 border-b px-3.5 py-2.5 text-xs">
          <span className={`golem-terminal-live ${live ? 'on' : ''}`} title={live ? 'live' : 'not streaming'} aria-hidden="true" />
          <span className="golem-terminal-title min-w-0 flex-1 truncate font-mono font-semibold">{session}</span>
          {!message && <span className={`golem-terminal-hint whitespace-nowrap ${flash ? 'flash' : typing ? 'on' : ''}`}>{hint}</span>}
          <button type="button" className="golem-terminal-close px-1.5" title="Close" onClick={onClose}>✕</button>
        </div>
        {message
          ? <div className="golem-terminal-msg flex flex-1 items-center justify-center p-6 text-sm">{message}</div>
          : <pre ref={preRef} tabIndex={0} className={`golem-terminal-screen m-0 min-h-0 flex-1 overflow-auto px-3.5 py-3 outline-none ${typing ? 'typing' : ''}`}
              onFocus={() => setTyping(true)} onBlur={() => setTyping(false)} onKeyDown={onKeyDown} onPaste={onPaste}>connecting…</pre>}
      </div>
    </div>
  )
}
