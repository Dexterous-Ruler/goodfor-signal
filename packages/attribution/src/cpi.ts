/**
 * Organic CPI (PHASE-4-attribute.md §10.6).
 *
 *   organic CPI = (fully-loaded content cost) ÷ (incremental installs)
 *
 * where "incremental installs" comes from a single-channel PAUSE TEST, not a
 * vendor benchmark. THERE IS NO PUBLISHED ORGANIC TIKTOK CPI — do not bake a
 * constant anywhere. This function only does the division; the incremental count
 * must be produced by an incrementality test (`incrementality_test`).
 *
 * For sanity-comparison ONLY (never as an input): Tier-1 English fitness/health
 * CPI ~$2.50–$6.50, iOS 2.0–3.5× Android. Ignore the Business of Apps
 * $1.75–$4.00 TikTok figure (2024, Android-above-iOS, contradicts 2026 sources).
 *
 * PLACEHOLDER — replace with Goodfor's own measured data. The §10 weak-evidence
 * numbers are DELIBERATELY NOT baked in anywhere in this package, because the
 * spec flags them as soft: link-in-bio CTR (the weakest number in the whole
 * document — 0.1–0.5% of video views, [UNVERIFIED, no sample size]); HDYHAU
 * completion 45–85% [VENDOR, no sample size]; the RevenueCat funnel benchmarks
 * (2.9% install→paid, 37.7% trial→paid, $35.64 LTV) [VENDOR — sanity-check only,
 * never to SET a cohort]; and every published retention / Spark-Ads-lift figure
 * [REFUTED at source]. If any of these ever enters a model, tag it here and
 * partition US/non-US and pre/post 22 Jan 2026 — never pool.
 */

export interface CpiInput {
  /** Every cost that went into producing the content, in cents. */
  fullyLoadedCostCents: number
  /** Incremental installs attributed to the paused channel by the pause test. */
  incrementalInstalls: number
}

/**
 * Compute organic CPI in cents/install, rounded to the nearest cent (the
 * `computed_cpi_cents` column is an integer).
 *
 * Throws on a non-positive `incrementalInstalls` (divide-by-zero guard): a pause
 * test that measured zero incremental installs yields no defensible CPI — the
 * caller must treat that as "inconclusive", not as CPI=∞ or CPI=0.
 */
export function computeCpi(input: CpiInput): number {
  const { fullyLoadedCostCents, incrementalInstalls } = input
  if (!Number.isFinite(fullyLoadedCostCents) || fullyLoadedCostCents < 0) {
    throw new Error(`fullyLoadedCostCents must be a non-negative number, got ${fullyLoadedCostCents}`)
  }
  if (!Number.isFinite(incrementalInstalls) || incrementalInstalls <= 0) {
    throw new Error(
      `incrementalInstalls must be > 0 to compute a CPI (got ${incrementalInstalls}); ` +
        `a pause test with zero incremental installs is inconclusive, not CPI=0`
    )
  }
  return Math.round(fullyLoadedCostCents / incrementalInstalls)
}
