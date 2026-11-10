/**
 * HypeAuditor client (PHASE-5-scale-creators.md §9.1).
 *
 * Second opinion for the AUDIENCE QUALITY SCORE (AQS) that Modash's TikTok report
 * lacks. Three hard requirements, all enforced here:
 *
 *  1. SANDBOX-FIRST. Build against the free sandbox (`auditor.searchSandbox`).
 *     `sandbox` defaults to true; you must opt into live.
 *  2. PIN `v=2019-10-18` EXPLICITLY. Omitting the version defaults to LATEST,
 *     which can change response shapes under you. The version is always sent.
 *  3. THROTTLE to 100 req/min ≈ 1.67 RPS — the only defensible reading of their
 *     limit (§9.1). Enforced by an injectable clock + sleep so tests can prove the
 *     spacing without real delays.
 *
 * AQS publishes NO numeric cutoff (detection is "probabilistic, not perfect"), so
 * this client only PULLS the score — the vetting gate never hard-blocks on it.
 *
 * Injectable, fetch-based, no SDK. // UNVERIFIED — request/response shapes are
 * from the docs, not validated against a live account.
 */

/** Pin explicitly — omitting the version defaults to LATEST (§9.1). */
export const HYPEAUDITOR_API_VERSION = '2019-10-18'

/** 100 req/min ≈ 1.67 RPS (§9.1). */
export const HYPEAUDITOR_RATE_LIMIT_PER_MIN = 100
/** Minimum spacing between requests to honour the limit: 600ms. */
export const HYPEAUDITOR_MIN_INTERVAL_MS = Math.ceil(60_000 / HYPEAUDITOR_RATE_LIMIT_PER_MIN)

/** Provenance stamp written onto every HypeAuditor-enriched row. */
export const HYPEAUDITOR_SOURCE_VENDOR = 'hypeauditor'

// // UNVERIFIED base URL.
const DEFAULT_BASE_URL = 'https://hypeauditor.com/api/method'

type FetchImpl = typeof fetch

export interface HypeAuditorConfig {
  /** API token. Falls back to `HYPEAUDITOR_API_TOKEN`. */
  apiToken?: string
  /** API base. Falls back to `HYPEAUDITOR_BASE_URL` then the documented default. */
  baseUrl?: string
  /** Build against the free sandbox. Defaults to TRUE — opt into live explicitly. */
  sandbox?: boolean
  /** Pinned API version. Defaults to `2019-10-18` — do not omit. */
  apiVersion?: string
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchImpl
  env?: Record<string, string | undefined>
  /** Injected clock (epoch ms). Defaults to `Date.now`. Drives the throttle. */
  now?: () => number
  /** Injected delay. Defaults to real setTimeout. Called by the throttle. */
  sleep?: (ms: number) => Promise<void>
  /** Requests per minute. Defaults to HYPEAUDITOR_RATE_LIMIT_PER_MIN. */
  rateLimitPerMin?: number
}

export interface AudienceQualityResult {
  platformHandle: string
  /** HypeAuditor Audience Quality Score (0–100), or null if absent. */
  audienceQualityScore: number | null
  /** Audience reachability, if returned. */
  audienceReachability: number | null
  sourceVendor: string
  vendorLastSyncedAt: string
}

function realSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class HypeAuditorClient {
  private readonly baseUrl: string
  private readonly sandbox: boolean
  private readonly apiVersion: string
  private readonly fetchImpl: FetchImpl
  private readonly cfg: HypeAuditorConfig
  private readonly env: Record<string, string | undefined>
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly minIntervalMs: number
  /** Earliest epoch-ms at which the next request may be sent. */
  private nextAllowedAt = 0

  constructor(cfg: HypeAuditorConfig = {}) {
    this.cfg = cfg
    this.env = cfg.env ?? process.env
    this.baseUrl = (cfg.baseUrl ?? this.env.HYPEAUDITOR_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.sandbox = cfg.sandbox ?? true
    this.apiVersion = cfg.apiVersion ?? HYPEAUDITOR_API_VERSION
    this.fetchImpl = cfg.fetchImpl ?? fetch
    this.now = cfg.now ?? (() => Date.now())
    this.sleep = cfg.sleep ?? realSleep
    const perMin = cfg.rateLimitPerMin ?? HYPEAUDITOR_RATE_LIMIT_PER_MIN
    this.minIntervalMs = Math.ceil(60_000 / perMin)
  }

  private apiToken(): string {
    const token = this.cfg.apiToken ?? this.env.HYPEAUDITOR_API_TOKEN
    if (!token || token.trim() === '') {
      throw new Error(
        'HYPEAUDITOR_API_TOKEN is not set — inject apiToken or set the env var before calling HypeAuditor'
      )
    }
    return token
  }

  /** Wait, if necessary, to keep requests spaced at ≥ minIntervalMs (100 req/min). */
  private async throttle(): Promise<void> {
    const now = this.now()
    const wait = Math.max(0, this.nextAllowedAt - now)
    if (wait > 0) await this.sleep(wait)
    const sendAt = now + wait
    this.nextAllowedAt = sendAt + this.minIntervalMs
  }

  /** The sandbox method when `sandbox`, else the live method (§9.1). */
  private methodName(): string {
    return this.sandbox ? 'auditor.searchSandbox' : 'auditor.search'
  }

  /**
   * Pull the Audience Quality Score for a TikTok handle. Throttled and
   * version-pinned. // UNVERIFIED request/response shape.
   */
  async getAudienceQualityScore(platformHandle: string): Promise<AudienceQualityResult> {
    await this.throttle()

    const url = new URL(`${this.baseUrl}/${this.methodName()}`)
    // ALWAYS pin the version — omitting it defaults to LATEST (§9.1).
    url.searchParams.set('v', this.apiVersion)
    url.searchParams.set('channel', 'tiktok')
    url.searchParams.set('username', platformHandle)

    const res = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { 'X-Auth-Token': this.apiToken() },
    })
    if (!res.ok) {
      throw new Error(`HypeAuditor ${this.methodName()} failed: HTTP ${res.status}`)
    }
    const json = (await res.json()) as {
      result?: { features?: { aqs?: { data?: { value?: number } }; audience_reachability?: { value?: number } } }
    }
    const features = json.result?.features
    return {
      platformHandle,
      audienceQualityScore: features?.aqs?.data?.value ?? null,
      audienceReachability: features?.audience_reachability?.value ?? null,
      sourceVendor: HYPEAUDITOR_SOURCE_VENDOR,
      vendorLastSyncedAt: new Date(this.now()).toISOString(),
    }
  }
}

/** Construct a HypeAuditor client from config/env (sandbox-first). */
export function createHypeAuditorClient(cfg: HypeAuditorConfig = {}): HypeAuditorClient {
  return new HypeAuditorClient(cfg)
}
