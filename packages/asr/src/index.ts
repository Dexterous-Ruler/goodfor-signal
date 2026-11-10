/**
 * ASR providers for the Phase 2 analysis pipeline.
 *
 * Grounding — PHASE-2-understand.md §6.2 / completion.md §6.2 (both [VERIFIED]):
 *
 * 1. GROQ, DECISIVELY. `whisper-large-v3-turbo` at $0.04/audio-hour is exactly
 *    9.0x cheaper than OpenAI Whisper. Rate headroom is three orders of
 *    magnitude, so there is no rate-limit engineering here.
 *
 * 2. 10-SECOND BILLING FLOOR. Groq's minimum billed length is 10 s. A bare 3 s
 *    hook clip would pay a 3.3x markup, which is why the pipeline batches hook
 *    audio into the full-clip call — and why the cost here books the 10 s floor
 *    (`max(audioSeconds, 10)`), so the reported `costUsd` matches the invoice.
 *
 * 3. WORD TIMESTAMPS SPLIT THE HOOK. `response_format=verbose_json` +
 *    `timestamp_granularities[]=word` is the only thing that lets us slice the
 *    words spoken before t=3.0 s into `Transcript.hookText`.
 *
 * 4. DON'T SELF-HOST. One RTX 4090 GPU-hour beats two days of Groq by 2% — not
 *    worth it. `FasterWhisperAsrProvider` exists ONLY as a 429 circuit-breaker
 *    behind the same interface, and reports `costUsd = 0`.
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  ProviderError,
  type AsrProvider,
  type Transcript,
  type TranscriptWord,
} from '@goodfor/contracts'

// ---------------------------------------------------------------------------
// Constants (all grounded in §6.2)
// ---------------------------------------------------------------------------

export const GROQ_TRANSCRIPTIONS_URL =
  'https://api.groq.com/openai/v1/audio/transcriptions'

/** The turbo model — 9.0x cheaper than OpenAI Whisper, word timestamps included. */
export const GROQ_DEFAULT_MODEL = 'whisper-large-v3-turbo'

/** $0.04 per audio-hour. */
export const GROQ_PRICE_USD_PER_AUDIO_HOUR = 0.04

/** Groq bills a minimum of 10 seconds regardless of clip length. [VERIFIED] */
export const MIN_BILLED_SECONDS = 10

/** Words spoken before this offset (seconds) form the hook. */
export const HOOK_WINDOW_S = 3.0

/** Injectable fetch — defaults to the Node 20 global. */
export type FetchImpl = typeof fetch

// ---------------------------------------------------------------------------
// verbose_json shape
//
// Written from Groq's OpenAI-compatible `verbose_json` schema. NOTE: re-verify
// the exact field names on the first live Groq call — word objects live at the
// top level with `timestamp_granularities[]=word`, but some Whisper servers
// nest them under `segments`, so we defensively read both.
// ---------------------------------------------------------------------------

interface RawWord {
  word?: string
  start?: number
  end?: number
}

interface RawSegment {
  words?: RawWord[]
}

