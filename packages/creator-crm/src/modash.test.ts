import { describe, it, expect } from 'vitest'
import {
  ModashClient,
  createModashClient,
  Modash404Error,
  MODASH_SOURCE_VENDOR,
  type ModashSearchHitRaw,
} from './modash.js'

interface RecordedCall {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

/** A fake fetch returning a fixed response, recording each call. */
function fakeFetch(payload: unknown, opts: { status?: number } = {}) {
  const calls: RecordedCall[] = []
  const status = opts.status ?? 200
  const fetchImpl = (async (input: any, init: any) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : undefined,
    })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}

/** A fake fetch driven by a queue of statuses (for retry tests). */
function sequencedFetch(steps: { status: number; payload?: unknown }[]) {
  const calls: RecordedCall[] = []
  let i = 0
  const fetchImpl = (async (input: any, init: any) => {
    calls.push({ url: String(input), method: init?.method })
    const step = steps[Math.min(i, steps.length - 1)]!
    i++
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.payload ?? {},
    } as unknown as Response
  }) as typeof fetch
  return { fetchImpl, calls, callCount: () => i }
}

const cfg = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => ({
  apiKey: 'modash_test_key',
  fetchImpl,
  env: {} as Record<string, string | undefined>,
  now: () => new Date('2026-08-16T12:00:00Z'),
  ...extra,
})

const hit = (over: Partial<ModashSearchHitRaw> = {}): ModashSearchHitRaw => ({
  userId: 'tt_12345',
  username: 'creator_one',
  url: 'https://tiktok.com/@creator_one',
  followers: 50_000,
  engagementRate: 0.07,
  avgViews: 20_000,
  isVerified: false,
  credibility: 88.5,
  ...over,
})

describe('ModashClient.search — captures credibility at search time (§9.1)', () => {
  it('returns credibility from the search response and stamps provenance', async () => {
    const { fetchImpl, calls } = fakeFetch({ results: [hit(), hit({ userId: 'tt_2', credibility: 40 })] })
    const client = new ModashClient(cfg(fetchImpl))

    const { creators, creditsConsumed } = await client.search({ platform: 'tiktok', limit: 100 })

    expect(creators).toHaveLength(2)
    // Credibility preserved from the search hit — the whole point (§9.1).
    expect(creators[0]!.credibility).toBe(88.5)
    expect(creators[1]!.credibility).toBe(40)
    // Keyed on platform_user_id, never username (§9.5).
    expect(creators[0]!.platformUserId).toBe('tt_12345')
    // Provenance stamped on every enriched row.
    expect(creators[0]!.sourceVendor).toBe(MODASH_SOURCE_VENDOR)
    expect(creators[0]!.vendorLastSyncedAt).toBe('2026-08-16T12:00:00.000Z')
    // Credits ≈ 0.01 per result.
    expect(creditsConsumed).toBeCloseTo(0.02, 6)

    const call = calls[0]!
    expect(call.url).toMatch(/\/tiktok\/search$/)
    expect(call.method).toBe('POST')
    expect((call.headers as any).authorization).toBe('Bearer modash_test_key')
  })

  it('keeps credibility null when the hit omits it (nullable, still captured)', async () => {
    const { fetchImpl } = fakeFetch({ results: [hit({ credibility: undefined })] })
    const client = new ModashClient(cfg(fetchImpl))
    const { creators } = await client.search({})
    expect(creators[0]!.credibility).toBeNull()
  })
})

describe('ModashClient — the 404-consumes-quota trap (§9.1)', () => {
  it('throws Modash404Error and does NOT retry a 404', async () => {
    const { fetchImpl, calls } = fakeFetch({}, { status: 404 })
    const client = new ModashClient(cfg(fetchImpl, { maxRetries: 3 }))

    await expect(client.report('tt_missing')).rejects.toBeInstanceOf(Modash404Error)
    // A 404 consumed a credit — it must be a single, non-retried request.
    expect(calls).toHaveLength(1)
  })

  it('marks the error consumedQuota so the caller debits its budget', async () => {
    const { fetchImpl } = fakeFetch({}, { status: 404 })
    const client = new ModashClient(cfg(fetchImpl))
    try {
      await client.audience('tt_missing')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Modash404Error)
      expect((err as Modash404Error).consumedQuota).toBe(true)
      expect((err as Modash404Error).status).toBe(404)
    }
  })

  it('DOES retry a transient 5xx (only 404 is the trap)', async () => {
    const { fetchImpl, calls } = sequencedFetch([
      { status: 500 },
      { status: 200, payload: { profile: { followers: 10 } } },
    ])
    const client = new ModashClient(cfg(fetchImpl, { maxRetries: 2 }))
    const report = await client.report('tt_ok')
    expect(report.followers).toBe(10)
    expect(calls.length).toBe(2) // one retry after the 500
  })
})

describe('ModashClient — secret handling', () => {
  it('throws a clear error at call time when the API key is missing', async () => {
    const { fetchImpl } = fakeFetch({ results: [] })
    const client = createModashClient({ fetchImpl, env: {} })
    await expect(client.search({})).rejects.toThrow(/MODASH_API_KEY/)
  })
})
