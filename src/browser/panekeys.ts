// Browser keydown → the pane input route's payload. Pure (no DOM at import) so a unit test can import it.
// Port of Bridge Commander's ui/js/panekeys.js.
//   { key: '<tmux key name>' } — Enter, BSpace, Up, BTab, C-c, …
//   { text: '<literal>' }      — one printable character, typed as-is
//   null                       — not ours: the browser keeps the event (Ctrl-V, ⌘W, F5, …)
export type PaneInput = { key: string } | { text: string }

// tmux spells several DOM keys differently (BSpace, DC), which is the whole point of the table.
export const NAMED: Record<string, string> = {
  Enter: 'Enter', Backspace: 'BSpace', Tab: 'Tab', Escape: 'Escape',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Delete: 'DC', Insert: 'IC',
}
// Ctrl-<x> combos tmux understands: letters plus the punctuation controls (C-[ Escape, C-\ quit, C-_ undo).
export const CTRL_KEYS = 'abcdefghijklmnopqrstuvwxyz[\\]^_'

export function keyForEvent(e: { key: string; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): PaneInput | null {
  // Alt/Meta chords belong to the browser and the OS (⌘W, Alt-Tab): a swallowed ⌘W is worse than a missing M-b.
  if (e.altKey || e.metaKey) return null
  if (e.key === 'Tab') return { key: e.shiftKey ? 'BTab' : 'Tab' }
  const named = NAMED[e.key]
  if (named) return { key: named }
  if (e.ctrlKey) {
    if (e.key.length !== 1) return null
    const c = e.key.toLowerCase()
    // Ctrl-V stays with the browser: preventDefaulting it would kill the `paste` event, and paste (bracketed,
    // multi-line) beats a bare C-v. Ctrl-C is NOT excluded: interrupting the agent is the point of typing here.
    if (c === 'v') return null
    return CTRL_KEYS.includes(c) ? { key: `C-${c}` } : null
  }
  // Any single printable character rides as literal text; no per-character table keeps up with real keyboards.
  if (e.key.length === 1) return { text: e.key }
  return null // F-keys, bare modifiers, dead keys, media keys
}
