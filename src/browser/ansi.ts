// Tiny zero-dep ANSI SGR → HTML renderer for pane frames, ported from Bridge Commander's ui/js/ansi.js.
// Handles reset, bold/dim, 16-color, 256-color and truecolor fg/bg; every other escape (cursor moves,
// OSC titles) is stripped. Text is HTML-escaped before any markup is added.
const BASE16 = [
  '#3b4453', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fc0', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
]
const CUBE = [0, 95, 135, 175, 215, 255]
const hex2 = (n: number) => n.toString(16).padStart(2, '0')
const rgb = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`

function color256(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null
  if (n < 16) return BASE16[n]
  if (n < 232) { const v = n - 16; return rgb(CUBE[Math.floor(v / 36)], CUBE[Math.floor(v / 6) % 6], CUBE[v % 6]) }
  const g = 8 + (n - 232) * 10
  return rgb(g, g, g)
}

type Style = { bold: boolean; dim: boolean; fg: string | null; bg: string | null }
export type Segment = Style & { text: string }

export function ansiToSegments(str: string): Segment[] {
  const st: Style = { bold: false, dim: false, fg: null, bg: null }
  const out: Segment[] = []
  let buf = ''
  let bufSt: Style = { ...st }
  const same = (a: Style, b: Style) => a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim
  const flush = () => { if (buf) { out.push({ text: buf, ...bufSt }); buf = '' } }
  const applySgr = (raw: string) => {
    const parts = (raw === '' ? '0' : raw).split(';')
    for (let p = 0; p < parts.length; p++) {
      const item = parts[p]
      const code = parseInt(item.split(':')[0], 10)
      if (Number.isNaN(code) || code === 0) { st.bold = false; st.dim = false; st.fg = null; st.bg = null }
      else if (code === 1) st.bold = true
      else if (code === 2) st.dim = true
      else if (code === 22) { st.bold = false; st.dim = false }
      else if (code >= 30 && code <= 37) st.fg = BASE16[code - 30]
      else if (code >= 90 && code <= 97) st.fg = BASE16[code - 90 + 8]
      else if (code === 39) st.fg = null
      else if (code >= 40 && code <= 47) st.bg = BASE16[code - 40]
      else if (code >= 100 && code <= 107) st.bg = BASE16[code - 100 + 8]
      else if (code === 49) st.bg = null
      else if (code === 38 || code === 48) {
        let mode: string | undefined
        let args: string[]
        if (item.includes(':')) { const sub = item.split(':'); mode = sub[1]; args = sub.length >= 6 ? sub.slice(3) : sub.slice(2) }
        else {
          mode = parts[p + 1]
          if (mode === '5') { args = [parts[p + 2]]; p += 2 }
          else if (mode === '2') { args = parts.slice(p + 2, p + 5); p += 4 }
          else { args = []; p += 1 }
        }
        let col: string | null = null
        if (mode === '5') col = color256(parseInt(args[0], 10))
        else if (mode === '2') {
          const [r, g, b] = args.map((v) => parseInt(v, 10))
          if ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) col = rgb(r, g, b)
        }
        if (code === 38) st.fg = col; else st.bg = col
      }
    }
  }
  for (let i = 0; i < str.length; i++) {
    const c = str[i]
    if (c === '\x1b') {
      const n = str[i + 1]
      if (n === '[') {
        let j = i + 2
        while (j < str.length && !/[@-~]/.test(str[j])) j++
        if (j < str.length && str[j] === 'm') applySgr(str.slice(i + 2, j))
        i = j < str.length ? j : str.length
        continue
      }
      if (n === ']') {
        let j = i + 2
        while (j < str.length && str[j] !== '\x07' && !(str[j] === '\x1b' && str[j + 1] === '\\')) j++
        i = str[j] === '\x1b' ? j + 1 : j
        continue
      }
      i++
      continue
    }
    if (!same(st, bufSt)) { flush(); bufSt = { ...st } }
    buf += c
  }
  flush()
  return out
}

export function ansiToHtml(str: string): string {
  let out = ''
  for (const s of ansiToSegments(str)) {
    const parts: string[] = []
    if (s.fg) parts.push(`color:${s.fg}`)
    if (s.bg) parts.push(`background:${s.bg}`)
    if (s.bold) parts.push('font-weight:700')
    if (s.dim) parts.push('opacity:.55')
    const text = s.text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
    out += parts.length ? `<span style="${parts.join(';')}">${text}</span>` : text
  }
  return out
}
