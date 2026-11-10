/**
 * Attribution cadence guard (PHASE-4-attribute.md §10.5).
 *
 * Identification requires ≤1–2 videos/account/day. Beyond that the per-format
 * regressors in `format-lift.ts` collinearise and the model cannot separate
 * which video drove which spike. Cal AI showed a 176× view spread between two
 * accounts of the same brand — account-level variance dominates video-level
 * variance, so MORE ACCOUNTS beats more posts per account, and that direction is
 * also attribution-friendly.
 *
 * This is a WARNING, not a hard block (§Work-breakdown 6): the caller may
 * override and post the 3rd video, but must LOG the override with the reason.
 */

/** ≤1–2/account/day keeps the lift model identifiable (§10.5). */
export const CADENCE_IDEAL_MAX = 1
export const CADENCE_SOFT_MAX = 2

export interface CadenceResult {
  /** True while within the soft cap (≤2). False = over cadence (override + log). */
  ok: boolean
  /** True once the count exceeds the soft cap — surface the warning. */
  warn: boolean
  /** Human-readable reason when `warn`, else null. */
  reason: string | null
  postsToday: number
}

export interface CadenceOptions {
  idealMax?: number
  softMax?: number
}

/**
 * Check the cadence for an account, given `postsToday` = the number of posts
 * that would exist for that account today INCLUDING the one being scheduled.
 *
 *   1 → ok, no warning
 *   2 → ok (still identifiable), no warning (this is the ceiling of ≤1–2)
 *   3+ → not ok, WARN (collinearity risk) — caller may override + must log
 */
export function checkCadence(postsToday: number, opts: CadenceOptions = {}): CadenceResult {
  const softMax = opts.softMax ?? CADENCE_SOFT_MAX
  const idealMax = opts.idealMax ?? CADENCE_IDEAL_MAX

  if (postsToday > softMax) {
    return {
      ok: false,
      warn: true,
      reason:
        `posting ${postsToday} videos on this account today exceeds the attribution cadence cap ` +
        `of ${softMax}/account/day (§10.5): regressors collinearise and format-lift cannot ` +
        `separate which video drove which install spike. Prefer more accounts over more posts. ` +
        `Override is allowed but will be logged.`,
      postsToday,
    }
  }

  const reason =
    postsToday > idealMax
      ? `at the cadence ceiling (${postsToday}/${softMax}); identification is best at ≤${idealMax}/day`
      : null
  return { ok: true, warn: false, reason, postsToday }
}
