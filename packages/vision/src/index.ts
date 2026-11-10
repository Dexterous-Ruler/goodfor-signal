/**
 * Structured vision analysis via Gemini native video (generativelanguage
 * v1beta), the only one of {OpenAI, Anthropic, Google} that ingests a video
 * container rather than a bag of frames (completion.md §6.3).
 *
 * ONE Gemini call per video does everything: it watches the clip natively,
 * READS the on-screen text itself (no separate OCR — Cloud Vision at $270/mo is
 * 17x Flash-Lite for narrower output, §6.3), and returns JSON constrained to a
 * responseSchema so `hook_type` / `caption_style` / `audio_type` stay inside the
 * frozen enums and clusters remain comparable week to week. The ASR hook text
 * (t<3.0s) rides in as context so the model can separate spoken hook from
 * on-screen hook.
 *
 * COST IS LOAD-BEARING (§6.3). Gemini bills audio tokens on a *different line*
 * ($1.00/M) than text/video ($0.30/M on 2.5 Flash). Conflating them understates
 * the bill by 22–26%, so `computeCost` splits the audio modality out of
 * `usageMetadata` and prices it separately. Every provider reports what it spent
 * (contract rule) — `costUsd` is not decoration.
 *
 * Two lanes: `analyse()` is the synchronous quality lane (gemini-2.5-flash) for
 * the ~50–80/day alert-clearers where latency matters; `submitBatch()` /
 * `fetchBatch()` drive the Gemini Batch API (50% off, gemini-3.1-flash-lite) for
 * the ~420–450/day corpus feed. Batch jobs expire 48h after submit and results
 * are then unrecoverable, so the returned job carries `expiresAt = submitted +
 * 48h` for the `vision_batch_job` re-submit path the orchestrator persists.
 *
 * ⚠️ LIVE-VERIFICATION REQUIRED — like the read plane's `mapEnsembleVideo`, the
 * exact Gemini request/response SHAPES here (Files resumable-upload headers,
 * generateContent `usageMetadata.promptTokensDetails` modality names, and the
 * Batch API `batchGenerateContent` / long-running-operation envelope) are
 * written from documentation and have NOT been checked against a live key.
 * Run one real clip through `analyse()` and one real `submitBatch`/`fetchBatch`
 * round-trip and reconcile the field paths flagged `// UNVERIFIED` below before
 * trusting any cost number or parsed field in production.
 */

import {
  HOOK_TYPES,
  CAPTION_STYLES,
  AUDIO_TYPES,
  ProviderError,
  type VisionProvider,
  type VisionAnalysis,
  type MediaBundle,
  type Transcript,
  type HookType,
  type CaptionStyle,
  type AudioType,
  type OnScreenText,
} from '@goodfor/contracts'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

// ---------------------------------------------------------------------------
// Constants — models, endpoints, token mechanics, pricing
// ---------------------------------------------------------------------------

const PROVIDER = 'gemini-vision'

/** Quality / sync lane (alert-clearers, latency matters). */
export const DEFAULT_MODEL = 'gemini-2.5-flash'
/** Corpus / batch lane (not latency-sensitive; runs at 50% off). */
export const DEFAULT_BATCH_MODEL = 'gemini-3.1-flash-lite'

const BASE = 'https://generativelanguage.googleapis.com'
const API = `${BASE}/v1beta`
const UPLOAD_URL = `${BASE}/upload/v1beta/files`

/** Gemini stores video at 1 FPS; 258 tok/frame is the 2.5 default resolution. */
export const VIDEO_TOKENS_PER_FRAME = 258
/** 32 tok per second of audio, priced on the audio line. */
export const AUDIO_TOKENS_PER_SEC = 32

/** Gemini Batch jobs expire 48h after submission; results are then lost. */
export const BATCH_EXPIRY_MS = 48 * 60 * 60 * 1000
/** Batch API is 50% off the synchronous price (§6.3). */
export const BATCH_DISCOUNT = 0.5

/**
 * Prefer the Files API. Only clips at or below this size take the inline base64
 * fast-path (Gemini caps a single inline request near 20 MB total).
 */
