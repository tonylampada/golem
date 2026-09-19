import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { isPlain, type AccountsConfig } from '../config.ts'
import {
  AppError, ForbiddenError, InvalidError, NotFoundError, RecordRefusedError, UnauthorizedError, validId, z,
  type Principal, type RecordStore, type Row,
} from '../operations.ts'

/** Reserved collections: the builtin records operations refuse `_` names, and nothing here reaches the change stream. */
export const ACCOUNTS = '_accounts'
export const SESSIONS = '_sessions'
export const INVITES = '_invites'

const day = 86_400_000
const sessionLifetime = 14 * day
const inviteLifetime = 7 * day
const maxFailures = 5
const lockout = 15 * 60_000

export type Member = { id: string; name: string; email: string; roles: string[]; groups: string[] }
type Account = Row & Member & { password: string }
type User = Extract<Principal, { kind: 'user' }>

export class RateLimitedError extends AppError {
  override name = 'RateLimitedError'
  override status = 429
}

const email = z.string().trim().toLowerCase().min(3).max(254).refine((value) => value.includes('@'), 'must be an email address')
const password = z.string().min(8, 'Use at least 8 characters.').max(256)
const group = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)
export const inputs = {
  signIn: z.object({ email, password: z.string().max(256) }),
  signUp: z.object({ name: z.string().trim().min(1).max(120), email, password, invite: z.string().max(128).optional() }),
  invite: z.object({ role: z.string() }),
  role: z.object({ role: z.string() }),
  groups: z.object({ groups: z.array(group).max(64) }),
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new InvalidError(z.prettifyError(parsed.error))
  return parsed.data
}

/**
 * Local accounts: scrypt password hashes, server-side sessions named by the SHA-256 of a random
 * cookie token, single-use invites, and the principal every request and agent call acts as.
 */
