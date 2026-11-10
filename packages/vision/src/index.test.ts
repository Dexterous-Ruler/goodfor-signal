import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GeminiVisionProvider,
  computeCost,
  VISION_SCHEMA,
  BATCH_EXPIRY_MS,
  DEFAULT_MODEL,
  DEFAULT_BATCH_MODEL,
  INLINE_MAX_BYTES,
  type VisionBatchFetch,
} from './index.js'
import {
  HOOK_TYPES,
  CAPTION_STYLES,
  AUDIO_TYPES,
  ProviderError,
  type MediaBundle,
  type Transcript,
} from '@goodfor/contracts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string
let bigVideo: string // > INLINE_MAX_BYTES → forces the Files API path
let tinyVideo: string // < INLINE_MAX_BYTES → forces the inline base64 path

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vision-test-'))
  bigVideo = join(dir, 'big.mp4')
  tinyVideo = join(dir, 'tiny.mp4')
  await writeFile(bigVideo, Buffer.alloc(INLINE_MAX_BYTES + 1024, 7))
  await writeFile(tinyVideo, Buffer.from('not really a video, just tiny'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeBundle(videoId: number, videoPath: string): MediaBundle {
  return {
    videoId,
    videoPath,
    audioPath: join(dir, `audio-${videoId}.wav`),
    keyframes: [{ path: join(dir, 'kf0.png'), tSeconds: 0 }],
    hookFrames: [{ path: join(dir, 'hf0.png'), tSeconds: 0 }],
    probe: { durationS: 30, width: 1080, height: 1920, fps: 30, hasAudio: true },
  }
}

const transcript: Transcript = {
  text: 'here is the whole transcript of the clip',
  words: [
    { word: 'wait', start: 0.2, end: 0.5 },
    { word: 'for', start: 0.5, end: 0.7 },
    { word: 'it', start: 0.7, end: 0.9 },
  ],
  language: 'en',
  hookText: 'wait for it',
  costUsd: 0.0001,
}

/** The model's (deliberately messy) structured output, to exercise coercion. */
const MODEL_OUTPUT = {
  hookType: 'question',
  hookTextSequence: [
    { tSeconds: 0, text: 'POV:' },
    { tSeconds: 0.8, text: 'you found the app' },
  ],
  spokenHook: 'wait for it',
  facePresent: true,
  faceScreenFraction: 1.5, // out of range → clamps to 1
  cutCountFirst3s: 2.7, // non-integer → rounds to 3
  captionStyle: 'WEIRD_STYLE_NOT_IN_ENUM', // → 'unknown'
  audioType: 'trending_sound',
  formatSummary: 'Static talking head with swapping large statement text.',
}

/** usageMetadata with the audio modality broken out — the costing hinge. */
const USAGE = {
  promptTokenCount: 8700,
  candidatesTokenCount: 200,
  totalTokenCount: 8900,
  promptTokensDetails: [
    { modality: 'VIDEO', tokenCount: 7740 },
    { modality: 'AUDIO', tokenCount: 960 },
  ],
}

// ---------------------------------------------------------------------------
// fetch mock — dispatches by URL/method/headers, returns real Response objects
// ---------------------------------------------------------------------------

interface Call {
  url: string
  method: string
  body: string | undefined
}

function makeFetch(opts?: {
  batchName?: string
  operation?: unknown
  generate?: unknown
}) {
  const calls: Call[] = []
  const UPLOAD_SESSION = 'https://upload.example/session/abc'

  const jsonRes = (obj: unknown) =>
    new Response(JSON.stringify(obj), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  const generateBody = opts?.generate ?? { candidates: [{ content: { parts: [{ text: JSON.stringify(MODEL_OUTPUT) }] } }], usageMetadata: USAGE, modelVersion: 'gemini-2.5-flash-002' }

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ url, method, body })

    const cmd = headers['X-Goog-Upload-Command'] ?? headers['x-goog-upload-command']

    // (a) Files API — resumable start: hand back the session URL in a header.
    if (url.includes('/upload/v1beta/files') && cmd === 'start') {
      return new Response(null, { status: 200, headers: { 'x-goog-upload-url': UPLOAD_SESSION } })
    }
    // Files API — bytes upload+finalize: return an ACTIVE file object.
    if (url === UPLOAD_SESSION) {
      return jsonRes({
        file: {
          name: 'files/abc123',
          uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
          mimeType: 'video/mp4',
          state: 'ACTIVE',
        },
      })
    }
    // (c) Batch create — must be checked BEFORE :generateContent (it contains it).
    if (url.includes(':batchGenerateContent')) {
      return jsonRes({ name: opts?.batchName ?? 'batches/job-1' })
    }
    // Batch operation poll.
    if (url.includes('/batches/') && method === 'GET') {
      return jsonRes(opts?.operation ?? { done: false })
    }
    // (b) generateContent — the sync analysis call.
    if (url.includes(':generateContent')) {
      return jsonRes(generateBody)
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  }) as unknown as typeof fetch

  return { fetchImpl, calls, UPLOAD_SESSION }
}

// ---------------------------------------------------------------------------
// analyse()
// ---------------------------------------------------------------------------

