import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { ModelUnavailableError, z, type Model } from '../operations.ts'

/**
 * `context.model`, over the local Claude Code CLI: the model runtime Golem already depends on for
 * build mode, and the only one that answers without an API key. An app never learns which model
 * answered — a box with `ANTHROPIC_API_KEY` replaces this file's insides, not the app's operation.
 *
 * The prompt goes in on stdin, never in argv where `ps` would show it, and the call runs in a
 * temporary directory so nothing in the app's folder becomes part of it.
 */
const executable = 'claude'
const model = 'haiku'
const timeoutMs = 180_000

export function openModel(): Model {
  return {
    async extract({ schema, text, instructions }) {
      const prompt = [
        instructions ?? 'Fill the schema from what the text actually says. Leave a field empty rather than guessing.',
        'Answer with one JSON value this JSON Schema accepts, and nothing else:',
        JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' })),
        `Text:\n${text}`,
      ].join('\n\n')
      const answer = await ask(prompt)
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
function ask(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-p', '--output-format', 'json', '--model', model, '--allowed-tools', '', '--strict-mcp-config'], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
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
      let result: unknown
      try {
        result = JSON.parse(out)
      } catch {
        return reject(new ModelUnavailableError('The model runtime did not answer in its own format.'))
      }
      const { is_error: failed, result: answer } = result as { is_error?: boolean; result?: unknown }
      if (failed || typeof answer !== 'string') return reject(new ModelUnavailableError(typeof answer === 'string' ? answer.slice(0, 200) : 'The model runtime reported an error.'))
      resolve(answer)
    })
    child.stdin.end(prompt)
  })
}

/** Models like to wrap JSON in a ``` fence whatever the instruction says. */
const unfence = (text: string) => text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
