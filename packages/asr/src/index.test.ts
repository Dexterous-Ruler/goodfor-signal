import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GroqAsrProvider,
  FasterWhisperAsrProvider,
  groqCostUsd,
  GROQ_TRANSCRIPTIONS_URL,
  GROQ_DEFAULT_MODEL,
  GROQ_PRICE_USD_PER_AUDIO_HOUR,
  MIN_BILLED_SECONDS,
} from './index.js'
import { ProviderError } from '@goodfor/contracts'

// A tiny real file so the provider's `readFile` succeeds — the only disk I/O.
// Everything else (network) is mocked. No live keys, no real Groq call.
let audioPath: string

beforeAll(async () => {
  audioPath = join(tmpdir(), `asr-test-${process.pid}-${Date.now()}.wav`)
  await writeFile(audioPath, Buffer.from('RIFF....WAVEfake-pcm-bytes'))
})

afterAll(async () => {
  await unlink(audioPath).catch(() => {})
})

/**
 * A 30 s clip. "changes"/"everything" start at/after t=3.0 s and must fall
 * OUTSIDE the hook window; the five words before 3.0 s are the hook.
 */
const CANNED_VERBOSE_JSON = {
  task: 'transcribe',
  language: 'english',
  duration: 30,
  text: 'Wait before you scroll this changes everything about your morning',
  words: [
    { word: 'Wait', start: 0.0, end: 0.4 },
    { word: 'before', start: 0.4, end: 0.8 },
    { word: 'you', start: 0.8, end: 1.0 },
    { word: 'scroll', start: 1.0, end: 1.5 },
    { word: 'this', start: 2.6, end: 2.95 },
    { word: 'changes', start: 3.0, end: 3.4 }, // exactly 3.0 → excluded
    { word: 'everything', start: 3.4, end: 4.0 },
  ],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status })
}

/** Captures the last request so we can assert on the multipart form. */
function makeFetch(response: () => Response) {
  const calls: { url: unknown; init: RequestInit }[] = []
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} })
    return response()
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

describe('GroqAsrProvider — request shape', () => {
  it('POSTs multipart to the Groq URL with the turbo model + verbose_json + word timestamps', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(CANNED_VERBOSE_JSON))
    const provider = new GroqAsrProvider({ apiKey: 'test-key', fetchImpl })

    await provider.transcribe(audioPath)

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe(GROQ_TRANSCRIPTIONS_URL)
    expect(init.method).toBe('POST')

    // Authorization uses the injected key.
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-key')

    // The body is a FormData carrying the turbo model + verbose_json + words.
    const form = init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe(GROQ_DEFAULT_MODEL)
    expect(form.get('model')).toBe('whisper-large-v3-turbo')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.getAll('timestamp_granularities[]')).toContain('word')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })
})

describe('GroqAsrProvider — parsing', () => {
  it('splits hookText at t=3.0s (only words that START before 3.0s)', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(CANNED_VERBOSE_JSON))
    const provider = new GroqAsrProvider({ apiKey: 'k', fetchImpl })

    const t = await provider.transcribe(audioPath)

    expect(t.hookText).toBe('Wait before you scroll this')
    // Words at/after 3.0s are excluded from the hook.
    expect(t.hookText).not.toContain('changes')
    expect(t.hookText).not.toContain('everything')
    // Full transcript + language survive verbatim.
    expect(t.text).toBe(CANNED_VERBOSE_JSON.text)
    expect(t.language).toBe('english')
    expect(t.words).toHaveLength(7)
  })

  it('reads words nested under segments when top-level words are absent', async () => {
    const nested = {
      language: 'english',
      duration: 12,
      text: 'hidden in segments',
      segments: [{ words: [{ word: 'hidden', start: 0.2, end: 0.6 }] }],
    }
    const { fetchImpl } = makeFetch(() => jsonResponse(nested))
    const provider = new GroqAsrProvider({ apiKey: 'k', fetchImpl })

    const t = await provider.transcribe(audioPath)
    expect(t.words).toHaveLength(1)
    expect(t.hookText).toBe('hidden')
  })
})

