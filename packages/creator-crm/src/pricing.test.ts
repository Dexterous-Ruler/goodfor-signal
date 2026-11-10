import { describe, it, expect } from 'vitest'
import {
  licenceCost,
  USAGE_MULTIPLIER_RANGE,
  WHITELIST_RATE_PER_MONTH,
  BUYOUT_MULTIPLIER_RANGE,
  CREATOR_VIDEO_RATE_RANGE_USD,
  type LicenceCostInput,
} from './pricing.js'

describe('licenceCost — §9.2 formula', () => {
  it('applies base_fee × (1 + usage + whitelist_rate × months + exclusivity)', () => {
    // 1000 × (1 + 0.4 + 0.3×2 + 0.25) = 1000 × 2.25 = 2250
    const cost = licenceCost({
      baseFee: 1000,
      usageMultiplier: 0.4,
      whitelistRate: 0.3,
      whitelistMonths: 2,
      exclusivityMultiplier: 0.25,
    })
    expect(cost).toBeCloseTo(2250, 6)
  })

  it('a bare licence with exclusivity 0 is just the base fee', () => {
    expect(licenceCost({ baseFee: 175, exclusivityMultiplier: 0 })).toBe(175)
  })

  it('optional add-ons default to zero (no whitelisting, no usage rights)', () => {
    expect(licenceCost({ baseFee: 200, usageMultiplier: 0.5, exclusivityMultiplier: 0 })).toBeCloseTo(300, 6)
  })
})

describe('exclusivity_multiplier has NO default', () => {
  it('is a required, typed field on the input', () => {
    // @ts-expect-error exclusivityMultiplier is required — omitting it must not typecheck.
    const bad: LicenceCostInput = { baseFee: 100 }
    void bad
  })

  it('throws at runtime when omitted (JS callers)', () => {
    // Force the omission past the type system to prove the runtime guard.
    expect(() => licenceCost({ baseFee: 100 } as unknown as LicenceCostInput)).toThrow(
      /exclusivityMultiplier is required/
    )
  })

  it('throws on a non-finite exclusivity multiplier', () => {
    expect(() =>
      licenceCost({ baseFee: 100, exclusivityMultiplier: Number.NaN })
    ).toThrow(/exclusivityMultiplier is required/)
  })
})

describe('no "50% of ask" rule exists', () => {
  it('does not halve, or apply any fixed ratio to, the base fee', () => {
    // A plain licence returns the base fee unchanged — never base × 0.5, never
    // base × 0.86. There is no ask/paid ratio encoded anywhere.
    for (const base of [100, 154, 180, 200, 300]) {
      expect(licenceCost({ baseFee: base, exclusivityMultiplier: 0 })).toBe(base)
    }
  })
})

describe('anchored constants are a negotiating range, not a formula', () => {
  it('exposes the strongest-verified licensing anchors', () => {
    expect(USAGE_MULTIPLIER_RANGE).toEqual({ min: 0.3, max: 0.5 })
    expect(WHITELIST_RATE_PER_MONTH).toBe(0.3)
    expect(BUYOUT_MULTIPLIER_RANGE).toEqual({ min: 2, max: 5 })
    expect(CREATOR_VIDEO_RATE_RANGE_USD).toEqual({ min: 150, max: 200 })
  })
})
