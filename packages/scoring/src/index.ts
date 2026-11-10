/**
 * Outperformance scoring.
 *
 * Design notes that are load-bearing — see completion.md §5:
 *
 * 1. LOG SPACE. TikTok view distributions are heavy-tailed. Raw-space z-scores
 *    fire on every video from a large account and never on a genuine breakout
 *    from a small one.
 *
 * 2. MEDIAN/MAD, NOT MEAN/SIGMA. An account that posts several virals in a row
 *    inflates its own mean and sigma until nothing registers — "masking". That
 *    is precisely the account you most want alerts on. vidIQ's published
 *    approach uses a mean baseline and has this flaw.
 *
 * 3. AGE MATCHING. A video's views are compared against the same account's own
 *    videos AT THE SAME AGE, never against their lifetime totals.
 */

export const MIN_BASELINE_N = 8
export const DEFAULT_BASELINE_N = 30

/** Age grid in hours. Scores are only ever computed at these ages. */
export const AGE_GRID = [1, 2, 3, 6, 12, 24, 48, 72, 168] as const
export type AgeHours = (typeof AGE_GRID)[number]

export interface Snapshot {
  /** Hours since the video was posted. */
  ageHours: number
  viewCount: number
}

// ---------------------------------------------------------------------------
// Robust statistics
// ---------------------------------------------------------------------------

export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('median of empty array')
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  if (s.length % 2 === 1) return s[mid]!
  return (s[mid - 1]! + s[mid]!) / 2
}

/** Median absolute deviation. */
export function mad(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('mad of empty array')
  const m = median(xs)
  return median(xs.map((x) => Math.abs(x - m)))
}

export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const variance = xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(variance)
}

/**
 * Iglewicz–Hoaglin modified z-score.
 *
 *   M = 0.6745 * (x - median) / MAD
 *
 * 0.6745 is Phi^-1(0.75), NOT "the constant making MAD a consistent estimator
 * of sigma" — that constant is 1.4826, and the two forms are equivalent:
 *   0.6745 * (x - med) / MAD  ===  (x - med) / (1.4826 * MAD)
 * Getting this backwards scales the result by ~4.9x.
 *
 * Falls back to a classical z-score when MAD is 0, which happens when more
 * than half the baseline shares an identical value (common on tiny accounts).
 */
export function modifiedZ(x: number, baseline: readonly number[]): number {
  const med = median(baseline)
  const m = mad(baseline)
  if (m === 0) {
    const sd = stddev(baseline)
    return sd === 0 ? 0 : (x - med) / sd
  }
  return (0.6745 * (x - med)) / m
}

/** Iglewicz–Hoaglin's own flag threshold. */
export const OUTLIER_THRESHOLD = 3.5

// ---------------------------------------------------------------------------
// Interpolation onto the age grid
// ---------------------------------------------------------------------------

/**
 * View count at a given age, linearly interpolated between the two bracketing
 * snapshots. Returns null when the age falls outside observed data — we do not
 * extrapolate, because extrapolating a heavy-tailed growth curve is how you
 * manufacture a false outlier.
 */
export function viewsAtAge(snapshots: readonly Snapshot[], ageHours: number): number | null {
  if (snapshots.length === 0) return null
  const s = [...snapshots].sort((a, b) => a.ageHours - b.ageHours)

  const first = s[0]!
  const last = s[s.length - 1]!
  if (ageHours < first.ageHours || ageHours > last.ageHours) return null

  for (let i = 0; i < s.length - 1; i++) {
    const lo = s[i]!
    const hi = s[i + 1]!
    if (ageHours >= lo.ageHours && ageHours <= hi.ageHours) {
      const span = hi.ageHours - lo.ageHours
      if (span === 0) return lo.viewCount
      const t = (ageHours - lo.ageHours) / span
      return lo.viewCount + t * (hi.viewCount - lo.viewCount)
    }
  }
  return last.viewCount
}

// ---------------------------------------------------------------------------
// Velocity and acceleration
// ---------------------------------------------------------------------------

/** Views per hour between two snapshots. */
export function velocity(a: Snapshot, b: Snapshot): number {
  const dt = b.ageHours - a.ageHours
  if (dt <= 0) return 0
  return (b.viewCount - a.viewCount) / dt
}

/**
 * Change in velocity per hour. Needs three snapshots.
 * Positive means still accelerating — the video has not peaked.
 */
