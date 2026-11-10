/**
 * Kochava MMP client (PHASE-4-attribute.md §10.2) — the write plane's ONLY MMP.
 *
 * We use the Kochava FREE TIER: 10K attributed conversions/mo, owned-media
 * attribution + SmartLinks, $0. Tenjin (~$2,200/mo) is deferred to "when volume
 * demands".
 *
 * ⚠️ THE BILLING TRAP (hard guardrail, §10.2). Fronting organic TikTok with a
 * per-video MMP link converts FREE organic traffic into BILLABLE attributed
 * conversions. Two rules are enforced here at the client boundary:
 *   1. Every SmartLink we create is marked owned-media; a paid-UA link must never
 *      be created from this client.
 *   2. `pullOwnedMediaConversions` returns a ceiling alarm alongside the data;
 *      the worker must alert as the count approaches the 10K free-tier ceiling.
 * DO NOT migrate to Tenjin until you have WRITTEN vendor confirmation that
 * owned-media links bill $0 — Tenjin's tooltip defines a conversion as one
 * attributed to a *PAID* UA campaign, which owned media is not, but that must be
 * confirmed in writing before any paid-tier move.
 *
 * Injectable: `fetchImpl` defaults to global fetch (Node 20); the API key is read
 * from env with an override and the client throws a clear Error at call time if
 * it is missing. No SDK.
 *
 * // UNVERIFIED — Kochava request/response shapes are written from the docs, not
 * validated against a live account. Every wire shape below is UNVERIFIED.
 */

/** Kochava free-tier ceiling: 10K attributed conversions/month (§10.2). */
export const KOCHAVA_FREE_TIER_CEILING = 10_000
/** Alarm once attributed conversions reach this fraction of the ceiling. */
export const KOCHAVA_CEILING_ALARM_RATIO = 0.8

export type FetchImpl = typeof fetch

export interface KochavaConfig {
  /** Kochava API key. Falls back to `KOCHAVA_API_KEY`. */
  apiKey?: string
  /** Kochava app GUID. Falls back to `KOCHAVA_APP_GUID`. */
  appGuid?: string
  /** API base. Falls back to `KOCHAVA_BASE_URL` then the documented default. */
  baseUrl?: string
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchImpl
  env?: Record<string, string | undefined>
}

// // UNVERIFIED base URL.
const DEFAULT_BASE_URL = 'https://control.kochava.com/v1'

export interface SmartLinkRequest {
  /** Human campaign name — maps to the SmartLink's tracker name. */
  campaignName: string
  /** Play Store URL carrying `utm_content=<video_id>`. */
  androidUrl: string
  /** App Store URL carrying `pt`/`ct`. */
  iosUrl: string
  /** The published video id stamped as utm_content (never PII). */
  utmContent?: string
}

/** // UNVERIFIED shape. */
export interface SmartLinkResult {
  smartLinkUrl: string
  trackerId: string
}

/** // UNVERIFIED shape. */
export interface OwnedMediaConversion {
  conversionId: string
  campaignName: string
  utmContent: string | null
  platform: 'android' | 'ios' | string
  occurredAt: string
  /** Kochava's attribution flag — we only ever want owned-media, never paid UA. */
  mediaType: 'owned' | 'paid' | string
}

export interface CeilingAlarm {
  conversions: number
  ceiling: number
  ratio: number
  alarm: boolean
  message: string
}

/**
 * Billing-trap ceiling check. Returns an alarm once `conversions` reaches the
 * configured fraction of the free-tier ceiling. Pure — callable standalone.
 */
