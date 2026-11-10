import { describe, it, expect } from 'vitest'
import {
  median,
  mad,
  modifiedZ,
  viewsAtAge,
  velocity,
  acceleration,
  scoreVideo,
  shouldAlert,
  tierForAge,
  MIN_BASELINE_N,
  type Snapshot,
} from './index.js'

describe('median', () => {
  it('handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
  it('is unmoved by an extreme outlier — the whole point of using it', () => {
    expect(median([1, 2, 3, 4, 1_000_000])).toBe(3)
  })
})

describe('mad', () => {
  it('is zero when every value is identical', () => {
    expect(mad([5, 5, 5, 5])).toBe(0)
  })
  it('measures spread robustly', () => {
    expect(mad([1, 2, 3, 4, 5])).toBe(1)
  })
})

describe('modifiedZ', () => {
  it('uses 0.6745, not 1.4826 — verifies the constant is the right way up', () => {
    // baseline median 3, MAD 1. x = 5 → 0.6745 * (5-3) / 1 = 1.349
    expect(modifiedZ(5, [1, 2, 3, 4, 5])).toBeCloseTo(1.349, 3)
    // If the constant were inverted we would get 2/1.4826 = 1.349 as well by
    // coincidence at MAD=1, so check a case where MAD != 1:
    // baseline [0,10,20,30,40] → median 20, MAD 10. x = 40 → 0.6745*20/10 = 1.349
    expect(modifiedZ(40, [0, 10, 20, 30, 40])).toBeCloseTo(1.349, 3)
  })

  it('resists masking — a baseline containing virals still flags a bigger one', () => {
    // Two past virals would inflate mean/sigma enough to hide the new one.
    const baseline = [100, 120, 110, 90, 105, 50_000, 60_000, 95]
    const z = modifiedZ(30_000, baseline)
    expect(z).toBeGreaterThan(100) // median/MAD is unbothered by the two virals
  })

  it('falls back to classical z when MAD is 0', () => {
    expect(modifiedZ(10, [5, 5, 5, 5, 6])).toBeGreaterThan(0)
    expect(Number.isFinite(modifiedZ(10, [5, 5, 5, 5, 6]))).toBe(true)
  })

  it('returns 0 for a completely degenerate baseline', () => {
    expect(modifiedZ(10, [5, 5, 5, 5])).toBe(0)
  })
})

describe('viewsAtAge', () => {
  const snaps: Snapshot[] = [
    { ageHours: 1, viewCount: 1000 },
    { ageHours: 3, viewCount: 5000 },
    { ageHours: 6, viewCount: 9000 },
  ]

  it('interpolates linearly between snapshots', () => {
    expect(viewsAtAge(snaps, 2)).toBe(3000)
    expect(viewsAtAge(snaps, 4.5)).toBe(7000)
  })

  it('returns exact values at snapshot boundaries', () => {
    expect(viewsAtAge(snaps, 1)).toBe(1000)
    expect(viewsAtAge(snaps, 6)).toBe(9000)
  })

  it('refuses to extrapolate outside observed data', () => {
    expect(viewsAtAge(snaps, 0.5)).toBeNull()
    expect(viewsAtAge(snaps, 12)).toBeNull()
  })

  it('returns null with no snapshots', () => {
    expect(viewsAtAge([], 3)).toBeNull()
  })
})

describe('velocity and acceleration', () => {
  it('computes views per hour', () => {
    expect(velocity({ ageHours: 1, viewCount: 100 }, { ageHours: 3, viewCount: 500 })).toBe(200)
  })

  it('reports positive acceleration for a video still taking off', () => {
    const a = acceleration(
      { ageHours: 1, viewCount: 100 },
      { ageHours: 2, viewCount: 300 },
      { ageHours: 3, viewCount: 900 }
    )
    expect(a).toBeGreaterThan(0)
  })

  it('reports negative acceleration for a video that has peaked', () => {
    const a = acceleration(
      { ageHours: 1, viewCount: 100 },
      { ageHours: 2, viewCount: 900 },
      { ageHours: 3, viewCount: 1000 }
    )
    expect(a).toBeLessThan(0)
  })
})

describe('scoreVideo', () => {
  const snapshots: Snapshot[] = [
    { ageHours: 1, viewCount: 5_000 },
    { ageHours: 3, viewCount: 40_000 },
    { ageHours: 6, viewCount: 150_000 },
  ]
  const baseline = [800, 1200, 950, 1100, 700, 1300, 900, 1000, 1150, 850]

  it('scores a genuine breakout well above threshold', () => {
    const s = scoreVideo({ snapshots, baselineViewsAtAge: baseline, ageHours: 6 })
    expect(s).not.toBeNull()
    expect(s!.zScore).toBeGreaterThan(3.5)
    expect(s!.multiplierVsMedian).toBeGreaterThan(100)
    expect(s!.velocityVph).toBeGreaterThan(0)
  })

  it('refuses to score without enough baseline', () => {
    const thin = baseline.slice(0, MIN_BASELINE_N - 1)
    expect(scoreVideo({ snapshots, baselineViewsAtAge: thin, ageHours: 6 })).toBeNull()
  })

  it('refuses to score at an age it has no data for', () => {
    expect(scoreVideo({ snapshots, baselineViewsAtAge: baseline, ageHours: 168 })).toBeNull()
  })
})

describe('localWindow — regression: velocity must be local to the scored age', () => {
  // A video that grows explosively early then plateaus. Scoring it at age 3
  // must see the early acceleration, not the flat tail.
  const snaps: Snapshot[] = [
    { ageHours: 1, viewCount: 10_000 },
    { ageHours: 2, viewCount: 40_000 },
    { ageHours: 3, viewCount: 110_000 },
    { ageHours: 6, viewCount: 200_000 },
    { ageHours: 48, viewCount: 398_000 },
    { ageHours: 72, viewCount: 399_000 },
    { ageHours: 168, viewCount: 400_000 },
  ]
  const baseline = Array.from({ length: 20 }, (_, i) => 900 + i * 20)

  it('reports positive acceleration when scored young', () => {
    const s = scoreVideo({ snapshots: snaps, baselineViewsAtAge: baseline, ageHours: 3 })
    expect(s).not.toBeNull()
    expect(s!.acceleration).toBeGreaterThan(0)
    expect(s!.velocityVph).toBeGreaterThan(10_000)
  })

  it('reports non-positive acceleration once plateaued', () => {
    const s = scoreVideo({ snapshots: snaps, baselineViewsAtAge: baseline, ageHours: 168 })
    expect(s).not.toBeNull()
    expect(s!.acceleration).toBeLessThanOrEqual(0)
  })

  it('alerts on the young reading and not the plateaued one', () => {
    const young = scoreVideo({ snapshots: snaps, baselineViewsAtAge: baseline, ageHours: 3 })!
    const old = scoreVideo({ snapshots: snaps, baselineViewsAtAge: baseline, ageHours: 168 })!
    expect(shouldAlert(young, 110_000)).toBe(true)
    expect(shouldAlert(old, 400_000)).toBe(false)
  })
})

describe('shouldAlert', () => {
  const base = {
    ageHours: 6,
    zScore: 4.0,
    multiplierVsMedian: 120,
    velocityVph: 5000,
    acceleration: 200,
    baselineN: 30,
  }

  it('fires on a young, accelerating, high-z video', () => {
    expect(shouldAlert(base, 150_000)).toBe(true)
  })

  it('does not fire on a video that has already peaked', () => {
    expect(shouldAlert({ ...base, acceleration: -50 }, 150_000)).toBe(false)
  })

  it('does not fire below the noise floor', () => {
    expect(shouldAlert(base, 500)).toBe(false)
  })

  it('does not fire on an old video, however strong', () => {
    expect(shouldAlert({ ...base, ageHours: 48, zScore: 9 }, 5_000_000)).toBe(false)
  })
})

describe('tierForAge', () => {
  it('puts fresh videos in the 5-minute tier', () => {
    expect(tierForAge(0.5).intervalMinutes).toBe(5)
  })
  it('steps down as videos age', () => {
    expect(tierForAge(3).intervalMinutes).toBe(15)
    expect(tierForAge(12).intervalMinutes).toBe(30)
    expect(tierForAge(500).intervalMinutes).toBe(1440)
  })
  it('always returns a tier, however old', () => {
    expect(tierForAge(100_000)).toBeDefined()
  })
})
