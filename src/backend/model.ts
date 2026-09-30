import { spawn } from 'node:child_process'
import { access, constants, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { ModelConfig } from '../config.ts'
import { InvalidError, ModelUnavailableError, z, type Model } from '../operations.ts'

/**
 * `context.model`, over a local agent CLI: Claude Code (the default, haiku) or Codex, whichever
 * `golem.config.ts` names in `model`. An app never learns which one answered — the runtime is the
 * app owner's choice, not the operation's.
 *
 * The prompt goes in on stdin, never in argv where `ps` would show it, and the call runs in a
 * temporary directory so nothing in the app's folder becomes part of it.
 */
const timeoutMs = 180_000

const maxImages = 10

type Runtime = {
  executable: string
  /** `schema` is the strict JSON Schema the answer must meet, when the call's schema has one. */
  args(images: string[], schema?: Schema): string[] | Promise<string[]>
  /** Whether the CLI can be handed image files at all. */
  images: 'flag' | 'none'
  /** The answer text out of the CLI's own stdout format, or a reason there is none. */
  answer(out: string): { text: string } | { error: string }
}

const runtimes: Record<ModelConfig['runtime'], (name?: string) => Runtime> = {
  claude: (name = 'haiku') => ({
    executable: 'claude',
    args: (_, schema) => ['-p', '--output-format', 'json', '--model', name, '--allowed-tools', '', '--strict-mcp-config', ...(schema ? ['--json-schema', JSON.stringify(schema)] : [])],
    images: 'none',
    answer(out) {
      const { is_error: failed, result, structured_output: structured } = JSON.parse(out) as { is_error?: boolean; result?: unknown; structured_output?: unknown }
      if (failed || typeof result !== 'string') return { error: typeof result === 'string' ? result : 'The model runtime reported an error.' }
      // Under `--json-schema` the validated value comes apart from the free text in `result`.
      return { text: structured === undefined ? result : JSON.stringify(structured) }
    },
  }),
  // `--ephemeral` keeps the call out of ~/.codex/sessions; `-` reads the prompt from stdin.
  codex: (name) => ({
    executable: 'codex',
    // `-i <file>` attaches an image to the initial prompt; the CLI reads it, nothing is copied.
    async args(images, schema) {
      const flags = ['exec', ...(name ? ['-m', name] : []), ...images.flatMap((path) => ['-i', path]), '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--json']
      if (!schema) return [...flags, '-']
      // `--output-schema` reads a file; `ask` removes the directory once the call is over.
      const file = join(await mkdtemp(join(tmpdir(), 'golem-schema-')), 'schema.json')
      await writeFile(file, JSON.stringify(schema))
      return [...flags, '--output-schema', file, '-']
    },
    images: 'flag',
    answer(out) {
      // JSONL events; the answer is the last agent message, a failed turn carries its reason.
      let text: string | undefined
      let error: string | undefined
      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        const event = JSON.parse(line) as { type: string; item?: { type: string; text?: string }; error?: { message?: string } }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text
        if (event.type === 'turn.failed') error = event.error?.message ?? 'The model runtime reported an error.'
      }
      return error ? { error } : text === undefined ? { error: 'The model gave no answer.' } : { text }
    },
  }),
}

export function openModel(config: ModelConfig = { runtime: 'claude' }): Model {
  const runtime = runtimes[config.runtime](config.name)
  return {
    async extract({ schema, text, instructions, images = [] }) {
      // Input problems first, runtime limits second, spawn last.
      if (images.length > maxImages) throw new InvalidError(`At most ${maxImages} images per call.`)
      for (const path of images) {
        if (!isAbsolute(path)) throw new InvalidError(`Image not readable: ${basename(path)}`)
        try {
          await access(path, constants.R_OK)
        } catch {
          throw new InvalidError(`Image not readable: ${basename(path)}`)
        }
      }
      if (images.length && runtime.images === 'none') throw new ModelUnavailableError('This model runtime reads no images.')
      const jsonSchema = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Schema
      const prompt = [
        instructions ?? 'Fill the schema from what the text actually says. Leave a field empty rather than guessing.',
        'Answer with one JSON value this JSON Schema accepts, and nothing else:',
        JSON.stringify(jsonSchema),
        `Text:\n${text}`,
        ...(images.length ? [`Images: ${images.length} attached, in the order given.`] : []),
      ].join('\n\n')
      const answer = await ask(runtime, prompt, images, strict(jsonSchema))
      let value: unknown
      try {
        value = JSON.parse(unfence(answer))
      } catch {
        throw new ModelUnavailableError('The model did not answer with JSON.')
      }
      const parsed = schema.safeParse(absent(value, jsonSchema))
      if (!parsed.success) throw new ModelUnavailableError(`The model's answer does not fit the schema: ${z.prettifyError(parsed.error)}`)
      return parsed.data
    },
  }
}

