import { describe, it, expect } from 'vitest'
import {
  fitFormatLift,
  defaultLagKernel,
  solveLeastSquares,
  type FormatLiftDay,
} from './format-lift.js'

const iso = (day: number) => `2026-08-${String(day).padStart(2, '0')}`

describe('defaultLagKernel', () => {
  it('is normalised to sum 1 and front-loads day one (~72%)', () => {
    for (const L of [1, 2, 3]) {
      const k = defaultLagKernel(L)
      expect(k).toHaveLength(L)
      expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    }
    expect(defaultLagKernel(2)[0]).toBeCloseTo(0.72, 10)
  })
})

describe('solveLeastSquares', () => {
  it('recovers a known linear relationship exactly', () => {
    // y = 3 + 2*x
    const X = [
      [1, 1],
      [1, 2],
      [1, 5],
      [1, 9],
    ]
    const y = [5, 7, 13, 21]
    const beta = solveLeastSquares(X, y)
    expect(beta[0]).toBeCloseTo(3, 8)
    expect(beta[1]).toBeCloseTo(2, 8)
  })

  it('throws on a singular (collinear) system', () => {
    const X = [
      [1, 2],
      [2, 4],
    ]
    expect(() => solveLeastSquares(X, [1, 2])).toThrow(/singular/)
  })
})

describe('fitFormatLift', () => {
  it('recovers a known k on single-format synthetic data (lag 1)', () => {
    const baseline = 100
    const k = 0.05
    const viewSeq = [1000, 3000, 500, 8000, 2000, 6000, 4000, 1500, 9000, 700, 5000, 2500]
    const days: FormatLiftDay[] = viewSeq.map((v, i) => ({
      date: iso(i + 1),
      installs: baseline + k * v,
      viewsByFormat: { 1: v },
    }))

    const fit = fitFormatLift(days, { candidateLags: [1] })
    expect(fit.kByFormat[1]).toBeCloseTo(k, 6)
    expect(fit.baseline).toBeCloseTo(baseline, 4)
    expect(fit.rSquared).toBeCloseTo(1, 6)
    expect(fit.lagDays).toBe(1)
  })

  it('separates two non-collinear formats', () => {
    const kA = 0.03
    const kB = 0.1
    const viewsA = [1000, 2000, 500, 4000, 1500, 3000, 800, 2500, 900, 3500, 1200, 600]
    const viewsB = [200, 1500, 3000, 400, 2200, 100, 1800, 700, 2600, 300, 1900, 2400]
    const days: FormatLiftDay[] = viewsA.map((a, i) => ({
      date: iso(i + 1),
      installs: 50 + kA * a + kB * viewsB[i]!,
      viewsByFormat: { 1: a, 2: viewsB[i]! },
    }))

    const fit = fitFormatLift(days, { candidateLags: [1] })
    expect(fit.kByFormat[1]).toBeCloseTo(kA, 5)
    expect(fit.kByFormat[2]).toBeCloseTo(kB, 5)
    expect(fit.baseline).toBeCloseTo(50, 3)
  })

  it('throws when the two formats are perfectly collinear', () => {
    const viewsA = [1000, 2000, 500, 4000, 1500, 3000, 800, 2500]
    const days: FormatLiftDay[] = viewsA.map((a, i) => ({
      date: iso(i + 1),
      installs: 10 + 0.02 * a,
      viewsByFormat: { 1: a, 2: 2 * a }, // format 2 = 2× format 1 → singular
    }))
    expect(() => fitFormatLift(days, { candidateLags: [1] })).toThrow(/fit failed/)
  })

  it('throws when there is not enough data', () => {
    const days: FormatLiftDay[] = [
      { date: iso(1), installs: 100, viewsByFormat: { 1: 1000 } },
    ]
    expect(() => fitFormatLift(days, { candidateLags: [1] })).toThrow(/fit failed/)
  })
})