export const INLINE_MAX_BYTES = 4 * 1024 * 1024

/**
 * Per-model $/1M-token rates. Audio input is a SEPARATE line from text/video —
 * that separation is the whole point of billing correctly (§6.3).
 *
 * ⚠️ UNVERIFIED rates for the two Flash-Lite models: the doc quotes only 2.5
 * Flash's split ($0.30 text-video / $1.00 audio) and per-video totals for the
 * lites. Reconcile against the live price sheet before trusting corpus-lane cost.
 */
export interface ModelPricing {
  /** Text / image / VIDEO input, $/1M tokens. */
  inputPerM: number
  /** AUDIO input, $/1M tokens — billed on its own line. */
  audioPerM: number
  /** Output tokens, $/1M tokens. */
  outputPerM: number
}

export const PRICING: Record<string, ModelPricing> = {
  // Verified split from completion.md §6.3.
  'gemini-2.5-flash': { inputPerM: 0.3, audioPerM: 1.0, outputPerM: 2.5 },
  // UNVERIFIED — plausible Flash-Lite rates; confirm before locking corpus cost.
  'gemini-2.5-flash-lite': { inputPerM: 0.1, audioPerM: 0.5, outputPerM: 0.4 },
  'gemini-3.1-flash-lite': { inputPerM: 0.1, audioPerM: 0.3, outputPerM: 0.4 },
}

function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? PRICING[DEFAULT_MODEL]!
}

// ---------------------------------------------------------------------------
// Structured-output schema — the enum guardrail
// ---------------------------------------------------------------------------

/**
 * Gemini responseSchema (OpenAPI subset). The `enum` arrays are the guardrail:
 * the model is constrained to the frozen taxonomy so a different label set never
 * leaks in. Anything the model still manages to emit out-of-enum is coerced to
 * 'unknown' on the way out (see `coerceEnum`).
 */
export const VISION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    hookType: { type: 'STRING', enum: [...HOOK_TYPES] },
    hookTextSequence: {
      type: 'ARRAY',
      description: 'Each distinct on-screen text state in the first 3s, in order.',
      items: {
        type: 'OBJECT',
        properties: {
          tSeconds: { type: 'NUMBER' },
          text: { type: 'STRING' },
        },
        required: ['tSeconds', 'text'],
        propertyOrdering: ['tSeconds', 'text'],
      },
    },
    spokenHook: { type: 'STRING', nullable: true },
    facePresent: { type: 'BOOLEAN' },
    faceScreenFraction: { type: 'NUMBER', nullable: true },
    cutCountFirst3s: { type: 'INTEGER' },
    captionStyle: { type: 'STRING', enum: [...CAPTION_STYLES] },
    audioType: { type: 'STRING', enum: [...AUDIO_TYPES] },
    formatSummary: { type: 'STRING' },
  },
  required: [
    'hookType',
    'hookTextSequence',
    'spokenHook',
    'facePresent',
    'faceScreenFraction',
    'cutCountFirst3s',
    'captionStyle',
    'audioType',
    'formatSummary',
  ],
  propertyOrdering: [
    'hookType',
    'hookTextSequence',
    'spokenHook',
    'facePresent',
    'faceScreenFraction',
    'cutCountFirst3s',
    'captionStyle',
    'audioType',
    'formatSummary',
  ],
} as const

// ---------------------------------------------------------------------------
// Batch-job types (feed the vision_batch_job table)
// ---------------------------------------------------------------------------

export type VisionBatchStatus = 'pending' | 'succeeded' | 'expired' | 'failed'

export interface VisionBatchJob {
  /** Gemini batch operation id (e.g. "batches/xyz"). */
  id: string
  status: VisionBatchStatus
  submittedAt: Date
  /** submittedAt + 48h — the re-submit deadline. */
  expiresAt: Date
  videoIds: number[]
  model: string
}

export interface VisionBatchResult {
  videoId: number
  analysis: VisionAnalysis | null
  error?: string
}