export function acceleration(a: Snapshot, b: Snapshot, c: Snapshot): number {
  const v1 = velocity(a, b)
  const v2 = velocity(b, c)
  const dt = (c.ageHours + b.ageHours) / 2 - (b.ageHours + a.ageHours) / 2
  if (dt <= 0) return 0
  return (v2 - v1) / dt
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreInput {
  /** Snapshots for the video being scored. */
  snapshots: readonly Snapshot[]
  /**
   * View counts of the account's trailing N videos AT THE SAME AGE.
   * Raw counts — log transform is applied internally.
   */
  baselineViewsAtAge: readonly number[]
  ageHours: number
}

export interface Score {
  ageHours: number
  zScore: number
  multiplierVsMedian: number
  velocityVph: number
  acceleration: number
  baselineN: number
}

const ln1p = (v: number) => Math.log(v + 1)

/**
 * The up-to-3 snapshots at or before `ageHours`, so velocity and acceleration
 * describe the video's behaviour AT that age rather than at the end of its life.
 *
 * Strictly causal — never looks past the scoring age. This mirrors production,
 * where scoring a 3-hour-old video means you have exactly 3 hours of data.
 * Peeking forward makes a still-climbing video read as decelerating and
 * silently suppresses every alert.
 */
export function localWindow(snapshots: readonly Snapshot[], ageHours: number): Snapshot[] {
  const sorted = [...snapshots].sort((a, b) => a.ageHours - b.ageHours)
  let end = sorted.findIndex((s) => s.ageHours > ageHours)
  if (end === -1) end = sorted.length
  return sorted.slice(Math.max(0, end - 3), end)
}

/**
 * Returns null when there is not enough baseline to say anything honest.
 * A three-video account with one fluke must not produce a "40x outlier".
 */
export function scoreVideo(input: ScoreInput): Score | null {
  const { snapshots, baselineViewsAtAge, ageHours } = input

  if (baselineViewsAtAge.length < MIN_BASELINE_N) return null

  const views = viewsAtAge(snapshots, ageHours)
  if (views === null) return null

  const logBaseline = baselineViewsAtAge.map(ln1p)
  const z = modifiedZ(ln1p(views), logBaseline)

  const medianViews = median(baselineViewsAtAge)
  const multiplier = medianViews > 0 ? views / medianViews : 0

  // Velocity and acceleration must be LOCAL TO THE SCORING AGE, not taken from
  // the tail of the whole series. Scoring a video at age 6h using its 168h
  // snapshots measures a curve that has long since plateaued, so acceleration
  // reads <= 0 and every alert gate fails.
  const local = localWindow(snapshots, ageHours)
  const n = local.length
  const vph = n >= 2 ? velocity(local[n - 2]!, local[n - 1]!) : 0
  const accel = n >= 3 ? acceleration(local[n - 3]!, local[n - 2]!, local[n - 1]!) : 0

  return {
    ageHours,
    zScore: z,
    multiplierVsMedian: multiplier,
    velocityVph: vph,
    acceleration: accel,
    baselineN: baselineViewsAtAge.length,
  }
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

export interface AlertConfig {
  minZ: number
  maxAgeHours: number
  minViews: number
  requireAccelerating: boolean
}

/**
 * Tuned for the "detect and replicate within hours" requirement.
 * minViews is a small-sample noise floor, not a quality bar.
 * requireAccelerating filters out spikes that have already peaked — by the
 * time you could ship a response, a decelerating video is spent.
 */
export const DEFAULT_ALERT: AlertConfig = {
  minZ: 2.5,
  maxAgeHours: 12,
  minViews: 10_000,
  requireAccelerating: true,
}

export function shouldAlert(
  score: Score,
  currentViews: number,
  config: AlertConfig = DEFAULT_ALERT
): boolean {
  if (score.zScore < config.minZ) return false
  if (score.ageHours > config.maxAgeHours) return false
  if (currentViews < config.minViews) return false
  if (config.requireAccelerating && score.acceleration <= 0) return false
  return true
}

// ---------------------------------------------------------------------------
// Trend classification
// ---------------------------------------------------------------------------

export type TrendState = 'rising' | 'peaked' | 'decaying' | 'bottoming'

export interface TrendPoint {
  ts: Date
  /** Volume measure — post count or view count. Use one consistently. */
  value: number
}

export interface TrendClassification {
  state: TrendState
  velocity: number
  acceleration: number
  /** Recent rate over baseline rate. >1 means running hot. */
  burstWeight: number
  /** Google Trends calls >5000% growth vs the prior equal window a "Breakout". */
  isBreakout: boolean
}

export const BREAKOUT_GROWTH_RATIO = 50 // 5,000%

/**
 * A term's lifecycle stage from its volume series.
 *
 * The velocity/acceleration sign pair is what separates "act on this" from
 * "too late":
 *   v>0, a>0  rising     — act
 *   v>0, a<0  peaked     — act only if shippable within hours
 *   v<0, a<0  decaying   — ignore
 *   v<0, a>0  bottoming  — watch
 *
 * burstWeight is a deliberately simple recent-vs-baseline rate ratio, not
 * Kleinberg's automaton. It ranks competing rising terms adequately; swap in
 * proper burst detection if ranking quality becomes the bottleneck.
 */
export function classifyTrend(points: readonly TrendPoint[]): TrendClassification | null {
  if (points.length < 3) return null

  const sorted = [...points].sort((a, b) => a.ts.getTime() - b.ts.getTime())
  const n = sorted.length
  const hours = (a: TrendPoint, b: TrendPoint) => (b.ts.getTime() - a.ts.getTime()) / 3_600_000

  const p0 = sorted[n - 3]!
  const p1 = sorted[n - 2]!
  const p2 = sorted[n - 1]!

  const dt1 = hours(p0, p1)
  const dt2 = hours(p1, p2)
  if (dt1 <= 0 || dt2 <= 0) return null

  const v1 = (p1.value - p0.value) / dt1
  const v2 = (p2.value - p1.value) / dt2
  const velocity = v2
  const acceleration = (v2 - v1) / ((dt1 + dt2) / 2)

  let state: TrendState
  if (velocity > 0) state = acceleration >= 0 ? 'rising' : 'peaked'
  else state = acceleration >= 0 ? 'bottoming' : 'decaying'

  // Baseline: mean rate across the first half of the series.
  const half = Math.max(2, Math.floor(n / 2))
  const first = sorted[0]!
  const mid = sorted[half - 1]!
  const baseSpan = hours(first, mid)
  const baseRate = baseSpan > 0 ? (mid.value - first.value) / baseSpan : 0
  const burstWeight = baseRate > 0 ? velocity / baseRate : velocity > 0 ? Infinity : 0

  // Breakout compares this window's growth against the prior equal-length one.
  const priorGrowth = Math.max(1, p1.value - p0.value)
  const recentGrowth = p2.value - p1.value
  const isBreakout = recentGrowth / priorGrowth > BREAKOUT_GROWTH_RATIO

  return {
    state,
    velocity,
    acceleration,
    burstWeight: Number.isFinite(burstWeight) ? burstWeight : 999,
    isBreakout,
  }
}

/**
 * Minimum volume floor. Without it, 2 -> 120 posts outranks 40,000 -> 900,000
 * on percentage growth, and the trend board fills with noise.
 */
export const MIN_TREND_VOLUME = 500

export function isActionableTrend(c: TrendClassification, latestVolume: number): boolean {
  if (latestVolume < MIN_TREND_VOLUME) return false
  return c.state === 'rising' && c.burstWeight > 1.5
}

// ---------------------------------------------------------------------------
// Poll tier scheduling
// ---------------------------------------------------------------------------

export interface PollTier {
  tier: number
  maxAgeHours: number
  intervalMinutes: number
}

export const POLL_TIERS: readonly PollTier[] = [
  { tier: 0, maxAgeHours: 1, intervalMinutes: 5 },
  { tier: 1, maxAgeHours: 6, intervalMinutes: 15 },
  { tier: 2, maxAgeHours: 24, intervalMinutes: 30 },
  { tier: 3, maxAgeHours: 72, intervalMinutes: 120 },
  { tier: 4, maxAgeHours: 168, intervalMinutes: 360 },
  { tier: 5, maxAgeHours: 720, intervalMinutes: 1440 },
  { tier: 6, maxAgeHours: Infinity, intervalMinutes: 10080 },
]

export function tierForAge(ageHours: number): PollTier {
  return POLL_TIERS.find((t) => ageHours < t.maxAgeHours) ?? POLL_TIERS[POLL_TIERS.length - 1]!
}

/**
 * Velocity override. A video accelerating hard gets promoted a tier; one that
 * has gone flat gets demoted. Promotion is capped at the 5-minute floor.
 */
export function adjustTier(
  currentTier: number,
  recentDeltaViews: number,
  priorDeltaViews: number
): number {
  if (priorDeltaViews > 0 && recentDeltaViews > 3 * priorDeltaViews) {
    return Math.max(0, currentTier - 1)
  }
  return currentTier
}

export function nextDueAt(tier: number, from: Date = new Date()): Date {
  const t = POLL_TIERS[Math.min(tier, POLL_TIERS.length - 1)]!
  return new Date(from.getTime() + t.intervalMinutes * 60_000)
}
