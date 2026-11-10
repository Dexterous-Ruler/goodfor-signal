import { describe, it, expect } from 'vitest'
import {
  KochavaClient,
  createKochavaClient,
  checkFreeTierCeiling,
  KOCHAVA_FREE_TIER_CEILING,
  type OwnedMediaConversion,
} from './mmp.js'

interface RecordedCall {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

/** A fake fetch that records the request and returns a fixed JSON payload. */
function fakeFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: RecordedCall[] = []
  const fetchImpl = (async (input: any, init: any) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : undefined,
    })
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => payload,
    } as unknown as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}

const cfg = (fetchImpl: typeof fetch) => ({
  apiKey: 'kc_test_key',
  appGuid: 'koguid123',
  fetchImpl,
  env: {} as Record<string, string | undefined>,
})

describe('checkFreeTierCeiling (billing trap)', () => {
  it('does not alarm well under the ceiling', () => {
    const a = checkFreeTierCeiling(1000)
    expect(a.alarm).toBe(false)
    expect(a.ceiling).toBe(KOCHAVA_FREE_TIER_CEILING)
  })
  it('alarms at ≥80% of the 10K free-tier ceiling', () => {
    expect(checkFreeTierCeiling(8000).alarm).toBe(true)
    expect(checkFreeTierCeiling(7999).alarm).toBe(false)
    expect(checkFreeTierCeiling(8000).message).toMatch(/free tier/)
  })
})

describe('KochavaClient.createSmartLink', () => {
  it('POSTs an owned-media SmartLink with the right shape', async () => {
    const { fetchImpl, calls } = fakeFetch({ smartlink_url: 'https://ko.link/abc', tracker_id: 't_1' })
    const client = new KochavaClient(cfg(fetchImpl))

    const res = await client.createSmartLink({
      campaignName: 'goodfor_app-bio',
      androidUrl: 'https://play.google.com/store/apps/details?id=com.goodfor&referrer=utm_content%3D123',
      iosUrl: 'https://apps.apple.com/app/id123?pt=1&ct=f0',
      utmContent: '7412345678901234567',
    })

    expect(res).toEqual({ smartLinkUrl: 'https://ko.link/abc', trackerId: 't_1' })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toMatch(/\/smartlink$/)
    expect(call.method).toBe('POST')
    expect((call.headers as any).authorization).toBe('Bearer kc_test_key')
    expect(call.body).toMatchObject({
      app_guid: 'koguid123',
      tracker_name: 'goodfor_app-bio',
      media_type: 'owned', // NEVER paid — billing trap
      utm_content: '7412345678901234567',
    })
  })
})

describe('KochavaClient.pullOwnedMediaConversions', () => {
  const owned = (id: string, mediaType = 'owned'): OwnedMediaConversion => ({
    conversionId: id,
    campaignName: 'bio',
    utmContent: '123',
    platform: 'android',
    occurredAt: '2026-08-15T00:00:00Z',
    mediaType,
  })

  it('requests owned media for the range and computes the ceiling alarm', async () => {
    const { fetchImpl, calls } = fakeFetch({ conversions: [owned('a'), owned('b'), owned('c', 'paid')] })
    const client = new KochavaClient(cfg(fetchImpl))

    const { conversions, ceiling } = await client.pullOwnedMediaConversions({
      fromDate: '2026-08-01',
      toDate: '2026-08-15',
    })

    // Paid row is filtered out — never counted as owned media.
    expect(conversions.map((c) => c.conversionId)).toEqual(['a', 'b'])
    expect(ceiling.conversions).toBe(2)
    expect(ceiling.alarm).toBe(false)

    const call = calls[0]!
    expect(call.url).toContain('media_type=owned')
    expect(call.url).toContain('from=2026-08-01')
    expect(call.url).toContain('to=2026-08-15')
    expect((call.headers as any).authorization).toBe('Bearer kc_test_key')
  })
})

describe('secret handling', () => {
  it('throws a clear error at call time when the API key is missing', async () => {
    const { fetchImpl } = fakeFetch({})
    const client = createKochavaClient({ appGuid: 'g', fetchImpl, env: {} })
    await expect(
      client.createSmartLink({ campaignName: 'x', androidUrl: 'a', iosUrl: 'b' })
    ).rejects.toThrow(/KOCHAVA_API_KEY/)
  })

  it('reads the API key from the injected env', async () => {
    const { fetchImpl, calls } = fakeFetch({ smartlink_url: 'u', tracker_id: 't' })
    const client = new KochavaClient({
      appGuid: 'g',
      fetchImpl,
      env: { KOCHAVA_API_KEY: 'from_env' },
    })
    await client.createSmartLink({ campaignName: 'x', androidUrl: 'a', iosUrl: 'b' })
    expect((calls[0]!.headers as any).authorization).toBe('Bearer from_env')
  })
})
