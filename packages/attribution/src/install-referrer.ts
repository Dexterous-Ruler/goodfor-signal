/**
 * Android Play Install Referrer parsing (PHASE-4-attribute.md §10.1).
 *
 * On first launch an Android install carries the referrer string
 *   `utm_source=tiktok&utm_content=<video_id>`
 * read once via `com.android.installreferrer:installreferrer:2.2`. This is the
 * ONLY 100%-deterministic per-video attribution signal in the whole system.
 *
 * PRIVACY INVARIANT (system rules + §"Privacy"): `utm_content` carries a VIDEO
 * ID ONLY. A device id, user id, email, or any PII must never appear here — if
 * it does the string is malformed by our own rules and is rejected, not stored.
 *
 * Pure: no I/O. The worker persists the result.
 */

/** Channels we accept as an install source. Extend as new channels go live. */
export const ALLOWED_UTM_SOURCES = ['tiktok'] as const
export type UtmSource = (typeof ALLOWED_UTM_SOURCES)[number]

export interface InstallReferrer {
  utmSource: string
  /** The published TikTok video id — numeric, never PII. */
  videoId: string
}

export class ReferrerParseError extends Error {
  constructor(
    message: string,
    readonly reason: 'empty' | 'malformed' | 'missing_source' | 'bad_source' | 'missing_video' | 'bad_video' | 'pii'
  ) {
    super(message)
    this.name = 'ReferrerParseError'
  }
}

// TikTok aweme/video ids are numeric snowflakes (~19 digits). We accept a
// generous numeric range and reject anything non-numeric — that also blocks the
// obvious PII shapes (emails, IDFAs/GAIDs with hyphens, usernames).
const VIDEO_ID_RE = /^\d{5,25}$/
const SOURCE_RE = /^[a-z0-9_]{1,32}$/
// A cheap PII tripwire: an '@' (email), or a UUID/advertising-id hyphen shape.
const PII_RE = /@|[0-9a-f]{8}-[0-9a-f]{4}/i

export interface ParseOptions {
  /** Which utm_source values are acceptable. Default `ALLOWED_UTM_SOURCES`. */
  allowedSources?: readonly string[]
}

/**
 * Parse + validate a Play Install Referrer string. Throws `ReferrerParseError`
 * with a machine-readable `reason` on anything malformed, from the wrong
 * source, or carrying PII. Never returns a partial result.
 */
export function parseInstallReferrer(raw: string, opts: ParseOptions = {}): InstallReferrer {
  const allowed = opts.allowedSources ?? ALLOWED_UTM_SOURCES

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ReferrerParseError('empty install referrer', 'empty')
  }
  if (PII_RE.test(raw)) {
    throw new ReferrerParseError('install referrer contains PII — refusing to parse', 'pii')
  }

  let params: URLSearchParams
  try {
    // The referrer is a bare query string, not a URL. URLSearchParams handles
    // the `k=v&k=v` form and percent-decoding without a scheme.
    params = new URLSearchParams(raw)
  } catch {
    throw new ReferrerParseError(`malformed install referrer: ${raw}`, 'malformed')
  }

  const utmSource = params.get('utm_source')
  if (utmSource === null) throw new ReferrerParseError('missing utm_source', 'missing_source')
  if (!SOURCE_RE.test(utmSource) || !allowed.includes(utmSource)) {
    throw new ReferrerParseError(`unexpected utm_source '${utmSource}'`, 'bad_source')
  }

  const videoId = params.get('utm_content')
  if (videoId === null) throw new ReferrerParseError('missing utm_content (video id)', 'missing_video')
  if (!VIDEO_ID_RE.test(videoId)) {
    throw new ReferrerParseError(
      `utm_content '${videoId}' is not a bare numeric video id — refusing (privacy invariant)`,
      'bad_video'
    )
  }

  return { utmSource, videoId }
}

/** Non-throwing variant: returns `null` instead of throwing. */
export function tryParseInstallReferrer(raw: string, opts: ParseOptions = {}): InstallReferrer | null {
  try {
    return parseInstallReferrer(raw, opts)
  } catch {
    return null
  }
}