describe('GeminiVisionProvider.analyse', () => {
  it('sends the structured-output schema and the ASR hook context', async () => {
    const { fetchImpl, calls } = makeFetch()
    const p = new GeminiVisionProvider({ apiKey: 'test-key', fetchImpl })

    await p.analyse(makeBundle(1, bigVideo), transcript)

    const gen = calls.find((c) => c.url.includes(':generateContent'))
    expect(gen).toBeDefined()
    expect(gen!.url).toContain(`/models/${DEFAULT_MODEL}:generateContent`)

    const req = JSON.parse(gen!.body!)
    expect(req.generationConfig.responseMimeType).toBe('application/json')
    // The enum guardrail is actually on the wire, not just in our types.
    expect(req.generationConfig.responseSchema.properties.hookType.enum).toEqual([...HOOK_TYPES])
    expect(req.generationConfig.responseSchema.properties.captionStyle.enum).toEqual([
      ...CAPTION_STYLES,
    ])
    expect(req.generationConfig.responseSchema.properties.audioType.enum).toEqual([...AUDIO_TYPES])
    expect(req.generationConfig.responseSchema).toEqual(VISION_SCHEMA)

    // Files API path: the video is referenced by URI, and the ASR hook is context.
    const parts = req.contents[0].parts
    expect(parts[0].fileData.fileUri).toContain('/files/abc123')
    expect(parts[1].text).toContain('wait for it')
  })

  it('maps the response to a valid VisionAnalysis with enum coercion', async () => {
    const { fetchImpl } = makeFetch()
    const p = new GeminiVisionProvider({ apiKey: 'test-key', fetchImpl })

    const out = await p.analyse(makeBundle(1, bigVideo), transcript)

    // In-enum values pass through; out-of-enum coerces to 'unknown'.
    expect(HOOK_TYPES).toContain(out.hookType)
    expect(out.hookType).toBe('question')
    expect(out.audioType).toBe('trending_sound')
    expect(out.captionStyle).toBe('unknown') // 'WEIRD_STYLE_NOT_IN_ENUM' coerced

    // Numeric coercion.
    expect(out.faceScreenFraction).toBe(1) // clamped from 1.5
    expect(out.cutCountFirst3s).toBe(3) // rounded from 2.7
    expect(out.facePresent).toBe(true)

    expect(out.hookTextSequence).toHaveLength(2)
    expect(out.hookTextSequence[0]).toEqual({ tSeconds: 0, text: 'POV:' })
    expect(out.spokenHook).toBe('wait for it')
    expect(out.formatSummary).toContain('talking head')

    expect(out.modelVersion).toBe('gemini-2.5-flash-002')
    expect(out.costUsd).toBeGreaterThan(0)
  })

  it('bills audio on the audio line, not the text/video line', async () => {
    const { fetchImpl } = makeFetch()
    const p = new GeminiVisionProvider({ apiKey: 'test-key', fetchImpl })
    const out = await p.analyse(makeBundle(1, bigVideo), transcript)

    // Correct: 7740 video @ $0.30/M + 960 audio @ $1.00/M + 200 out @ $2.50/M.
    const separated = (7740 / 1e6) * 0.3 + (960 / 1e6) * 1.0 + (200 / 1e6) * 2.5
    // Wrong (conflated): all 8700 input @ $0.30/M + output.
    const conflated = (8700 / 1e6) * 0.3 + (200 / 1e6) * 2.5

    expect(out.costUsd).toBeCloseTo(separated, 8)
    expect(out.costUsd).toBeGreaterThan(conflated)
  })

  it('uses inline base64 for a tiny clip (no Files upload call)', async () => {
    const { fetchImpl, calls } = makeFetch()
    const p = new GeminiVisionProvider({ apiKey: 'test-key', fetchImpl })

    await p.analyse(makeBundle(2, tinyVideo), null)

    expect(calls.some((c) => c.url.includes('/upload/v1beta/files'))).toBe(false)
    const gen = calls.find((c) => c.url.includes(':generateContent'))!
    const req = JSON.parse(gen.body!)
    expect(req.contents[0].parts[0].inlineData.mimeType).toBe('video/mp4')
    expect(req.contents[0].parts[0].inlineData.data.length).toBeGreaterThan(0)
    // No transcript → prompt says so.
    expect(req.contents[0].parts[1].text).toContain('No ASR hook text')
  })

  it('throws a ProviderError when no API key is configured', async () => {
    const prev = { g: process.env.GEMINI_API_KEY, gg: process.env.GOOGLE_API_KEY }
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    try {
      const { fetchImpl } = makeFetch()
      const p = new GeminiVisionProvider({ fetchImpl })
      await expect(p.analyse(makeBundle(1, bigVideo), null)).rejects.toBeInstanceOf(ProviderError)
    } finally {
      if (prev.g) process.env.GEMINI_API_KEY = prev.g
      if (prev.gg) process.env.GOOGLE_API_KEY = prev.gg
    }
  })
})

// ---------------------------------------------------------------------------
// computeCost() — unit
// ---------------------------------------------------------------------------

