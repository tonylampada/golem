import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import Anthropic from '@anthropic-ai/sdk'
import { readCookie, type AppBackend } from './backend/http.ts'
import { ForbiddenError, type Principal } from './operations.ts'
import { AssistantBackend, type TurnContext } from './runtime/assistant.ts'
import type { SessionBackend } from './runtime/session.ts'

/**
 * Ordinary-use chat: an API agent limited to the operations golem.config.ts lists, acting as the
 * person chatting. A conversation belongs to an account, or for a signed-out visitor to an opaque
 * browser cookie this server issues; nobody else can read or continue it.
 */
export function ordinaryChat(backend: AppBackend) {
  const profile = backend.config.agents?.ordinary
  const cookie = `${backend.config.origin?.startsWith('https:') ? '__Host-' : ''}golem-chat-${backend.config.port}`
  const secure = backend.config.origin?.startsWith('https:') ? '; Secure' : ''
  const detail = !profile ? 'Chat is not turned on for this app.'
    : !process.env.ANTHROPIC_API_KEY ? 'Chat needs ANTHROPIC_API_KEY in the server environment.'
    : undefined

  /** Operations as tools for one turn: only the listed ones, collections checked on parsed input. */
  const tools = (context: TurnContext) => {
    if (!profile) return []
    return backend.app.agentTools(context.principal).filter((tool) => profile.operations.includes(tool.name)).map((tool) => {
      const { collections } = profile
      const operation = backend.app.operations.find((one) => one.name === tool.name)
      if (!collections || !tool.name.startsWith('records.') || !operation) return tool
      return {
        ...tool,
        call: async (input: unknown) => {
          const parsed = operation.input.safeParse(input)
          if (parsed.success && !collections.includes((parsed.data as { collection: string }).collection)) throw new ForbiddenError(`Not allowed: ${tool.name}`)
          return tool.call(input)
        },
      }
    })
  }

  return {
    available: !detail,
    detail,
    /** The trusted owner key for this request: the account, else this browser's cookie. Never from input. */
    owner(request: IncomingMessage, principal: Principal): string | null {
      if (principal.kind === 'user') return principal.id
      const token = readCookie(request, cookie)
      return token ? `browser:${createHash('sha256').update(token).digest('hex')}` : null
    },
    /** Issues the browser cookie a signed-out visitor's conversations belong to. */
    issue(): { owner: string; header: string } {
      const token = randomBytes(32).toString('base64url')
      return { owner: `browser:${createHash('sha256').update(token).digest('hex')}`, header: `${cookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` }
    },
    backend(transcript?: unknown): SessionBackend {
      const client = detail ? undefined : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      return new AssistantBackend(client ?? detail!, { model: profile?.model ?? '', instructions: profile?.instructions, tools }, Array.isArray(transcript) ? transcript : [])
    },
  }
}

export type OrdinaryChat = ReturnType<typeof ordinaryChat>