export interface VisionBatchFetch {
  id: string
  status: VisionBatchStatus
  results: VisionBatchResult[]
}

// ---------------------------------------------------------------------------
// Coercion helpers — never trust the model past the schema
// ---------------------------------------------------------------------------

function coerceEnum<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T
  // Every enum contains 'unknown' — the contract's coercion target.
  return 'unknown' as T
}

function clamp01(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}

function coerceInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}

function coerceStrOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s.length ? s : null
}

function coerceSequence(v: unknown): OnScreenText[] {
  if (!Array.isArray(v)) return []
  const out: OnScreenText[] = []
  for (const item of v) {
    const t = (item as { tSeconds?: unknown })?.tSeconds
    const text = (item as { text?: unknown })?.text
    const tn = typeof t === 'number' ? t : Number(t)
    if (typeof text === 'string' && Number.isFinite(tn)) {
      out.push({ tSeconds: Math.max(0, tn), text })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface GeminiVisionOptions {
  apiKey?: string
  model?: string
  batchModel?: string
  fetchImpl?: typeof fetch
}

interface GeminiFile {
  name?: string
  uri?: string
  mimeType?: string
  state?: string
}

/** Shape of Gemini's usageMetadata we depend on for costing. */
interface UsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>
}

interface CostHint {
  audioSeconds?: number
  videoFrames?: number
}

export class GeminiVisionProvider implements VisionProvider {
  readonly name = PROVIDER
  readonly model: string
  readonly batchModel: string
  private readonly apiKey: string | null
  private readonly fetchImpl: typeof fetch

  constructor(opts: GeminiVisionOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? null
    this.model = opts.model ?? DEFAULT_MODEL
    this.batchModel = opts.batchModel ?? DEFAULT_BATCH_MODEL
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /** Read the key lazily so construction never throws — only a real call does. */
  private requireKey(): string {
    if (!this.apiKey) {
      throw new ProviderError('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set', this.name, false)
    }
    return this.apiKey
  }

  // -------------------------------------------------------------------------
  // Sync lane
  // -------------------------------------------------------------------------

  async analyse(bundle: MediaBundle, transcript: Transcript | null): Promise<VisionAnalysis> {
    this.requireKey()

    const videoPart = await this.videoPart(bundle)
    const body = this.generateBody(videoPart, transcript)

    const json = await this.postJson<GenerateResponse>(
      `${API}/models/${encodeURIComponent(this.model)}:generateContent`,
      body,
      /*costOnError*/ 0
    )

    return this.parseAnalysis(json, this.model, /*batch*/ false, this.hintFrom(bundle))
  }

  // -------------------------------------------------------------------------
  // Batch lane
  // -------------------------------------------------------------------------

  /**
   * Create a Gemini Batch job over `videoIds`. Each video is uploaded via the
   * Files API and referenced by a per-request `key` (`video-<id>`) so results
   * can be mapped back in `fetchBatch`. Returns a `pending` job with
   * `expiresAt = submittedAt + 48h`.
   */
  async submitBatch(videoIds: number[], bundles: MediaBundle[]): Promise<VisionBatchJob> {
    this.requireKey()

    const byId = new Map<number, MediaBundle>()
    for (const b of bundles) byId.set(b.videoId, b)

    const requests: unknown[] = []
    for (const videoId of videoIds) {
      const bundle = byId.get(videoId)
      if (!bundle) {
        throw new ProviderError(`submitBatch: no bundle for video ${videoId}`, this.name, false)
      }
      const videoPart = await this.videoPart(bundle)
      requests.push({
        // UNVERIFIED: Batch inlined-request envelope. Each entry pairs a request
        // with a key we read back off the response to recover the videoId.
        key: `video-${videoId}`,
        request: this.generateBody(videoPart, null),
      })
    }

    const submittedAt = new Date()
    const created = await this.postJson<BatchCreateResponse>(
      `${API}/models/${encodeURIComponent(this.batchModel)}:batchGenerateContent`,
      {
        batch: {
          displayName: `vision-${submittedAt.getTime()}`,
          inputConfig: { requests: { requests } },
        },
      },
      0
    )

    const id = created?.name ?? created?.batch?.name ?? ''
    if (!id) throw new ProviderError('batch create returned no job name', this.name, true)

    return {
      id,
      status: 'pending',
      submittedAt,
      expiresAt: new Date(submittedAt.getTime() + BATCH_EXPIRY_MS),
      videoIds: [...videoIds],
      model: this.batchModel,
    }
  }

  /**
   * Poll a batch job. While the operation is not `done`, returns `pending` with
   * no results. On completion, parses each inlined response back to its videoId
   * via the request `key`.
   */
  async fetchBatch(jobId: string): Promise<VisionBatchFetch> {
    this.requireKey()

    const op = await this.getJson<BatchOperation>(`${API}/${stripLeadingSlash(jobId)}`)

    if (op?.error) {
      return { id: jobId, status: 'failed', results: [] }
    }
    if (!op?.done) {
      return { id: jobId, status: 'pending', results: [] }
    }

    // UNVERIFIED: results envelope. The completed operation carries an array of
    // { key, response } (or { key, error }) entries keyed `video-<id>`.
    const entries = op.response?.inlinedResponses?.inlinedResponses ?? []
    const results: VisionBatchResult[] = []
    for (const entry of entries) {
      const videoId = parseVideoKey(entry.key)
      if (videoId === null) continue
      if (entry.error || !entry.response) {
        results.push({ videoId, analysis: null, error: entry.error?.message ?? 'batch item failed' })
        continue
      }
      try {
        const analysis = this.parseAnalysis(entry.response, this.batchModel, /*batch*/ true)
        results.push({ videoId, analysis })
      } catch (err) {
        results.push({
          videoId,
          analysis: null,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { id: jobId, status: 'succeeded', results }
  }

  // -------------------------------------------------------------------------
  // Request building
  // -------------------------------------------------------------------------

  private generateBody(videoPart: unknown, transcript: Transcript | null): unknown {
    return {
      contents: [{ role: 'user', parts: [videoPart, { text: buildPrompt(transcript) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: VISION_SCHEMA,
        temperature: 0,
      },
    }
  }

  /**
   * Turn a clip into a Gemini content part. Prefers the Files API (upload, then
   * reference by URI); falls back to inline base64 only for tiny clips.
   */
  private async videoPart(bundle: MediaBundle): Promise<unknown> {
    const mimeType = mimeForPath(bundle.videoPath)
    let size = Infinity
    try {
      size = (await stat(bundle.videoPath)).size
    } catch {
      // stat may fail on a synthetic path in tests — fall through to Files API.
    }

    if (size <= INLINE_MAX_BYTES) {
      const bytes = await readFile(bundle.videoPath)
      return { inlineData: { mimeType, data: bytes.toString('base64') } }
    }

    const file = await this.uploadFile(bundle.videoPath, mimeType)
    return { fileData: { mimeType: file.mimeType ?? mimeType, fileUri: file.uri } }
  }

  /**
   * Gemini Files API resumable upload: (1) start → server returns an upload URL
   * in the `x-goog-upload-url` header; (2) POST the bytes with
   * `upload, finalize` → server returns the file object. If the file comes back
   * PROCESSING we poll until ACTIVE (video transcode).
   */
  private async uploadFile(videoPath: string, mimeType: string): Promise<GeminiFile> {
    const key = this.requireKey()
    const bytes = await readFile(videoPath)

    const start = await this.fetchImpl(`${UPLOAD_URL}?key=${key}`, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(bytes.byteLength),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: videoPath } }),
    })
    if (!start.ok) throw await this.httpError(start, 'files upload start')

    const uploadUrl = start.headers.get('x-goog-upload-url')
    if (!uploadUrl) throw new ProviderError('files upload: missing upload URL header', this.name, true)

    const finalize = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
        'Content-Length': String(bytes.byteLength),
      },
      body: bytes,
    })
    if (!finalize.ok) throw await this.httpError(finalize, 'files upload finalize')

    const uploaded = (await finalize.json()) as { file?: GeminiFile }
    let file = uploaded?.file ?? {}

    // Wait out video transcode. Bounded so a stuck file can't hang the worker.
    let attempts = 0
    while (file.state === 'PROCESSING' && file.name && attempts < 30) {
      attempts++
      const polled = await this.getJson<GeminiFile>(`${API}/${stripLeadingSlash(file.name)}`)
      file = polled ?? file
      if (file.state === 'PROCESSING') await delay(1000)
    }
    if (file.state && file.state !== 'ACTIVE') {
      throw new ProviderError(`uploaded file not ACTIVE (state=${file.state})`, this.name, true)
    }
    return file
  }

  // -------------------------------------------------------------------------
  // Response parsing + costing
  // -------------------------------------------------------------------------

  private parseAnalysis(
    json: GenerateResponse,
    model: string,
    batch: boolean,
    hint?: CostHint
  ): VisionAnalysis {
    const raw = extractJson(json)
    if (raw === null) {
      throw new ProviderError('Gemini returned no parseable JSON candidate', this.name, true)
    }

    const costUsd = computeCost(model, json.usageMetadata, { batch, hint })
    const modelVersion = json.modelVersion ?? model

    return {
      hookType: coerceEnum<HookType>(raw.hookType, HOOK_TYPES),
      hookTextSequence: coerceSequence(raw.hookTextSequence),
      spokenHook: coerceStrOrNull(raw.spokenHook),
      facePresent: Boolean(raw.facePresent),
      faceScreenFraction: clamp01(raw.faceScreenFraction),
      cutCountFirst3s: coerceInt(raw.cutCountFirst3s),
      captionStyle: coerceEnum<CaptionStyle>(raw.captionStyle, CAPTION_STYLES),
      audioType: coerceEnum<AudioType>(raw.audioType, AUDIO_TYPES),
      formatSummary: typeof raw.formatSummary === 'string' ? raw.formatSummary : '',
      modelVersion,
      costUsd,
    }
  }

  private hintFrom(bundle: MediaBundle): CostHint {
    const durationS = bundle.probe?.durationS ?? 0
    return {
      audioSeconds: bundle.probe?.hasAudio ? durationS : 0,
      // Gemini samples 1 FPS.
      videoFrames: Math.max(1, Math.round(durationS)),
    }
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  private async postJson<T>(url: string, body: unknown, costOnError: number): Promise<T> {
    const key = this.requireKey()
    const res = await this.fetchImpl(`${url}?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw await this.httpError(res, 'generateContent', costOnError)
    return (await res.json()) as T
  }

  private async getJson<T>(url: string): Promise<T> {
    const key = this.requireKey()
    const res = await this.fetchImpl(`${url}?key=${key}`, { method: 'GET' })
    if (!res.ok) throw await this.httpError(res, 'get')
    return (await res.json()) as T
  }

  private async httpError(res: Response, where: string, costUsd = 0): Promise<ProviderError> {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      /* ignore */
    }
    const retryable = res.status === 429 || res.status >= 500
    return new ProviderError(
      `Gemini ${where} failed: ${res.status} ${detail}`,
      this.name,
      retryable,
      costUsd
    )
  }
}

// ---------------------------------------------------------------------------
// Cost — the audio-line split (§6.3)
// ---------------------------------------------------------------------------

/**
 * Price a Gemini call from `usageMetadata`, billing the AUDIO modality on its
 * own ($1.00/M) line, apart from text/video ($0.30/M) and output. Prefers the
 * per-modality `promptTokensDetails`; when absent, estimates audio from clip
 * duration (32 tok/s) and video from frame count (258 tok/frame).
 *
 * Conflating audio into the text/video line understates cost by 22–26% — this
 * function is the reason that does not happen.
 */
export function computeCost(
  model: string,
  usage: UsageMetadata | undefined,
  opts: { batch?: boolean; hint?: CostHint } = {}
): number {
  const price = pricingFor(model)
  const details = usage?.promptTokensDetails ?? []

  let audioTokens = 0
  for (const d of details) {
    if ((d.modality ?? '').toUpperCase() === 'AUDIO') audioTokens += d.tokenCount ?? 0
  }

  const promptTokens = usage?.promptTokenCount ?? 0

  // Fall back to duration/frame estimates when the API gave us no breakdown.
  if (audioTokens === 0 && opts.hint?.audioSeconds) {
    audioTokens = Math.round(opts.hint.audioSeconds * AUDIO_TOKENS_PER_SEC)
  }

  let nonAudioInput = Math.max(0, promptTokens - audioTokens)
  if (promptTokens === 0 && opts.hint?.videoFrames) {
    nonAudioInput = opts.hint.videoFrames * VIDEO_TOKENS_PER_FRAME
  }

  const outputTokens = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0)

  let cost =
    (nonAudioInput / 1e6) * price.inputPerM +
    (audioTokens / 1e6) * price.audioPerM +
    (outputTokens / 1e6) * price.outputPerM

  if (opts.batch) cost *= BATCH_DISCOUNT

  // Round to sub-cent-of-a-cent precision; costs are summed across ~500/day.
  return Math.round(cost * 1e8) / 1e8
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(transcript: Transcript | null): string {
  const hook = transcript?.hookText?.trim()
  const asrContext = hook
    ? `\n\nASR transcript of the first 3 seconds (spoken words, for context — the ` +
      `spoken hook may differ from on-screen text): "${hook}"`
    : '\n\nNo ASR hook text was available for the first 3 seconds.'

  return (
    `You are analysing the opening of a short-form vertical video (TikTok). ` +
    `Watch the video natively and READ every on-screen text overlay yourself — ` +
    `do not rely on any external OCR.\n\n` +
    `Return ONLY JSON matching the provided schema. Rules:\n` +
    `- hookType: the single best-fitting category from the allowed enum.\n` +
    `- hookTextSequence: each DISTINCT on-screen text state within the first 3 ` +
    `seconds, with the timestamp (seconds) it first appears, in order.\n` +
    `- spokenHook: the words actually spoken in the first ~3s, or null if silent.\n` +
    `- facePresent: whether a human face is visible in the opening.\n` +
    `- faceScreenFraction: 0..1, the fraction of the frame the largest face ` +
    `occupies at its peak in the opening, or null if no face.\n` +
    `- cutCountFirst3s: number of hard cuts/scene changes in the first 3 seconds.\n` +
    `- captionStyle / audioType: the single best-fitting enum value.\n` +
    `- formatSummary: one or two sentences describing the video's format, for ` +
    `clustering (structure, not topic).` +
    asrContext
  )
}

// ---------------------------------------------------------------------------
// Response shapes + small parsers (all UNVERIFIED against a live API)
// ---------------------------------------------------------------------------

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: UsageMetadata
  modelVersion?: string
}

interface BatchCreateResponse {
  name?: string
  batch?: { name?: string }
}

interface BatchOperation {
  name?: string
  done?: boolean
  error?: { message?: string }
  response?: {
    inlinedResponses?: {
      inlinedResponses?: Array<{
        key?: string
        error?: { message?: string }
        response?: GenerateResponse
      }>
    }
  }
}

/** Pull the JSON object out of a generateContent candidate's text parts. */
function extractJson(json: GenerateResponse): Record<string, unknown> | null {
  const parts = json?.candidates?.[0]?.content?.parts ?? []
  const text = parts
    .map((p) => p?.text ?? '')
    .join('')
    .trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function parseVideoKey(key: string | undefined): number | null {
  if (!key) return null
  const m = /^video-(\d+)$/.exec(key)
  return m ? Number(m[1]) : null
}

function mimeForPath(p: string): string {
  const ext = extname(p).toLowerCase()
  switch (ext) {
    case '.mov':
      return 'video/quicktime'
    case '.webm':
      return 'video/webm'
    case '.mpeg':
    case '.mpg':
      return 'video/mpeg'
    case '.avi':
      return 'video/x-msvideo'
    default:
      return 'video/mp4'
  }
}

function stripLeadingSlash(s: string): string {
  return s.startsWith('/') ? s.slice(1) : s
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
