import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { ForbiddenError, InvalidError, NotFoundError, UnauthorizedError, z, type Principal, type Via } from '../operations.ts'

/** Something an agent offered to show; the person accepts it in one browser view, where alone it is applied. */
export type ViewOffer = { id: string; conversation: string; action: 'source.open'; input: { root: string; path: string; line: number; endLine: number } }
export type ViewEvent = { type: 'offer'; offer: ViewOffer } | { type: 'apply'; offer: ViewOffer } | { type: 'withdrawn'; id: string }

/** What an agent can discover: names, when to use them and their input, never data. */
export type ViewActionDoc = { name: string; description: string; inputSchema: unknown }

/**
 * The agent runtime owns conversations and the browser identity of anonymous visitors, so it supplies
 * both checks. `owner` derives a trusted key from the actual request and its server-resolved principal
 * (an account id, or a key for the runtime's browser cookie), never from request input; `null` refuses.
 * `owns` says whether that key owns the conversation.
 */
export type Conversations = {
  owner(request: IncomingMessage, principal: Principal): Promise<string | null> | string | null
  owns(conversation: string, owner: string): Promise<boolean> | boolean
}

/** Trusted context the runtime holds for one message: who, which conversation, and the view it came from. */
export type ViewBinding = { principal: Principal; owner: string; conversation: string }

export type Views = {
  /** The actions an agent may request in this app. Empty until the app configures knowledge roots. */
  actions(): ViewActionDoc[]
  /** Installs the runtime's checks. Until then no view opens and no offer is made. */
  useConversations(conversations: Conversations): void
  /** A browser tab opens one view of a conversation it owns; the returned id is that tab's capability. */
  open(request: IncomingMessage, principal: Principal, conversation: string): Promise<{ id: string }>
  /** Whether `view` is a live view of this binding's conversation, held by the same person, session and owner. The runtime checks a message's view with it before accepting the message. */
  bound(view: string, binding: ViewBinding): Promise<boolean>
  /** Delivers this view's events until the returned function is called. */
  connect(request: IncomingMessage, principal: Principal, id: string, send: (event: ViewEvent) => void): Promise<() => void>
  /**
   * An agent acting in `binding` offers an action. The source is authorized as the principal first.
   * With `view` (the tab the message came from) the offer is sent to that view; without one it is only
   * returned, for the chat to show. Either way it is applied only after the person accepts it.
   */
  request(binding: ViewBinding & { view?: string }, action: string, input: unknown): Promise<{ offer: ViewOffer; delivered: boolean }>
  /** The person's answer from one of their views. Accepting re-authorizes and applies to that view only. */
  answer(request: IncomingMessage, principal: Principal, id: string, offer: string, accept: boolean): Promise<void>
}

type Channel = { holder: Principal; owner: string; conversation: string; send?: (event: ViewEvent) => void }
type Pending = { offer: ViewOffer; holder: Principal; owner: string; view?: string }

const offerLifetime = 10 * 60_000
const connectWithin = 60_000

const sourceOpen = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
  quote: z.string().min(1).max(2000).optional().describe('Text copied from the source; the lines containing it are highlighted.'),
  line: z.number().int().min(1).optional().describe('1-based first line to highlight, when there is no quote.'),
  endLine: z.number().int().min(1).optional(),
}).strict()

const catalog: ViewActionDoc[] = [{
  name: 'source.open',
  description: 'Offer to open a knowledge file beside the conversation with a passage highlighted and the rest of the file around it. The person sees the offer and chooses whether to open it.',
  inputSchema: z.toJSONSchema(sourceOpen),
}]

/** Same person in the same signed-in session, or both anonymous (then the owner key tells visitors apart). */
const same = (a: Principal, b: Principal) => a.kind === b.kind && (a.kind === 'anonymous' || (b.kind === 'user' && a.id === b.id && a.session === b.session))
const refused = () => new ForbiddenError('Cannot open that source')
const noView = () => new NotFoundError('No such view')

