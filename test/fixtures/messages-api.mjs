// A deterministic stand-in for the Anthropic Messages API, for trying ordinary chat in a browser
// without a key. It speaks the same wire format (POST /v1/messages, tool_use / tool_result) and
// answers two kinds of message:
//   "rename <title> to <new title>"      lists notes, then updates the one with that title
//   "show <quote> in <root>/<path>"      offers to open that passage (view.request source.open)
// Run: node test/fixtures/messages-api.mjs [port], then start the app with
//   ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY=fixture ./golem dev
import { createServer } from 'node:http'

let id = 0
const message = (content, stop) => ({ id: `msg_${++id}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
const say = (text) => message([{ type: 'text', text }], 'end_turn')
const call = (name, input) => message([{ type: 'tool_use', id: `toolu_${++id}`, name, input }], 'tool_use')

export function reply({ messages }) {
  const start = messages.findLastIndex((one) => one.role === 'user' && typeof one.content === 'string')
  const text = messages[start].content
  const results = messages.slice(start + 1).filter((one) => one.role === 'user').map((one) => one.content[0])
  const last = results.at(-1)
  const rename = text.match(/rename (.+) to (.+)/i)
  const show = text.match(/show (.+) in ([^/\s]+)\/(\S+)/i)
  if (rename) {
    if (!last) return call('records__list', { collection: 'notes' })
    if (results.length === 1 && !last.is_error) {
      const note = JSON.parse(last.content).rows.find((row) => row.title === rename[1].trim())
      return note ? call('records__update', { collection: 'notes', id: note.id, patch: { title: rename[2].trim() } }) : say(`No note is titled ${rename[1].trim()}.`)
    }
    return say(last.is_error ? `I could not rename it: ${last.content}` : `Renamed to ${rename[2].trim()}.`)
  }
  if (show) {
    if (!last) return call('view__request', { action: 'source.open', input: { root: show[2], path: show[3], quote: show[1].trim() } })
    if (last.is_error) return say(`I could not offer that source: ${last.content}`)
    const { offer, delivered } = JSON.parse(last.content)
    return say(delivered ? `I offered ${offer.input.path}, lines ${offer.input.line}–${offer.input.endLine}. Choose Open to see it.` : `The passage is ${offer.input.path}, lines ${offer.input.line}–${offer.input.endLine}.`)
  }
  return say('Say "rename <title> to <new title>" or "show <quote> in <root>/<path>".')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 3262)
  createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.method !== 'POST' || request.url !== '/v1/messages' || !body) { response.writeHead(404); return response.end() }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(reply(JSON.parse(body))))
  }).listen(port, '127.0.0.1', () => console.log(`Messages API fixture on http://127.0.0.1:${port}`))
}
