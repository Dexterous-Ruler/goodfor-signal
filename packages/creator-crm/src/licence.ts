/**
 * Licence-end (rights_grant) computation + alerting (PHASE-5-scale-creators.md §9.5).
 *
 * A LIVE PAID AD ON AN EXPIRED USAGE LICENCE is the single largest routine legal
 * exposure in the whole programme. `rights_grant` ships in v1 precisely so this
 * can be caught: the nightly scan flags any `rights_grant.expires_at` that has
 * passed (or is near) while its linked deliverable is still `live`. Trivial to
 * build now, painful to retrofit.
 *
 * Pure — the worker (`apps/worker-creators/src/licence-alerts.ts`) does the DB
 * scan and raises the alert row/log; this module only decides whether a given
 * grant + deliverable state needs one.
 */

/** Default lead time: alert when a licence is within this many days of expiry. */
export const LICENCE_ALERT_WINDOW_DAYS = 7

/** The deliverable state that makes an expired licence dangerous. */
export const LIVE_STAGE = 'live'

export interface RightsGrantLike {
  /** licence_end. Null = no expiry captured (e.g. perpetual) → never alerts. */
  expires_at: string | null
  /** Optional; used only to compute expires_at when it is absent. */
  starts_at?: string | null
}

/**
 * Compute a licence end date from a start + a term in days. Used when a grant is
 * created from a term rather than an explicit end date (whitelisting months, an
 * exclusivity window, etc.).
 */
export function licenceEnd(startsAt: string | Date, termDays: number): Date {
  const start = startsAt instanceof Date ? startsAt : new Date(startsAt)
  if (Number.isNaN(start.getTime())) throw new Error(`licenceEnd: invalid startsAt: ${String(startsAt)}`)
  if (!Number.isFinite(termDays) || termDays < 0) throw new Error(`licenceEnd: invalid termDays: ${termDays}`)
  return new Date(start.getTime() + termDays * 24 * 3600_000)
}

export interface LicenceAlertOptions {
  /** Lead-time window in days (default LICENCE_ALERT_WINDOW_DAYS). */
  alertWindowDays?: number
}

export interface LicenceStatus {
  needsAlert: boolean
  /** True once expires_at is at/before `now`. */
  expired: boolean
  /** Days until expiry (negative if already expired); null when no expires_at. */
  daysUntilExpiry: number | null
  reason: string | null
}

function isLive(deliverableStage: string | null | undefined): boolean {
  return deliverableStage === LIVE_STAGE
}

/**
 * Full licence status for a grant + the linked deliverable's stage at time `now`.
 * Alerts when the deliverable is `live` AND the licence has expired or is within
 * the lead-time window. A grant with no `expires_at` (perpetual) never alerts.
 */
export function licenceStatus(
  grant: RightsGrantLike,
  deliverableStage: string | null | undefined,
  now: Date,
  opts: LicenceAlertOptions = {}
): LicenceStatus {
  const windowDays = opts.alertWindowDays ?? LICENCE_ALERT_WINDOW_DAYS

  if (!grant.expires_at) {
    return { needsAlert: false, expired: false, daysUntilExpiry: null, reason: null }
  }

  const expiresAt = new Date(grant.expires_at)
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error(`licenceStatus: invalid expires_at: ${grant.expires_at}`)
  }

  const msUntil = expiresAt.getTime() - now.getTime()
  const daysUntilExpiry = msUntil / (24 * 3600_000)
  const expired = msUntil <= 0
  const live = isLive(deliverableStage)
  const withinWindow = daysUntilExpiry <= windowDays

  const needsAlert = live && withinWindow

  let reason: string | null = null
  if (needsAlert) {
    reason = expired
      ? `usage licence EXPIRED ${Math.abs(daysUntilExpiry).toFixed(1)}d ago while the deliverable is live — ` +
        `pull the paid ad or renew the grant (top routine legal exposure, §9.5)`
      : `usage licence expires in ${daysUntilExpiry.toFixed(1)}d while the deliverable is live — ` +
        `renew before it lapses (§9.5)`
  }

  return { needsAlert, expired, daysUntilExpiry, reason }
}

/**
 * Convenience boolean: does this grant + deliverable state need a licence-end
 * alert right now? True when expired-and-live (or near-expiry-and-live); false
 * once the grant is extended past the window, or the deliverable is not live.
 */
export function needsAlert(
  grant: RightsGrantLike,
  deliverableStage: string | null | undefined,
  now: Date,
  opts: LicenceAlertOptions = {}
): boolean {
  return licenceStatus(grant, deliverableStage, now, opts).needsAlert
}
