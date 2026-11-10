import { describe, it, expect } from 'vitest'
import {
  HypeAuditorClient,
  HYPEAUDITOR_API_VERSION,
  HYPEAUDITOR_MIN_INTERVAL_MS,
  HYPEAUDITOR_SOURCE_VENDOR,
} from './hypeauditor.js'

interface RecordedCall {
  url: string
  headers?: Record<string, string>
}

function fakeFetch(payload: unknown, opts: { status?: number } = {}) {
  const calls: RecordedCall[] = []
  const status = opts.status ?? 200
  const fetchImpl = (async (input: any, init: any) => {
    calls.push({ url: String(input), headers: init?.headers })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}

const AQS_PAYLOAD = {
  result: { features: { aqs: { data: { value: 72.5 } }, audience_reachability: { value: 55 } } },
}

/** A controllable clock: sleep advances it, so the throttle is deterministic. */
function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps,
    advance: (ms: number) => {
      t += ms
    },
  }
}

const cfg = (fetchImpl: typeof fetch, clock: ReturnType<typeof fakeClock>, extra: Record<string, unknown> = {}) => ({
  apiToken: 'ha_test_token',
  fetchImpl,
  env: {} as Record<string, string | undefined>,
  now: clock.now,
  sleep: clock.sleep,
  ...extra,
})

describe('HypeAuditorClient — pins the API version explicitly (§9.1)', () => {
  it('always sends v=2019-10-18', async () => {
    const { fetchImpl, calls } = fakeFetch(AQS_PAYLOAD)
    const clock = fakeClock()
    const client = new HypeAuditorClient(cfg(fetchImpl, clock))
    await client.getAudienceQualityScore('creator_one')
    expect(calls[0]!.url).toContain(`v=${HYPEAUDITOR_API_VERSION}`)
    expect(calls[0]!.url).toContain('2019-10-18')
  })

  it('is sandbox-first (uses searchSandbox by default)', async () => {
    const { fetchImpl, calls } = fakeFetch(AQS_PAYLOAD)
    const clock = fakeClock()
    const client = new HypeAuditorClient(cfg(fetchImpl, clock))
    await client.getAudienceQualityScore('creator_one')
    expect(calls[0]!.url).toContain('auditor.searchSandbox')
  })

  it('uses the live method only when sandbox is explicitly disabled', async () => {
    const { fetchImpl, calls } = fakeFetch(AQS_PAYLOAD)
    const clock = fakeClock()
    const client = new HypeAuditorClient(cfg(fetchImpl, clock, { sandbox: false }))
    await client.getAudienceQualityScore('creator_one')
    expect(calls[0]!.url).toContain('auditor.search')
    expect(calls[0]!.url).not.toContain('searchSandbox')
  })

  it('pulls the Audience Quality Score and stamps provenance', async () => {
    const { fetchImpl } = fakeFetch(AQS_PAYLOAD)
    const clock = fakeClock()
    const client = new HypeAuditorClient(cfg(fetchImpl, clock))
    const res = await client.getAudienceQualityScore('creator_one')
    expect(res.audienceQualityScore).toBe(72.5)
    expect(res.audienceReachability).toBe(55)
    expect(res.sourceVendor).toBe(HYPEAUDITOR_SOURCE_VENDOR)
  })
})

describe('HypeAuditorClient — throttles to 100 req/min (§9.1)', () => {
  it('spaces rapid requests by the min interval (600ms) via the injected sleep', async () => {
    const { fetchImpl } = fakeFetch(AQS_PAYLOAD)
    const clock = fakeClock()
    const client = new HypeAuditorClient(cfg(fetchImpl, clock))

    // Three back-to-back calls with a clock that only advances when we sleep.
    await client.getAudienceQualityScore('a')
    await client.getAudienceQualityScore('b')
    await client.getAudienceQualityScore('c')

    // First call: no wait. Next two each wait one min-interval.
    expect(clock.sleeps).toEqual([HYPEAUDITOR_MIN_INTERVAL_MS, HYPEAUDITOR_MIN_INTERVAL_MS])
    expect(HYPEAUDITOR_MIN_INTERVAL_MS).toBe(600)
  })

  it('does not sleep when enough time has already elapsed', async () => {
    const { fetchImpl } = fakeFetch(AQS_PAYLOAD)
    const clock = fakeClock()
    const client = new HypeAuditorClient(cfg(fetchImpl, clock))
    await client.getAudienceQualityScore('a')
    clock.advance(1000) // more than one interval passes on its own
    await client.getAudienceQualityScore('b')
    expect(clock.sleeps).toEqual([]) // no throttle wait needed
  })
})

describe('HypeAuditorClient — secret handling', () => {
  it('throws a clear error at call time when the token is missing', async () => {
    const { fetchImpl } = fakeFetch(AQS_PAYLOAD)
    const clock = fakeClock()
    const client = new HypeAuditorClient({ fetchImpl, env: {}, now: clock.now, sleep: clock.sleep })
    await expect(client.getAudienceQualityScore('a')).rejects.toThrow(/HYPEAUDITOR_API_TOKEN/)
  })
})