/** The answer text, or `ModelUnavailableError` for every way the runtime can fail to give one. */
async function ask({ executable, args, answer }: Runtime, prompt: string, images: string[], schema?: Schema): Promise<string> {
  const argv = await args(images, schema)
  try {
    return await spawnAsk(executable, argv, answer, prompt)
  } finally {
    const at = argv.indexOf('--output-schema')
    if (at >= 0) await rm(dirname(argv[at + 1]), { recursive: true, force: true })
  }
}

function spawnAsk(executable: string, argv: string[], answer: Runtime['answer'], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let error = ''
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    let timedOut = false
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.once('error', (cause: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new ModelUnavailableError(cause.code === 'ENOENT' ? `No model runtime: ${executable} is not installed.` : `The model runtime failed to start: ${cause.message}`))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new ModelUnavailableError('The model did not answer in time.'))
      if (code !== 0) return reject(new ModelUnavailableError(`The model runtime exited with code ${code}${error.trim() ? `: ${error.trim().slice(0, 200)}` : ''}`))
      let result: ReturnType<Runtime['answer']>
      try {
        result = answer(out)
      } catch {
        return reject(new ModelUnavailableError('The model runtime did not answer in its own format.'))
      }
      if ('error' in result) return reject(new ModelUnavailableError(result.error.slice(0, 200)))
      resolve(result.text)
    })
    child.stdin.end(prompt)
  })
}

/** Models like to wrap JSON in a ``` fence whatever the instruction says. */
const unfence = (text: string) => text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

type Schema = { [key: string]: unknown }

/**
 * The call's JSON Schema in the form strict structured output accepts (OpenAI's rules, which the
 * codex runtime enforces and claude takes as well): every object closed and every property
 * required, an optional one widened to allow null. A schema with a part it cannot state — a record,
 * a tuple, an unrepresentable type — gives undefined, and the call runs unconstrained as before.
 * Bounds, patterns and formats pass through; zod checks them again either way.
 */
export function strict(node: Schema): Schema | undefined {
  const { $schema, oneOf, ...rest } = node
  const anyOf = (node.anyOf ?? oneOf) as Schema[] | undefined
  if (anyOf) {
    const branches = anyOf.map(strict)
    return branches.every(Boolean) ? { ...rest, anyOf: branches } : undefined
  }
  if (!node.type || node.prefixItems) return undefined
  if (node.items) {
    const items = strict(node.items as Schema)
    return items && { ...rest, items }
  }
  if (node.type !== 'object') return rest
  if (node.additionalProperties !== false) return undefined
  const required = new Set((node.required ?? []) as string[])
  const properties: Record<string, Schema> = {}
  for (const [key, value] of Object.entries((node.properties ?? {}) as Record<string, Schema>)) {
    const property = strict(value)
    if (!property) return undefined
    properties[key] = required.has(key) ? property : { anyOf: [property, { type: 'null' }] }
  }
  return { ...rest, properties, required: Object.keys(properties), additionalProperties: false }
}

/**
 * Strict output answers an absent optional property with null; that null goes back to absent. A
 * property the schema requires keeps its null, so a genuinely nullable field still reads as one.
 */
function absent(value: unknown, node: Schema): unknown {
  for (const branch of ((node.anyOf ?? node.oneOf ?? []) as Schema[])) value = absent(value, branch)
  if (Array.isArray(value) && node.items) return value.map((item) => absent(item, node.items as Schema))
  if (!value || typeof value !== 'object' || !node.properties) return value
  const properties = node.properties as Record<string, Schema>
  const required = (node.required ?? []) as string[]
  return Object.fromEntries(Object.entries(value)
    .filter(([key, v]) => !(v === null && key in properties && !required.includes(key)))
    .map(([key, v]) => [key, key in properties ? absent(v, properties[key]) : v]))
}
