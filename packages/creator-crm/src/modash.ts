/**
 * Modash Discovery API client (PHASE-5-scale-creators.md §9.1).
 *
 * Injectable, fetch-based, no SDK. `fetchImpl` defaults to global fetch (Node 20);
 * the API key is read from env with an override and the client throws a clear
 * Error at call time if it is missing.
 *
 * TWO HARD GUARDRAILS enforced at this boundary:
 *
 *  1. CAPTURE `credibility` AT SEARCH TIME (§9.1). The TikTok Modash *report*
 *     returns NO `credibility` field — credibility is a QUERY-TIME-ONLY signal.
 *     `search()` returns it on every creator so the caller persists it IMMEDIATELY
 *     into `creator_audience.credibility_score`. Re-fetching the report later will
 *     never return it — this is a schema decision with no second chance.
 *
 *  2. THE 404-CONSUMES-QUOTA TRAP (§9.1). "A 404 is treated as a successful
 *     request that consumes quota." A crawler that retries 404s burns the
 *     allowance. `request()` NEVER retries a 404 — it throws `Modash404Error`
 *     (which carries `consumedQuota: true`) immediately. Only network errors and
 *     5xx are retried.
 *
 * Every enriched row is stamped with `sourceVendor` + `vendorLastSyncedAt` so
 * Modash on-demand freshness is never confused with a stale bi-weekly vendor row.
 *
 * // UNVERIFIED — Modash request/response shapes are written from the docs, not
 * validated against a live account. Every wire shape below is UNVERIFIED.
 */

export type FetchImpl = typeof fetch

/** Provenance stamp written onto every Modash-enriched row. */
export const MODASH_SOURCE_VENDOR = 'modash'

/** Credit cost per unit of work (§9.1). Informational — for the caller's budget log. */
export const MODASH_CREDITS = {
  perSearchResult: 0.01,
  perReport: 1,
  perAudienceReport: 1,
  perPerformance: 0.25,
} as const

// // UNVERIFIED base URL.
const DEFAULT_BASE_URL = 'https://api.modash.io/v1'

export interface ModashConfig {
  /** Modash API key. Falls back to `MODASH_API_KEY`. */
  apiKey?: string
  /** API base. Falls back to `MODASH_BASE_URL` then the documented default. */
  baseUrl?: string
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchImpl
  env?: Record<string, string | undefined>
  /** Injected clock; defaults to `() => new Date()`. Stamps vendorLastSyncedAt. */
  now?: () => Date
  /** Retries for transient (network / 5xx) failures. A 404 is NEVER retried. */
  maxRetries?: number
}

/**
 * Thrown on a Modash 404. A 404 STILL CONSUMED A CREDIT (§9.1 trap), so the
 * caller must treat it as a spent request and MUST NOT retry it.
 */
export class Modash404Error extends Error {
  readonly status = 404
  /** A 404 consumed quota — see the §9.1 trap. Never retry. */
  readonly consumedQuota = true
  constructor(path: string) {
    super(`Modash ${path} returned 404 — this consumed a credit and must NOT be retried (§9.1 quota trap)`)
    this.name = 'Modash404Error'
  }
}

export type ModashPlatform = 'tiktok' | 'instagram' | 'youtube'

export interface ModashSearchParams {
  platform?: ModashPlatform
  /** Opaque Modash filter object (follower band, geo, topics…). // UNVERIFIED. */
  filter?: Record<string, unknown>
  limit?: number
}

/** Raw search hit as it comes off the wire. // UNVERIFIED shape. */
export interface ModashSearchHitRaw {
  /** platform_user_id — KEY ON THIS, never username (§9.5). */
  userId: string
  username?: string
  url?: string
  followers?: number
  /** er_views convention. */
  engagementRate?: number
  avgViews?: number
  isVerified?: boolean
  /** QUERY-TIME-ONLY credibility — capture NOW, never returned on re-fetch. */
  credibility?: number
}

/** A normalized creator from a Discovery search, ready to persist. */
export interface ModashCreator {
  /** platform_user_id — the dedupe key (§9.5). */
  platformUserId: string
  username: string | null
  url: string | null
  followers: number | null
  engagementRate: number | null
  avgViews: number | null
  isVerified: boolean | null
  /**
   * Modash credibility captured at SEARCH time. Persist to
   * `creator_audience.credibility_score` immediately — a report re-fetch never
   * returns it (§9.1).
   */
  credibility: number | null
  /** Provenance: always 'modash'. */
  sourceVendor: string
  /** ISO timestamp this row was synced. */
  vendorLastSyncedAt: string
}

export interface ModashSearchResponse {
  creators: ModashCreator[]
  /** Rough credits consumed = perSearchResult × results (§9.1). Informational. */
  creditsConsumed: number
}

/** TikTok report — NOTE: returns NO credibility, NO brand-affinity (§9.1). // UNVERIFIED. */
export interface ModashReport {
  platformUserId: string
  followers: number | null
  avgViews: number | null
  engagementRate: number | null
  sourceVendor: string
  vendorLastSyncedAt: string
}

