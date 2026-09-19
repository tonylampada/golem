import { useEffect, useRef, useState } from 'react'
import { ansiToHtml } from './ansi'

// The Terminal popup: the agent's live tmux screen (whole-screen frames over SSE, replaced not appended)
// and a line to type into it. Ported from Bridge Commander's ui/js/pane.js, minus per-keystroke typing:
// one input line, Enter sends the text then an Enter key. Ctrl-C has its own button.
export function Terminal({ session, onClose }: { session: string; onClose: () => void }) {
  const preRef = useRef<HTMLPreElement>(null)
  const [message, setMessage] = useState<string>()
  const [live, setLive] = useState(false)
  const [line, setLine] = useState('')
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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // Sends are chained so two quick payloads (text, then Enter) can never arrive out of order.
  const chain = useRef(Promise.resolve())
  const send = (payload: { text?: string; key?: string }) => {
    chain.current = chain.current.then(() => fetch(`${base}input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) })
      .then(async (response) => { if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`) })
      .catch((error: unknown) => { setFlash(error instanceof Error ? error.message : String(error)); setTimeout(() => setFlash(undefined), 4000) }))
  }
  const submit = () => { if (line) send({ text: line }); send({ key: 'Enter' }); setLine('') }
  return (
    <div className="golem-terminal-overlay fixed inset-0 z-50 flex items-center justify-center p-4" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="golem-terminal flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border shadow-xl" role="dialog" aria-label="Agent terminal">
        <div className="golem-terminal-head flex items-center gap-2 border-b px-3 py-2 text-xs">
          <span className={`golem-browser-status-dot ${live ? 'golem-browser-status-connected' : 'golem-browser-status-disconnected'}`} aria-hidden="true" />
          <span className="font-medium">Terminal</span>
          <span className="opacity-60">{session.slice(0, 8)}</span>
          {flash && <span className="golem-terminal-flash truncate">⚠ {flash}</span>}
          <button type="button" className="golem-terminal-ctrlc ml-auto rounded border px-2 py-0.5" title="Send Ctrl-C" onClick={() => send({ key: 'C-c' })}>Ctrl-C</button>
          <button type="button" className="golem-terminal-close rounded border px-2 py-0.5" title="Close (Esc)" onClick={onClose}>✕</button>
        </div>
        {message
          ? <div className="golem-terminal-msg flex flex-1 items-center justify-center p-6 text-sm">{message}</div>
          : <pre ref={preRef} className="golem-terminal-screen m-0 min-h-0 flex-1 overflow-auto p-3 text-xs leading-snug">connecting…</pre>}
        <form className="golem-terminal-input flex items-center gap-2 border-t px-3 py-2" onSubmit={(event) => { event.preventDefault(); submit() }}>
          <span className="golem-terminal-prompt font-mono text-xs">›</span>
          <input autoFocus className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none" placeholder="type a line, Enter sends it to the agent" value={line} disabled={!!message} onChange={(event) => setLine(event.target.value)} />
        </form>
      </div>
    </div>
  )
}
