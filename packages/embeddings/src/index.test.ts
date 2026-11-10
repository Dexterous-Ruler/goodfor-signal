import { describe, it, expect, vi } from 'vitest'
import { ProviderError } from '@goodfor/contracts'
import {
  OpenAiEmbeddingProvider,
  splitCost,
  COST_PER_MILLION_TOKENS,
  DEFAULT_DIMS,
} from './index.js'

// ---------------------------------------------------------------------------
// Fetch stubbing helpers — no real network, ever.
// ---------------------------------------------------------------------------

interface CannedItem {
  index: number
  embedding: number[]
}

function okResponse(data: CannedItem[], totalTokens: number, model = 'text-embedding-3-small') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data, model, usage: { prompt_tokens: totalTokens, total_tokens: totalTokens } }),
  } as unknown as Response
}

function errResponse(status: number, message = 'boom') {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message } }),
  } as unknown as Response
}

/** A vector of the given width, deterministic contents. */
function vec(width: number, fill = 0.1): number[] {
  return Array.from({ length: width }, (_, i) => fill + i / width)
}

// ---------------------------------------------------------------------------

describe('splitCost', () => {
  it('sums to the request total cost', () => {
    const total = 1000
    const parts = splitCost(['aaaa', 'bb', 'cccccc'], total)
    const expectedTotal = (total / 1e6) * COST_PER_MILLION_TOKENS
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(expectedTotal, 12)
  })

  it('splits proportionally to text length', () => {
    // lengths 2 and 6 → 1:3 split.
    const [a, b] = splitCost(['ab', 'cdefgh'], 800)
    expect(b).toBeCloseTo(a! * 3, 12)
  })

  it('attributes the whole cost to a single-item batch', () => {
    const [only] = splitCost(['whatever'], 500)
    expect(only).toBeCloseTo((500 / 1e6) * COST_PER_MILLION_TOKENS, 12)
  })

  it('never zero-weights an empty string', () => {
    const parts = splitCost(['', 'x'], 100)
    expect(parts.every((c) => c > 0)).toBe(true)
  })
})

describe('OpenAiEmbeddingProvider — contract surface', () => {
  it('exposes name and dims=1536 by default', () => {
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-test' })
    expect(p.name).toBe('openai-embeddings')
    expect(p.dims).toBe(DEFAULT_DIMS)
    expect(p.dims).toBe(1536)
  })
})

describe('OpenAiEmbeddingProvider.embed', () => {
  it('returns 1536-dim vectors in input order with correct cost math', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse(
        [
          { index: 0, embedding: vec(1536, 0.0) },
          { index: 1, embedding: vec(1536, 0.5) },
        ],
        1000
      )
    )
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-test', fetchImpl })

    const out = await p.embed(['alpha', 'gamma']) // equal length → equal cost split

    expect(out).toHaveLength(2)
    expect(out[0]!.dims).toBe(1536)
    expect(out[0]!.vector).toHaveLength(1536)
    expect(out[0]!.model).toBe('text-embedding-3-small')

    // input order preserved: item 0 starts at 0.0, item 1 at 0.5
    expect(out[0]!.vector[0]).toBeCloseTo(0.0, 12)
    expect(out[1]!.vector[0]).toBeCloseTo(0.5, 12)

    // cost = 1000/1e6 * 0.02 = 2e-5, split evenly across two equal-length inputs
    const total = out[0]!.costUsd + out[1]!.costUsd
    expect(total).toBeCloseTo((1000 / 1e6) * 0.02, 12)
    expect(out[0]!.costUsd).toBeCloseTo(out[1]!.costUsd, 12)
    expect(out[0]!.costUsd).toBeCloseTo(1e-5, 12)
  })

  it('realigns out-of-order data by its index field', async () => {
    // API returns index 1 before index 0 — output must still match input order.
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse(
        [
          { index: 1, embedding: vec(4, 99) },
          { index: 0, embedding: vec(4, 11) },
        ],
        10
      )
    )
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-test', fetchImpl })

    const out = await p.embed(['first', 'second'])
    expect(out[0]!.vector[0]).toBeCloseTo(11, 12)
    expect(out[1]!.vector[0]).toBeCloseTo(99, 12)
  })

  it('chunks large arrays and reassembles in order', async () => {
    const fetchImpl = vi
      .fn()
      // first request: inputs 0,1
      .mockResolvedValueOnce(
        okResponse([
          { index: 0, embedding: [1] },
          { index: 1, embedding: [2] },
        ], 4)
      )
      // second request: input 2 (index resets to 0 within the chunk)
      .mockResolvedValueOnce(okResponse([{ index: 0, embedding: [3] }], 2))

    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-test', batchSize: 2, fetchImpl })
    const out = await p.embed(['a', 'b', 'c'])

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out.map((r) => r.vector[0])).toEqual([1, 2, 3])
  })

  it('sends the right endpoint, model, auth header and input body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse([{ index: 0, embedding: vec(1536) }], 5))
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-secret', fetchImpl })
    await p.embed(['hello'])

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe('https://api.openai.com/v1/embeddings')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret')
    const sent = JSON.parse(init.body as string)
    expect(sent.model).toBe('text-embedding-3-small')
    expect(sent.input).toEqual(['hello'])
    // no dimensions param unless explicitly narrowed
    expect(sent.dimensions).toBeUndefined()
  })

  it('sends a dimensions param only when dims is overridden', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse([{ index: 0, embedding: vec(512) }], 5))
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-test', dims: 512, fetchImpl })
    const out = await p.embed(['hello'])

    expect(p.dims).toBe(512)
    const sent = JSON.parse(fetchImpl.mock.calls[0]![1].body as string)
    expect(sent.dimensions).toBe(512)
    expect(out[0]!.dims).toBe(512)
  })

  it('short-circuits on empty input without any network call', async () => {
    const fetchImpl = vi.fn()
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-test', fetchImpl })
    expect(await p.embed([])).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('OpenAiEmbeddingProvider — errors', () => {
  it('throws a ProviderError at call time when the key is missing', async () => {
    const prev = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const fetchImpl = vi.fn()
      const p = new OpenAiEmbeddingProvider({ fetchImpl })
      await expect(p.embed(['x'])).rejects.toBeInstanceOf(ProviderError)
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev
    }
  })

  it('marks 429 and 5xx as retryable, 4xx as not', async () => {
    const make = (status: number) =>
      new OpenAiEmbeddingProvider({
        apiKey: 'sk-test',
        fetchImpl: vi.fn().mockResolvedValue(errResponse(status)),
      })

    await make(429)
      .embed(['x'])
      .catch((e: ProviderError) => {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.retryable).toBe(true)
        expect(e.costIncurredUsd).toBe(0)
      })
    await make(500)
      .embed(['x'])
      .catch((e: ProviderError) => expect(e.retryable).toBe(true))
    await make(400)
      .embed(['x'])
      .catch((e: ProviderError) => expect(e.retryable).toBe(false))

    expect.assertions(5)
  })

  it('wraps a network-layer throw as a retryable ProviderError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-test', fetchImpl })
    await expect(p.embed(['x'])).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
    })
  })

  it('rejects a response whose item count does not match the batch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([{ index: 0, embedding: [1] }], 5))
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-test', fetchImpl })
    await expect(p.embed(['a', 'b'])).rejects.toBeInstanceOf(ProviderError)
  })
})