/** Audience report — demographic splits + reachability. NO credibility here either. // UNVERIFIED. */
export interface ModashAudience {
  platformUserId: string
  genderSplit: unknown | null
  ageSplit: unknown | null
  geoCountries: unknown | null
  languages: unknown | null
  interests: unknown | null
  reachability: number | null
  sourceVendor: string
  vendorLastSyncedAt: string
}

export class ModashClient {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchImpl
  private readonly cfg: ModashConfig
  private readonly env: Record<string, string | undefined>
  private readonly now: () => Date
  private readonly maxRetries: number

  constructor(cfg: ModashConfig = {}) {
    this.cfg = cfg
    this.env = cfg.env ?? process.env
    this.baseUrl = (cfg.baseUrl ?? this.env.MODASH_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = cfg.fetchImpl ?? fetch
    this.now = cfg.now ?? (() => new Date())
    this.maxRetries = cfg.maxRetries ?? 2
  }

  private apiKey(): string {
    const key = this.cfg.apiKey ?? this.env.MODASH_API_KEY
    if (!key || key.trim() === '') {
      throw new Error('MODASH_API_KEY is not set — inject apiKey or set the env var before calling Modash')
    }
    return key
  }

  /**
   * Single request with a bounded retry policy. NEVER retries a 404 (it consumed
   * quota — §9.1 trap); retries only network errors and 5xx up to `maxRetries`.
   */
  private async request(path: string, init: RequestInit): Promise<unknown> {
    const url = `${this.baseUrl}${path}`
    const headers = {
      authorization: `Bearer ${this.apiKey()}`,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    }
    let attempt = 0
    for (;;) {
      let res: Response
      try {
        res = await this.fetchImpl(url, { ...init, headers })
      } catch (err) {
        if (attempt < this.maxRetries) {
          attempt++
          continue
        }
        throw err
      }
      // The quota trap: a 404 is a consumed request — throw, do NOT retry.
      if (res.status === 404) throw new Modash404Error(path)
      if (!res.ok) {
        if (res.status >= 500 && attempt < this.maxRetries) {
          attempt++
          continue
        }
        throw new Error(`Modash ${path} failed: HTTP ${res.status}`)
      }
      return res.json()
    }
  }

  /**
   * Discovery search. Returns creators with `credibility` captured at query time
   * — the caller MUST persist it immediately (§9.1). Keys every result on
   * `platformUserId` (never username). // UNVERIFIED request/response shape.
   */
  async search(params: ModashSearchParams): Promise<ModashSearchResponse> {
    const platform = params.platform ?? 'tiktok'
    const json = (await this.request(`/${platform}/search`, {
      method: 'POST',
      body: JSON.stringify({ filter: params.filter ?? {}, limit: params.limit ?? 100 }),
    })) as { results?: ModashSearchHitRaw[]; total?: number }

    const syncedAt = this.now().toISOString()
    const hits = json.results ?? []
    const creators: ModashCreator[] = hits.map((h) => ({
      platformUserId: h.userId,
      username: h.username ?? null,
      url: h.url ?? null,
      followers: h.followers ?? null,
      engagementRate: h.engagementRate ?? null,
      avgViews: h.avgViews ?? null,
      isVerified: h.isVerified ?? null,
      // Captured at SEARCH time — never re-fetchable (§9.1).
      credibility: h.credibility ?? null,
      sourceVendor: MODASH_SOURCE_VENDOR,
      vendorLastSyncedAt: syncedAt,
    }))

    return { creators, creditsConsumed: creators.length * MODASH_CREDITS.perSearchResult }
  }

  /**
   * Influencer report. Does NOT return credibility (§9.1) — that is why search()
   * captures it. // UNVERIFIED request/response shape.
   */
  async report(platformUserId: string): Promise<ModashReport> {
    const json = (await this.request(`/tiktok/report/${encodeURIComponent(platformUserId)}`, {
      method: 'GET',
    })) as { profile?: { followers?: number; avgViews?: number; engagementRate?: number } }
    const p = json.profile ?? {}
    return {
      platformUserId,
      followers: p.followers ?? null,
      avgViews: p.avgViews ?? null,
      engagementRate: p.engagementRate ?? null,
      sourceVendor: MODASH_SOURCE_VENDOR,
      vendorLastSyncedAt: this.now().toISOString(),
    }
  }

  /**
   * Audience report. Demographic splits + reachability; NO credibility.
   * // UNVERIFIED request/response shape.
   */
  async audience(platformUserId: string): Promise<ModashAudience> {
    const json = (await this.request(`/tiktok/audience/${encodeURIComponent(platformUserId)}`, {
      method: 'GET',
    })) as {
      gender?: unknown
      ages?: unknown
      geoCountries?: unknown
      languages?: unknown
      interests?: unknown
      audienceReachability?: number
    }
    return {
      platformUserId,
      genderSplit: json.gender ?? null,
      ageSplit: json.ages ?? null,
      geoCountries: json.geoCountries ?? null,
      languages: json.languages ?? null,
      interests: json.interests ?? null,
      reachability: json.audienceReachability ?? null,
      sourceVendor: MODASH_SOURCE_VENDOR,
      vendorLastSyncedAt: this.now().toISOString(),
    }
  }
}

/** Construct a Modash client from config/env. */
export function createModashClient(cfg: ModashConfig = {}): ModashClient {
  return new ModashClient(cfg)
}
