/**
 * Licensing & rate maths (PHASE-5-scale-creators.md §9.2).
 *
 * ⚠️ WEAK-EVIDENCE ZONE. §9 calls its own pricing "the softest evidence in the
 * entire research". Every constant below is a NEGOTIATING RANGE, not a formula —
 * validate against Goodfor's own negotiated deals before treating any of it as a
 * planning constant. There is deliberately NO "brands pay 50% of ask" rule
 * anywhere in this file: that figure appears nowhere in the report; the real
 * paid/ask ratio is ~86% (paid $154 on a $180 ask), and it is a descriptive
 * datum, never a pricing rule.
 *
 * Licence-cost formula (§9.2):
 *   licence_cost = base_fee × (1 + usage_multiplier + whitelist_rate × months + exclusivity_multiplier)
 *
 * `exclusivity_multiplier` has NO DEFAULT — the commonly cited "20–40% exclusivity
 * premium" appears at NONE of its claimed sources, so it is operator-set only and
 * the caller MUST pass it. Omitting it is a typed error (required field) and a
 * runtime throw.
 */

// ---------------------------------------------------------------------------
// Anchored constants — NEGOTIATING RANGE, validate against Goodfor's own deals.
// These are the strongest-verified pricing block (§9.2, triple-sourced), but
// still only a starting range, never a hard formula.
// ---------------------------------------------------------------------------

/** Usage-rights add-on: 30–50% of base (§9.2). Negotiating range — replace with own data. */
export const USAGE_MULTIPLIER_RANGE = { min: 0.3, max: 0.5 } as const
/** Raw-footage add-on: 30–50% of base (§9.2). Negotiating range — replace with own data. */
export const RAW_FOOTAGE_MULTIPLIER_RANGE = { min: 0.3, max: 0.5 } as const
/** Whitelisting / Spark: 30% of base PER MONTH (§9.2). Negotiating range — replace with own data. */
export const WHITELIST_RATE_PER_MONTH = 0.3
/** Full buyout: 2–5× base (§9.2). Negotiating range — replace with own data. */
export const BUYOUT_MULTIPLIER_RANGE = { min: 2, max: 5 } as const
/** Extra hook / CTA: flat $50 (§9.2). Negotiating range — replace with own data. */
export const EXTRA_HOOK_CTA_FLAT_USD = 50

/**
 * Planning band for a single UGC video, in USD (§9.2): **$150–$200/video**.
 * `[SINGLE-SOURCE, Collabstr 2026]` — UGC ask ~$180, actually paid ~$154 (85.6%),
 * campaign avg ~$197, 80% of deals under $300. A planning RANGE, never a formula,
 * and explicitly NOT a "50% of ask" rule. Replace with Goodfor's own negotiated data.
 */
export const CREATOR_VIDEO_RATE_RANGE_USD = { min: 150, max: 200 } as const

export interface LicenceCostInput {
  /**
   * Base creator fee in the operator's chosen unit (cents or dollars — this
   * function is unit-agnostic and returns the same unit it was given).
   */
  baseFee: number
  /**
   * Usage-rights / raw-footage multiplier as a fraction of base (anchor 0.30–0.50).
   * Defaults to 0 (no usage rights bundled). Operator-set from the negotiating range.
   */
  usageMultiplier?: number
  /**
   * Whitelisting rate per month as a fraction of base (anchor 0.30). Defaults to 0.
   * Multiplied by `whitelistMonths`.
   */
  whitelistRate?: number
  /** Number of whitelisting months. Defaults to 0. */
  whitelistMonths?: number
  /**
   * Exclusivity multiplier as a fraction of base. **REQUIRED — no default.**
   * Operator-set only; there is no defensible anchor (§9.2).
   */
  exclusivityMultiplier: number
}

/**
 * Compute a licence cost from the §9.2 formula. `exclusivityMultiplier` is
 * required: it has no defensible default, so a caller MUST supply one (typed as
 * required; also guarded at runtime for JS callers).
 */
export function licenceCost(input: LicenceCostInput): number {
  const {
    baseFee,
    usageMultiplier = 0,
    whitelistRate = 0,
    whitelistMonths = 0,
    exclusivityMultiplier,
  } = input

  if (typeof exclusivityMultiplier !== 'number' || !Number.isFinite(exclusivityMultiplier)) {
    throw new Error(
      'exclusivityMultiplier is required and has no default — the "20–40% exclusivity premium" ' +
        'is unsupported at every claimed source (§9.2), so it must be operator-set per deal. ' +
        'Pass an explicit multiplier (e.g. 0 for none).'
    )
  }

  const multiplier = 1 + usageMultiplier + whitelistRate * whitelistMonths + exclusivityMultiplier
  return baseFee * multiplier
}