interface VerboseJson {
  text?: string
  language?: string
  duration?: number
  words?: RawWord[]
  segments?: RawSegment[]
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Flatten words from the top-level array, falling back to per-segment words. */
function collectWords(body: VerboseJson): TranscriptWord[] {
  const raw =
    Array.isArray(body.words) && body.words.length > 0
      ? body.words
      : (body.segments ?? []).flatMap((s) => s.words ?? [])

  const out: TranscriptWord[] = []
  for (const w of raw) {
    const word = typeof w?.word === 'string' ? w.word : ''
    const start = num(w?.start)
    const end = num(w?.end)
    if (word.trim() === '' || start === null || end === null) continue
    out.push({ word, start, end })
  }
  return out
}

/**
 * Billed audio length in seconds. Prefer the reported `duration`; fall back to
 * the last word's end time; 0 if the payload carries neither.
 */
function audioSeconds(body: VerboseJson, words: TranscriptWord[]): number {
  const d = num(body.duration)
  if (d !== null && d > 0) return d
  if (words.length > 0) return words[words.length - 1]!.end
  return 0
}

/** cost = max(seconds, 10s floor) / 3600 * $0.04. */
export function groqCostUsd(audioSecondsValue: number): number {
  const billed = Math.max(audioSecondsValue, MIN_BILLED_SECONDS)
  return (billed / 3600) * GROQ_PRICE_USD_PER_AUDIO_HOUR
}

/** verbose_json -> Transcript. `costUsd` is supplied by the caller. */
function toTranscript(body: VerboseJson, costUsd: number): Transcript {
  const words = collectWords(body)

  // The hook is everything said before t=3.0 s. Reconstruct from word tokens
  // (trimmed + single-spaced) rather than slicing `text`, since only the words
  // carry timestamps.
  const hookText = words
    .filter((w) => w.start < HOOK_WINDOW_S)
    .map((w) => w.word.trim())
    .filter((s) => s !== '')
    .join(' ')

  return {
    text: typeof body.text === 'string' ? body.text : '',
    words,
    language: typeof body.language === 'string' ? body.language : null,
    hookText,
    costUsd,
  }
}

// ---------------------------------------------------------------------------
// Shared multipart request
// ---------------------------------------------------------------------------

interface TranscriptionRequest {
  url: string
  apiKey: string | null
  model: string
  audioPath: string
  providerName: string
  fetchImpl: FetchImpl
}

/**
 * Reads the WAV off disk and POSTs it as multipart/form-data. The Node 20
 * `FormData` + `Blob` combo lets `fetch` set the `Content-Type` boundary
 * itself — never set it by hand or the boundary is lost.
 */
async function requestTranscription(req: TranscriptionRequest): Promise<VerboseJson> {
  let buf: Buffer
  try {
    buf = await readFile(req.audioPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ProviderError(`could not read audio ${req.audioPath}: ${msg}`, req.providerName)
  }

  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'audio/wav' }), basename(req.audioPath) || 'audio.wav')
  form.append('model', req.model)
  form.append('response_format', 'verbose_json')
  // The bracketed key is intentional — the API expects an array field.
  form.append('timestamp_granularities[]', 'word')

  const headers: Record<string, string> = { accept: 'application/json' }
  if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`

  let res: Response
  try {
    res = await req.fetchImpl(req.url, { method: 'POST', headers, body: form })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Network-level failure — a transport error is worth retrying.
    throw new ProviderError(`request to ${req.url} failed: ${msg}`, req.providerName, true)
  }

  if (res.status === 429 || res.status >= 500) {
    throw new ProviderError(`upstream ${res.status}`, req.providerName, true)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ProviderError(
      `transcription failed: ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`,
      req.providerName,
      false
    )
  }

  return (await res.json()) as VerboseJson
}

// ---------------------------------------------------------------------------
// Groq — the default
// ---------------------------------------------------------------------------

export interface GroqAsrOptions {
  /** Overrides `process.env.GROQ_API_KEY`. */
  apiKey?: string
  model?: string
  fetchImpl?: FetchImpl
}

export class GroqAsrProvider implements AsrProvider {
  readonly name = 'groq'
  private readonly apiKey: string | undefined
  private readonly model: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: GroqAsrOptions = {}) {
    // Read the key at construction; throw only at call time if it's absent, so
    // the object can be built in environments that never actually transcribe.
    this.apiKey = opts.apiKey ?? process.env.GROQ_API_KEY
    this.model = opts.model ?? GROQ_DEFAULT_MODEL
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async transcribe(audioPath: string): Promise<Transcript> {
    if (!this.apiKey) {
      throw new ProviderError('GROQ_API_KEY is not set', this.name)
    }

    const body = await requestTranscription({
      url: GROQ_TRANSCRIPTIONS_URL,
      apiKey: this.apiKey,
      model: this.model,
      audioPath,
      providerName: this.name,
      fetchImpl: this.fetchImpl,
    })

    const words = collectWords(body)
    const costUsd = groqCostUsd(audioSeconds(body, words))
    return toTranscript(body, costUsd)
  }
}

// ---------------------------------------------------------------------------
// faster-whisper — 429 circuit-breaker only
// ---------------------------------------------------------------------------

/** The local model tag is cosmetic — the container decides what it loads. */
export const FASTER_WHISPER_DEFAULT_MODEL = 'whisper-large-v3'
export const FASTER_WHISPER_DEFAULT_BASE_URL = 'http://127.0.0.1:8000'

export interface FasterWhisperAsrOptions {
  /** Base URL of the local faster-whisper container. */
  baseUrl?: string
  fetchImpl?: FetchImpl
}

/**
 * Minimal by design: a same-interface breaker for when Groq returns 429. It
 * POSTs to an OpenAI-compatible local endpoint and reports `costUsd = 0`
 * because self-hosting is a 2% saving the pipeline treats as free capacity.
 */
export class FasterWhisperAsrProvider implements AsrProvider {
  readonly name = 'faster-whisper'
  private readonly url: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: FasterWhisperAsrOptions = {}) {
    const base = (opts.baseUrl ?? FASTER_WHISPER_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.url = `${base}/v1/audio/transcriptions`
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async transcribe(audioPath: string): Promise<Transcript> {
    const body = await requestTranscription({
      url: this.url,
      apiKey: null,
      model: FASTER_WHISPER_DEFAULT_MODEL,
      audioPath,
      providerName: this.name,
      fetchImpl: this.fetchImpl,
    })
    return toTranscript(body, 0)
  }
}