describe('computeCost', () => {
  it('separates the audio line from text/video', () => {
    const cost = computeCost(DEFAULT_MODEL, USAGE)
    const expected = (7740 / 1e6) * 0.3 + (960 / 1e6) * 1.0 + (200 / 1e6) * 2.5
    expect(cost).toBeCloseTo(expected, 8)
  })

  it('falls back to duration/frame estimates when no modality breakdown exists', () => {
    // 30 audio-seconds → 960 audio tokens; 30 frames → 7740 video tokens.
    const cost = computeCost(DEFAULT_MODEL, { promptTokenCount: 0, candidatesTokenCount: 0 }, {
      hint: { audioSeconds: 30, videoFrames: 30 },
    })
    const expected = (7740 / 1e6) * 0.3 + (960 / 1e6) * 1.0
    expect(cost).toBeCloseTo(expected, 8)
  })

  it('applies the 50% batch discount', () => {
    const sync = computeCost(DEFAULT_BATCH_MODEL, USAGE)
    const batch = computeCost(DEFAULT_BATCH_MODEL, USAGE, { batch: true })
    expect(batch).toBeCloseTo(sync / 2, 10)
  })
})

// ---------------------------------------------------------------------------
// submitBatch() / fetchBatch()
// ---------------------------------------------------------------------------

describe('GeminiVisionProvider.submitBatch', () => {
  it('creates a pending job with expiresAt = submitted + 48h', async () => {
    const { fetchImpl, calls } = makeFetch({ batchName: 'batches/corpus-42' })
    const p = new GeminiVisionProvider({ apiKey: 'test-key', fetchImpl })

    const ids = [10, 11]
    const bundles = [makeBundle(10, bigVideo), makeBundle(11, bigVideo)]
    const job = await p.submitBatch(ids, bundles)

    expect(job.id).toBe('batches/corpus-42')
    expect(job.status).toBe('pending')
    expect(job.model).toBe(DEFAULT_BATCH_MODEL)
    expect(job.videoIds).toEqual(ids)
    // The 48h re-submit deadline the vision_batch_job table depends on.
    expect(job.expiresAt.getTime() - job.submittedAt.getTime()).toBe(BATCH_EXPIRY_MS)

    // Batch create hit the batch endpoint with per-video keys.
    const create = calls.find((c) => c.url.includes(':batchGenerateContent'))!
    expect(create.url).toContain(`/models/${DEFAULT_BATCH_MODEL}:batchGenerateContent`)
    const reqs = JSON.parse(create.body!).batch.inputConfig.requests.requests
    expect(reqs.map((r: { key: string }) => r.key)).toEqual(['video-10', 'video-11'])
  })

  it('throws when a videoId has no matching bundle', async () => {
    const { fetchImpl } = makeFetch()
    const p = new GeminiVisionProvider({ apiKey: 'test-key', fetchImpl })
    await expect(p.submitBatch([99], [makeBundle(1, bigVideo)])).rejects.toBeInstanceOf(
      ProviderError
    )
  })
})

describe('GeminiVisionProvider.fetchBatch', () => {
  it('returns pending while the operation is not done', async () => {
    const { fetchImpl } = makeFetch({ operation: { done: false } })
    const p = new GeminiVisionProvider({ apiKey: 'test-key', fetchImpl })
    const res: VisionBatchFetch = await p.fetchBatch('batches/job-1')
    expect(res.status).toBe('pending')
    expect(res.results).toHaveLength(0)
  })

  it('parses completed results back to their videoIds and bills at batch rate', async () => {
    const operation = {
      done: true,
      response: {
        inlinedResponses: {
          inlinedResponses: [
            {
              key: 'video-10',
              response: {
                candidates: [{ content: { parts: [{ text: JSON.stringify(MODEL_OUTPUT) }] } }],
                usageMetadata: USAGE,
              },
            },
            { key: 'video-11', error: { message: 'quota' } },
          ],
        },
      },
    }
    const { fetchImpl } = makeFetch({ operation })
    const p = new GeminiVisionProvider({ apiKey: 'test-key', fetchImpl })

    const res = await p.fetchBatch('batches/job-1')
    expect(res.status).toBe('succeeded')
    expect(res.results).toHaveLength(2)

    const ok = res.results.find((r) => r.videoId === 10)!
    expect(ok.analysis).not.toBeNull()
    expect(ok.analysis!.hookType).toBe('question')
    // Batch is half the sync cost for the same usage on the same model.
    const syncCost = computeCost(DEFAULT_BATCH_MODEL, USAGE)
    expect(ok.analysis!.costUsd).toBeCloseTo(syncCost / 2, 10)

    const failed = res.results.find((r) => r.videoId === 11)!
    expect(failed.analysis).toBeNull()
    expect(failed.error).toContain('quota')
  })

  it('reports failed when the operation carries an error', async () => {
    const { fetchImpl } = makeFetch({ operation: { done: true, error: { message: 'boom' } } })
    const p = new GeminiVisionProvider({ apiKey: 'test-key', fetchImpl })
    const res = await p.fetchBatch('batches/job-1')
    expect(res.status).toBe('failed')
  })
})