export function checkFreeTierCeiling(
  conversions: number,
  opts: { ceiling?: number; alarmRatio?: number } = {}
): CeilingAlarm {
  const ceiling = opts.ceiling ?? KOCHAVA_FREE_TIER_CEILING
  const alarmRatio = opts.alarmRatio ?? KOCHAVA_CEILING_ALARM_RATIO
  const ratio = ceiling > 0 ? conversions / ceiling : 0
  const alarm = ratio >= alarmRatio
  const message = alarm
    ? `Kochava attributed conversions at ${conversions}/${ceiling} (${(ratio * 100).toFixed(0)}% of ` +
      `free tier). Do NOT let this cross the ceiling casually — each attributed conversion past ` +
      `10K/mo risks converting free organic into a billable event. Confirm owned-media billing in ` +
      `writing before any paid-tier move.`
    : `Kochava attributed conversions at ${conversions}/${ceiling} (${(ratio * 100).toFixed(0)}% of free tier).`
  return { conversions, ceiling, ratio, alarm, message }
}

export interface ConversionPull {
  conversions: OwnedMediaConversion[]
  /** Billing-trap ceiling alarm computed from the pulled count. */
  ceiling: CeilingAlarm
}

export class KochavaClient {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchImpl
  private readonly cfg: KochavaConfig
  private readonly env: Record<string, string | undefined>

  constructor(cfg: KochavaConfig = {}) {
    this.cfg = cfg
    this.env = cfg.env ?? process.env
    this.baseUrl = (cfg.baseUrl ?? this.env.KOCHAVA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  private apiKey(): string {
    const key = this.cfg.apiKey ?? this.env.KOCHAVA_API_KEY
    if (!key || key.trim() === '') {
      throw new Error('KOCHAVA_API_KEY is not set — inject apiKey or set the env var before calling Kochava')
    }
    return key
  }

  private appGuid(): string {
    const guid = this.cfg.appGuid ?? this.env.KOCHAVA_APP_GUID
    if (!guid || guid.trim() === '') {
      throw new Error('KOCHAVA_APP_GUID is not set — inject appGuid or set the env var before calling Kochava')
    }
    return guid
  }

  /**
   * Create an OWNED-MEDIA SmartLink for a bio link. `media_type: 'owned'` is
   * hard-coded — this client must never mint a paid-UA link (billing trap).
   * // UNVERIFIED request/response shape.
   */
  async createSmartLink(req: SmartLinkRequest): Promise<SmartLinkResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/smartlink`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        app_guid: this.appGuid(),
        tracker_name: req.campaignName,
        media_type: 'owned', // NEVER 'paid' — see billing trap.
        destinations: { android: req.androidUrl, ios: req.iosUrl },
        utm_content: req.utmContent ?? null,
      }),
    })
    if (!res.ok) {
      throw new Error(`Kochava createSmartLink failed: HTTP ${res.status}`)
    }
    const json = (await res.json()) as { smartlink_url?: string; tracker_id?: string }
    return {
      smartLinkUrl: json.smartlink_url ?? '',
      trackerId: json.tracker_id ?? '',
    }
  }

  /**
   * Pull owned-media (never paid-UA) attributed conversions for a date range,
   * and compute the free-tier ceiling alarm from the count. Paid rows, if the
   * account somehow has any, are filtered out so they can never be mistaken for
   * an owned-media conversion. // UNVERIFIED request/response shape.
   */
  async pullOwnedMediaConversions(range: { fromDate: string; toDate: string }): Promise<ConversionPull> {
    const url = new URL(`${this.baseUrl}/conversions`)
    url.searchParams.set('app_guid', this.appGuid())
    url.searchParams.set('media_type', 'owned')
    url.searchParams.set('from', range.fromDate)
    url.searchParams.set('to', range.toDate)

    const res = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${this.apiKey()}` },
    })
    if (!res.ok) {
      throw new Error(`Kochava pullOwnedMediaConversions failed: HTTP ${res.status}`)
    }
    const json = (await res.json()) as { conversions?: OwnedMediaConversion[] }
    const all = json.conversions ?? []
    const conversions = all.filter((c) => c.mediaType === 'owned')
    return { conversions, ceiling: checkFreeTierCeiling(conversions.length) }
  }
}

/** Construct a Kochava client from config/env. */
export function createKochavaClient(cfg: KochavaConfig = {}): KochavaClient {
  return new KochavaClient(cfg)
}