export function createViews(app: {
  invoke(name: string, input: unknown, principal: Principal, via: Via): Promise<unknown>
  refresh(principal: Principal): Promise<Principal>
  has(operation: string): boolean
}): Views {
  const channels = new Map<string, Channel>()
  const offers = new Map<string, Pending>()
  let conversations: Conversations | undefined

  /** The binding as it stands now: a live principal whose owner key still owns the conversation. */
  async function check({ principal, owner, conversation }: ViewBinding): Promise<Principal> {
    const now = await app.refresh(principal)
    if (!conversations || typeof owner !== 'string' || !owner || typeof conversation !== 'string' || !conversation || !(await conversations.owns(conversation, owner))) {
      throw new NotFoundError('No such conversation')
    }
    return now
  }

  async function ownerOf(request: IncomingMessage, principal: Principal): Promise<string> {
    const owner = conversations ? await conversations.owner(request, principal) : null
    if (!owner) throw new NotFoundError('No such conversation')
    return owner
  }

  /** A browser call on a view: the capability, the principal and session it was opened with, and the same owner. */
  async function owned(request: IncomingMessage, principal: Principal, id: string): Promise<Channel> {
    const channel = channels.get(id)
    if (!channel || !same(channel.holder, principal) || (await ownerOf(request, principal)) !== channel.owner) throw noView()
    await check({ principal, owner: channel.owner, conversation: channel.conversation })
    return channel
  }

  function withdraw(id: string) {
    const pending = offers.get(id)
    offers.delete(id)
    for (const channel of channels.values()) {
      if (pending && channel.conversation === pending.offer.conversation && channel.owner === pending.owner) channel.send?.({ type: 'withdrawn', id })
    }
  }

  /** Reads the file as `principal`; any failure is the same refusal, so a view never tells what exists. */
  async function readable(principal: Principal, root: string, path: string): Promise<string> {
    try {
      return ((await app.invoke('knowledge.read', { root, path }, principal, 'agent')) as { body: string }).body
    } catch (error) {
      if ((error as Error).name === 'UnauthorizedError') throw error
      throw refused()
    }
  }

  return {
    actions: () => app.has('knowledge.read') ? catalog : [],
    useConversations(next) { conversations = next },
    async open(request, principal, conversation) {
      const owner = await ownerOf(request, principal)
      const holder = await check({ principal, owner, conversation })
      const id = randomBytes(24).toString('base64url')
      channels.set(id, { holder, owner, conversation })
      setTimeout(() => { if (!channels.get(id)?.send) channels.delete(id) }, connectWithin).unref()
      return { id }
    },
    async bound(view, binding) {
      const channel = channels.get(view)
      if (!channel?.send || channel.conversation !== binding.conversation || channel.owner !== binding.owner) return false
      const now = await check(binding).catch(() => null)
      return Boolean(now && same(channel.holder, now))
    },
    async connect(request, principal, id, send) {
      const channel = await owned(request, principal, id)
      channel.send = send
      return () => { channels.delete(id) }
    },
    async request(binding, action, raw) {
      if (action !== 'source.open' || !app.has('knowledge.read')) throw new NotFoundError(`Unknown view action: ${action}`)
      const parsed = sourceOpen.safeParse(raw)
      if (!parsed.success) throw new InvalidError(`${action}: ${z.prettifyError(parsed.error)}`)
      const { root, path, quote, line, endLine } = parsed.data
      const { owner, conversation, view } = binding
      const holder = await check(binding)
      const lines = (await readable(holder, root, path)).split('\n')
      let first = line ?? 1
      let last = endLine ?? first
      if (quote) {
        const at = locate(lines, quote)
        if (!at) throw new InvalidError('That passage is not in the source')
        ;[first, last] = at
      }
      first = Math.min(first, lines.length)
      last = Math.min(Math.max(last, first), lines.length)
      const offer: ViewOffer = { id: randomUUID(), conversation, action, input: { root, path, line: first, endLine: last } }
      const channel = view === undefined ? undefined : channels.get(view)
      const target = channel?.send && channel.conversation === conversation && channel.owner === owner && same(channel.holder, holder) ? view : undefined
      offers.set(offer.id, { offer, holder, owner, view: target })
      setTimeout(() => { if (offers.has(offer.id)) withdraw(offer.id) }, offerLifetime).unref()
      if (target) channel!.send!({ type: 'offer', offer })
      return { offer, delivered: Boolean(target) }
    },
    async answer(request, principal, id, offerId, accept) {
      const channel = await owned(request, principal, id)
      const pending = offers.get(offerId)
      // An offer sent to one view is answered there; one shown only in the chat may be answered from any view of it.
      if (!pending || pending.offer.conversation !== channel.conversation || pending.owner !== channel.owner || !same(pending.holder, channel.holder) || (pending.view && pending.view !== id)) {
        throw new NotFoundError('That offer is no longer open')
      }
      withdraw(offerId)
      if (!accept) return
      // Access may have changed since the offer: check again as the person now is.
      const now = await app.refresh(principal).catch(() => { throw new UnauthorizedError('Sign in again to open this source.') })
      await readable(now, pending.offer.input.root, pending.offer.input.path)
      channel.send?.({ type: 'apply', offer: pending.offer })
    },
  }
}

/** First and last 1-based line of the first place `quote` appears, ignoring case and runs of whitespace. */
function locate(lines: string[], quote: string): [number, number] | null {
  let flat = ''
  const lineOf: number[] = []
  lines.forEach((text, index) => {
    for (const char of `${text}\n`) {
      const space = /\s/.test(char)
      if (space && flat.endsWith(' ')) continue
      flat += space ? ' ' : char.toLowerCase()
      lineOf.push(index + 1)
    }
  })
  const needle = quote.replace(/\s+/g, ' ').trim().toLowerCase()
  const at = needle ? flat.indexOf(needle) : -1
  return at < 0 ? null : [lineOf[at], lineOf[at + needle.length - 1]]
}