export function createAccounts(records: RecordStore, config: AccountsConfig) {
  /** Emits `change` with an account id whenever its sessions, roles, groups or existence change. */
  const changes = new EventEmitter().setMaxListeners(0)
  const failures = new Map<string, { count: number; until: number }>()
  // Sign-up checks the email, claims the invite and creates the account as one step, one at a time.
  let signingUp: Promise<unknown> = Promise.resolve()
  const managing = new Set(config.roles.filter((role) => role.manages).map((role) => role.id))
  const roleIds = new Set(config.roles.map((role) => role.id))
  const digest = (token: string) => createHash('sha256').update(token).digest('base64url')
  const manages = (principal: Principal) => principal.kind === 'user' && principal.roles.some((role) => managing.has(role))
  const member = ({ id, name, email, roles, groups }: Account): Member => ({ id, name, email, roles, groups })
  const user = (account: Account, session?: string): User => ({ kind: 'user', id: account.id, name: account.name, roles: account.roles, groups: account.groups, ...(session ? { session } : {}) })

  async function all(): Promise<Account[]> {
    const found: Account[] = []
    let cursor: string | null = null
    do {
      const page: Awaited<ReturnType<RecordStore['list']>> = await records.list(ACCOUNTS, { cursor, limit: 500 })
      found.push(...page.rows as Account[])
      cursor = page.nextCursor
    } while (cursor)
    return found
  }

  /** The live session with this id and its account, or nothing once it is signed out, expired or its account removed. */
  async function live(sessionId: string): Promise<{ session: Row; account: Account } | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId)) return undefined
    const session = await records.get(SESSIONS, sessionId)
    if (!session) return undefined
    if (Date.parse(String(session.expiresAt)) <= Date.now()) {
      await records.remove(SESSIONS, session.id).catch(() => {})
      return undefined
    }
    const account = await records.get(ACCOUNTS, String(session.userId)) as Account | null
    return account ? { session, account } : undefined
  }

  async function startSession(account: Account): Promise<{ user: Member; token: string }> {
    const token = randomBytes(32).toString('base64url')
    await records.create(SESSIONS, { id: digest(token), userId: account.id, expiresAt: new Date(Date.now() + sessionLifetime).toISOString() })
    return { user: member(account), token }
  }

  function requireManager(actor: Principal): void {
    if (actor.kind !== 'user') throw new UnauthorizedError('Sign in first.')
    if (!manages(actor)) throw new ForbiddenError('Only an admin can manage members.')
  }

  async function target(id: string): Promise<Account> {
    const account = await records.get(ACCOUNTS, validId(id)) as Account | null
    if (!account) throw new NotFoundError('That member no longer exists.')
    return account
  }

  async function keepsAManager(changed: Account, roles: string[] | null): Promise<void> {
    if (!changed.roles.some((role) => managing.has(role)) || roles?.some((role) => managing.has(role))) return
    const managers = (await all()).filter((account) => account.roles.some((role) => managing.has(role)))
    if (managers.length <= 1) throw new RecordRefusedError('Keep at least one member who manages accounts.')
  }

  function throttle(keys: string[]): void {
    const now = Date.now()
    for (const [key, entry] of failures) if (entry.until <= now) failures.delete(key)
    if (keys.some((key) => (failures.get(key)?.count ?? 0) >= maxFailures)) throw new RateLimitedError('Too many attempts. Try again in 15 minutes.')
  }

  function fail(keys: string[]): void {
    for (const key of keys) {
      const entry = failures.get(key) ?? { count: 0, until: 0 }
      failures.set(key, { count: entry.count + 1, until: Date.now() + lockout })
    }
  }

  /** For server-owned work that acts for an account (a scheduled job): its current roles and groups, no session. */
  async function resolveAccount(id: string): Promise<User> {
    const account = await records.get(ACCOUNTS, validId(id)) as Account | null
    if (!account) throw new ForbiddenError(`Account ${id} no longer exists`)
    return user(account)
  }

  async function createAccount(name: string, email: string, hashed: string, invite: string | undefined): Promise<Account> {
    if ((await records.list(ACCOUNTS, { filter: { email }, limit: 1 })).rows.length) throw new InvalidError('That email already has an account. Sign in instead.')
    // Without an invite, only a role that neither manages nor builds, whatever the role order.
    let role = config.roles.find(isPlain)?.id
    if (invite) {
      const found = /^[A-Za-z0-9_-]{43}$/.test(invite) ? await records.get(INVITES, digest(invite)) : null
      if (!found || Date.parse(String(found.expiresAt)) <= Date.now()) throw new InvalidError('That invite link has expired or was already used.')
      // Removing first claims the invite: a second sign-up on the same link finds it gone.
      await records.remove(INVITES, found.id).catch(() => { throw new InvalidError('That invite link has expired or was already used.') })
      role = String(found.role)
    } else if (!config.allowSignUp || !role) {
      throw new ForbiddenError('This app is invite-only. Ask an admin for an invite link.')
    }
    return await records.create(ACCOUNTS, { email, name, password: hashed, roles: [role], groups: [] }) as Account
  }

  async function mintInvite(role: string, origin: string, lifetime: number): Promise<string> {
    if (!roleIds.has(role)) throw new InvalidError(`Unknown role: ${role}`)
    const token = randomBytes(32).toString('base64url')
    await records.create(INVITES, { id: digest(token), role, expiresAt: new Date(Date.now() + lifetime).toISOString() })
    return `${origin}/?invite=${token}`
  }

  return {
    config,
    changes,
    manages,
    /** Build access is its own permission: a managing role or the `builder` role. */
    canBuild: (principal: Principal) => manages(principal) || (principal.kind === 'user' && principal.roles.includes('builder')),

    /** The principal behind a session cookie token; anonymous when there is none or it is no longer live. */
    async fromToken(token: string | undefined): Promise<Principal> {
      const found = token ? await live(digest(token)) : undefined
      return found ? user(found.account, found.session.id) : { kind: 'anonymous' }
    },

    /**
     * Re-reads a principal from stored accounts before trusted work runs. A session-bound principal
     * stays valid only while that session is live; a signed-in identity never degrades to anonymous.
     */
    async refresh(principal: Principal): Promise<Principal> {
      if (principal.kind !== 'user') return principal
      if (!principal.session) return resolveAccount(principal.id)
      const found = await live(principal.session)
      if (!found || found.account.id !== principal.id) throw new UnauthorizedError('This session has ended. Sign in again.')
      return user(found.account, found.session.id)
    },

    resolveAccount,

    /** True while any live session of this account exists. */
    async signedIn(id: string): Promise<boolean> {
      const sessions = await records.list(SESSIONS, { filter: { userId: id }, limit: 500 })
      return sessions.rows.some((session) => Date.parse(String(session.expiresAt)) > Date.now())
    },

    async me(principal: Principal): Promise<Member | null> {
      if (principal.kind !== 'user') return null
      const account = await records.get(ACCOUNTS, principal.id) as Account | null
      return account ? member(account) : null
    },

    async signIn(input: unknown, client: string): Promise<{ user: Member; token: string }> {
      const { email, password } = parse(inputs.signIn, input)
      const keys = [`email:${email}`, `client:${client}`]
      throttle(keys)
      const account = (await records.list(ACCOUNTS, { filter: { email }, limit: 1 })).rows[0] as Account | undefined
      // Hash even for an unknown address so timing does not reveal which addresses have accounts.
      if (!(await verify(password, account?.password ?? unknownAccount))) {
        fail(keys)
        throw new InvalidError('That email or password is not right.')
      }
      failures.delete(keys[0])
      return startSession(account!)
    },

    async signUp(input: unknown): Promise<{ user: Member; token: string }> {
      const { name, email, password, invite } = parse(inputs.signUp, input)
      const hashed = await hash(password)
      const step = signingUp.then(() => createAccount(name, email, hashed, invite))
      signingUp = step.catch(() => {})
      return startSession(await step)
    },

    async signOut(principal: Principal): Promise<void> {
      if (principal.kind !== 'user' || !principal.session) return
      await records.remove(SESSIONS, principal.session).catch(() => {})
      changes.emit('change', principal.id)
    },

    async members(actor: Principal): Promise<Member[]> {
      requireManager(actor)
      return (await all()).map(member)
    },

    async invite(actor: Principal, input: unknown, origin: string): Promise<string> {
      requireManager(actor)
      return mintInvite(parse(inputs.invite, input).role, origin, inviteLifetime)
    },

    async setRole(actor: Principal, id: string, input: unknown): Promise<void> {
      requireManager(actor)
      const { role } = parse(inputs.role, input)
      if (!roleIds.has(role)) throw new InvalidError(`Unknown role: ${role}`)
      const account = await target(id)
      await keepsAManager(account, [role])
      await records.update(ACCOUNTS, account.id, { roles: [role] })
      changes.emit('change', account.id)
    },

    async setGroups(actor: Principal, id: string, input: unknown): Promise<void> {
      requireManager(actor)
      const account = await target(id)
      await records.update(ACCOUNTS, account.id, { groups: [...new Set(parse(inputs.groups, input).groups)] })
      changes.emit('change', account.id)
    },

    async remove(actor: Principal, id: string): Promise<void> {
      requireManager(actor)
      const account = await target(id)
      await keepsAManager(account, null)
      const sessions = await records.list(SESSIONS, { filter: { userId: account.id }, limit: 500 })
      for (const session of sessions.rows) await records.remove(SESSIONS, session.id).catch(() => {})
      await records.remove(ACCOUNTS, account.id)
      changes.emit('change', account.id)
    },

    /**
     * A one-use invite for the first managing role, for the terminal that starts the server:
     * only while no account exists at all, or when the operator explicitly asks for recovery.
     */
    async managerInvite(origin: string, recover: boolean): Promise<string | undefined> {
      if (!recover && (await records.list(ACCOUNTS, { limit: 1 })).rows.length) return undefined
      return mintInvite(config.roles.find((role) => role.manages)!.id, origin, day)
    },
  }
}

export type Accounts = ReturnType<typeof createAccounts>

const keyLength = 64
const derive = (secret: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => scrypt(secret, salt, keyLength, (error, key) => error ? reject(error) : resolve(key)))

async function hash(secret: string): Promise<string> {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('base64')}$${(await derive(secret, salt)).toString('base64')}`
}

async function verify(secret: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !expected) return false
  const actual = await derive(secret, Buffer.from(salt, 'base64'))
  const wanted = Buffer.from(expected, 'base64')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted) && stored !== unknownAccount
}

// A well-formed hash no password matches; the last check in verify() refuses it outright.
const unknownAccount = `scrypt$${randomBytes(16).toString('base64')}$${randomBytes(keyLength).toString('base64')}`
