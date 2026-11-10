import { describe, it, expect } from 'vitest'
import { checkCadence, CADENCE_SOFT_MAX } from './cadence.js'

describe('checkCadence', () => {
  it('is clean at 1 post/day', () => {
    const r = checkCadence(1)
    expect(r.ok).toBe(true)
    expect(r.warn).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('is still ok at the ≤1–2 ceiling (2 posts)', () => {
    const r = checkCadence(2)
    expect(r.ok).toBe(true)
    expect(r.warn).toBe(false)
  })

  it('warns on the 3rd post/account/day (collinearity risk)', () => {
    const r = checkCadence(3)
    expect(r.ok).toBe(false)
    expect(r.warn).toBe(true)
    expect(r.reason).toMatch(/cadence/)
    expect(r.postsToday).toBe(3)
  })

  it('is not a hard block — the caller can override (ok=false is a warning)', () => {
    // The contract: warn=true / ok=false signals "over cadence", but callers
    // may still proceed; they must log the override. No throw here.
    expect(() => checkCadence(5)).not.toThrow()
    expect(checkCadence(5).warn).toBe(true)
  })

  it('honours a custom soft cap', () => {
    expect(checkCadence(2, { softMax: 1 }).warn).toBe(true)
    expect(CADENCE_SOFT_MAX).toBe(2)
  })
})
