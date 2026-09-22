import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { ModelConfig } from '../config.ts'
import { ModelUnavailableError, z, type Model } from '../operations.ts'

/**
 * `context.model`, over a local agent CLI: Claude Code (the default, haiku) or Codex, whichever
 * `golem.config.ts` names in `model`. An app never learns which one answered — the runtime is the
 * app owner's choice, not the operation's.
 *
 * The prompt goes in on stdin, never in argv where `ps` would show it, and the call runs in a
 * temporary directory so nothing in the app's folder becomes part of it.
 */
const timeoutMs = 180_000

type Runtime = {
  executable: string
  args: string[]
  /** The answer text out of the CLI's own stdout format, or a reason there is none. */
  answer(out: string): { text: string } | { error: string }
}

const runtimes: Record<ModelConfig['runtime'], (name?: string) => Runtime> = {
  claude: (name = 'haiku') => ({
    executable: 'claude',
    args: ['-p', '--output-format', 'json', '--model', name, '--allowed-tools', '', '--strict-mcp-config'],
    answer(out) {
      const { is_error: failed, result } = JSON.parse(out) as { is_error?: boolean; result?: unknown }
      if (failed || typeof result !== 'string') return { error: typeof result === 'string' ? result : 'The model runtime reported an error.' }
      return { text: result }
    },
  }),
  // `--ephemeral` keeps the call out of ~/.codex/sessions; `-` reads the prompt from stdin.
  codex: (name) => ({
    executable: 'codex',
    args: ['exec', ...(name ? ['-m', name] : []), '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--json', '-'],
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
    async extract({ schema, text, instructions }) {
      const prompt = [
        instructions ?? 'Fill the schema from what the text actually says. Leave a field empty rather than guessing.',
        'Answer with one JSON value this JSON Schema accepts, and nothing else:',
        JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' })),
        `Text:\n${text}`,
      ].join('\n\n')
      const answer = await ask(runtime, prompt)
      let value: unknown
      try {
        value = JSON.parse(unfence(answer))
      } catch {
        throw new ModelUnavailableError('The model did not answer with JSON.')
      }
      const parsed = schema.safeParse(value)
      if (!parsed.success) throw new ModelUnavailableError(`The model's answer does not fit the schema: ${z.prettifyError(parsed.error)}`)
      return parsed.data
    },
  }
}

/** The answer text, or `ModelUnavailableError` for every way the runtime can fail to give one. */
function ask({ executable, args, answer }: Runtime, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
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
