/**
 * Creator vetting (PHASE-5-scale-creators.md §9.4).
 *
 * Two gates:
 *  1. FAKE-FOLLOWER GATE (Modash guidance): hire < 25%, avoid > 50%, review in
 *     between. Sub-50K creators run 10–20% fake, larger 20–30% — some fake is
 *     normal, so the gate is a band, not a cliff. HypeAuditor's AQS publishes NO
 *     numeric cutoff (detection is "probabilistic, not perfect"), so we never
 *     hard-gate on AQS here.
 *  2. ENGAGEMENT RANK on `er_views` = (likes + comments + shares) / views × 100,
 *     against a 6–8% median band by tier.
 *
 * ⚠️ DENOMINATOR WARNING (§9.4, §Phase-2): the circulating "micro 2–4% ER"
 * benchmarks are FOLLOWER-denominator numbers in disguise and are WRONG for
 * TikTok. TikTok's real engagement denominator is VIEWS (`er_views`), which runs
 * a ~6–8% median — never rank creators on a follower-based ER.
 */

export type FakeFollowerVerdict = 'hire' | 'review' | 'avoid'

/** hire < 25% fake, avoid > 50% fake, review in the 25–50% band (inclusive). */
export const FAKE_FOLLOWER_HIRE_MAX = 25
export const FAKE_FOLLOWER_AVOID_MIN = 50

/**
 * Gate a creator on their fake-follower percentage (0–100).
 *   < 25 → 'hire'   (clean enough)
 *   > 50 → 'avoid'  (too much fake audience)
 *   otherwise → 'review' (human judgement; some fake is normal)
 */
export function fakeFollowerGate(pct: number): FakeFollowerVerdict {
  if (!Number.isFinite(pct)) throw new Error('fakeFollowerGate: pct must be a finite number (0–100)')
  if (pct < FAKE_FOLLOWER_HIRE_MAX) return 'hire'
  if (pct > FAKE_FOLLOWER_AVOID_MIN) return 'avoid'
  return 'review'
}

// ---------------------------------------------------------------------------
// er_views engagement ranking
// ---------------------------------------------------------------------------

export type Tier = 'nano' | 'micro' | 'mid' | 'macro' | 'mega'

/** Follower tiers. `nano` (1k–10k) is Modash-unindexed (direct-outreach-only, §9.1). */
export function tierForFollowers(followers: number): Tier {
  if (followers < 10_000) return 'nano'
  if (followers < 100_000) return 'micro'
  if (followers < 500_000) return 'mid'
  if (followers < 1_000_000) return 'macro'
  return 'mega'
}

/**
 * er_views median band by tier (§9.4). Anchored on the correct VIEWS-denominator
 * ~6–8% median; larger tiers trend slightly lower. NEGOTIATING/BENCHMARK range —
 * regress against Goodfor's own creator cohort before treating as a cutoff.
 */
export const ER_VIEWS_MEDIAN_BAND: Record<Tier, { min: number; max: number }> = {
  nano: { min: 6, max: 9 },
  micro: { min: 6, max: 8 },
  mid: { min: 5, max: 8 },
  macro: { min: 5, max: 7 },
  mega: { min: 4, max: 6 },
}

export interface ErViewsMetrics {
  likes: number
  comments: number
  shares: number
  views: number
}

/**
 * er_views = (likes + comments + shares) / views × 100. Returns 0 when views is
 * 0 or missing (an unwatched video has no engagement rate, not an infinite one).
 * NOTE: the denominator is VIEWS, never followers (§9.4).
 */
export function erViews(m: ErViewsMetrics): number {
  if (!m.views || m.views <= 0) return 0
  return ((m.likes + m.comments + m.shares) / m.views) * 100
}

export type BandClassification = 'below' | 'in_band' | 'above'

/** Classify an er_views value against its tier's median band. */
export function classifyErViews(value: number, tier: Tier): BandClassification {
  const band = ER_VIEWS_MEDIAN_BAND[tier]
  if (value < band.min) return 'below'
  if (value > band.max) return 'above'
  return 'in_band'
}

export interface RankableCreator extends ErViewsMetrics {
  followers: number
}

export interface RankedCreator<T> {
  creator: T
  erViews: number
  tier: Tier
  band: BandClassification
}

/**
 * Rank creators by `er_views` descending (best engagement first), each annotated
 * with its tier and where it sits in that tier's 6–8% median band. Pure and
 * stable — ties preserve input order.
 */
export function rankByErViews<T extends RankableCreator>(creators: T[]): RankedCreator<T>[] {
  return creators
    .map((creator) => {
      const value = erViews(creator)
      const tier = tierForFollowers(creator.followers)
      return { creator, erViews: value, tier, band: classifyErViews(value, tier) }
    })
    .sort((a, b) => b.erViews - a.erViews)
}