describe('GroqAsrProvider — cost with the 10s billing floor', () => {
  it('bills a 30s clip at the actual duration', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(CANNED_VERBOSE_JSON))
    const provider = new GroqAsrProvider({ apiKey: 'k', fetchImpl })

    const t = await provider.transcribe(audioPath)
    expect(t.costUsd).toBeCloseTo((30 / 3600) * GROQ_PRICE_USD_PER_AUDIO_HOUR, 10)
  })

  it('applies the 10s floor to a 3s hook clip (never bills below 10s)', async () => {
    const shortClip = { ...CANNED_VERBOSE_JSON, duration: 3 }
    const { fetchImpl } = makeFetch(() => jsonResponse(shortClip))
    const provider = new GroqAsrProvider({ apiKey: 'k', fetchImpl })

    const t = await provider.transcribe(audioPath)
    expect(t.costUsd).toBeCloseTo((MIN_BILLED_SECONDS / 3600) * GROQ_PRICE_USD_PER_AUDIO_HOUR, 10)
    // The floor must be strictly above the un-floored 3s price.
    expect(t.costUsd).toBeGreaterThan((3 / 3600) * GROQ_PRICE_USD_PER_AUDIO_HOUR)
  })

  it('groqCostUsd exposes the floor directly', () => {
    expect(groqCostUsd(3)).toBe(groqCostUsd(10))
    expect(groqCostUsd(30)).toBeCloseTo(0.04 * (30 / 3600), 10)
    // falls back to the floor for a zero-length payload
    expect(groqCostUsd(0)).toBe((10 / 3600) * 0.04)
  })
})

describe('GroqAsrProvider — errors', () => {
  it('throws a non-retryable ProviderError when the key is missing', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(CANNED_VERBOSE_JSON))
    // Empty string is falsy → treated as missing, independent of the real env.
    const provider = new GroqAsrProvider({ apiKey: '', fetchImpl })

    await expect(provider.transcribe(audioPath)).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'groq',
      retryable: false,
    })
    expect(calls).toHaveLength(0) // never hits the network without a key
  })

  it('marks 429 as retryable', async () => {
    const { fetchImpl } = makeFetch(() => textResponse('rate limited', 429))
    const provider = new GroqAsrProvider({ apiKey: 'k', fetchImpl })

    const err = await provider.transcribe(audioPath).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.retryable).toBe(true)
  })

  it('marks a 400 as non-retryable', async () => {
    const { fetchImpl } = makeFetch(() => textResponse('bad file', 400))
    const provider = new GroqAsrProvider({ apiKey: 'k', fetchImpl })

    const err = await provider.transcribe(audioPath).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.retryable).toBe(false)
  })
})

describe('FasterWhisperAsrProvider — breaker', () => {
  it('POSTs to the local baseUrl and reports zero cost', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(CANNED_VERBOSE_JSON))
    const provider = new FasterWhisperAsrProvider({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl,
    })

    const t = await provider.transcribe(audioPath)

    expect(provider.name).toBe('faster-whisper')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://127.0.0.1:9999/v1/audio/transcriptions')
    // Same interface, same parsing — but no billing.
    expect(t.costUsd).toBe(0)
    expect(t.hookText).toBe('Wait before you scroll this')
    // No Authorization header on the local breaker.
    const headers = (calls[0]!.init.headers as Record<string, string>) ?? {}
    expect(headers.authorization).toBeUndefined()
  })

  it('defaults to 127.0.0.1:8000', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(CANNED_VERBOSE_JSON))
    const provider = new FasterWhisperAsrProvider({ fetchImpl })
    await provider.transcribe(audioPath)
    expect(calls[0]!.url).toBe('http://127.0.0.1:8000/v1/audio/transcriptions')
  })
})
