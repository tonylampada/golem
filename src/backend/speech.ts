import type { SpeechConfig } from '../config.ts'

const TIMEOUT = 60_000

const base = (config: SpeechConfig) =>
  (config.provider === 'whisper' ? config.url : config.url ?? 'https://api.openai.com/v1').replace(/\/+$/, '')

/**
 * Recorded audio to text through whatever service the app configured. Both providers take the same
 * multipart shape, so the only real difference is the path, the key and the model field.
 */
export async function transcribe(config: SpeechConfig, audio: Buffer, mime: string): Promise<string> {
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(audio)], { type: mime || 'application/octet-stream' }), filename(mime))
  if (config.language) form.set('language', config.language)
  const headers: Record<string, string> = {}
  if (config.provider === 'openai') {
    const key = process.env[config.apiKeyEnv]
    if (!key) throw new Error(`Speech to text needs ${config.apiKeyEnv} in the server's environment.`)
    headers.Authorization = `Bearer ${key}`
    form.set('model', config.model ?? 'whisper-1')
  }
  const url = `${base(config)}${config.provider === 'whisper' ? '/transcribe' : '/audio/transcriptions'}`
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', body: form, headers, signal: AbortSignal.timeout(TIMEOUT) })
  } catch (error) {
    throw new Error(`The speech service did not answer (${message(error)}).`)
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`The speech service refused the audio (${response.status}): ${text.slice(0, 200)}`)
  let body: unknown
  try { body = JSON.parse(text) } catch { throw new Error('The speech service answered with something other than JSON.') }
  const said = (body as { text?: unknown }).text
  if (typeof said !== 'string') throw new Error('The speech service answered without any text.')
  return said.trim()
}

/** One startup line: a local whisper can be asked whether it is there; the hosted API is only named. */
export async function probeSpeech(config: SpeechConfig): Promise<string> {
  if (config.provider !== 'whisper') return `Speech to text: openai ${config.model ?? 'whisper-1'} at ${base(config)}`
  try {
    const response = await fetch(`${base(config)}/health`, { signal: AbortSignal.timeout(5_000) })
    const health = await response.json().catch(() => ({})) as { status?: string; model?: string }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return `Speech to text: whisper at ${base(config)} (${health.model ?? health.status ?? 'ok'})`
  } catch (error) {
    return `Speech to text: whisper at ${base(config)} is not answering (${message(error)}); the microphone will fail until it is up.`
  }
}

// Whisper servers pick their decoder by extension, so the name has to follow the recorded type.
function filename(mime: string): string {
  const subtype = mime.split(';')[0].split('/')[1] ?? 'webm'
  return `audio.${({ mpeg: 'mp3', 'x-wav': 'wav', wave: 'wav' } as Record<string, string>)[subtype] ?? subtype}`
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
