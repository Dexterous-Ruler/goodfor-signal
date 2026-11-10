import { describe, it, expect } from 'vitest'
import { needsAlert, licenceStatus, licenceEnd, LICENCE_ALERT_WINDOW_DAYS } from './licence.js'

const NOW = new Date('2026-08-16T00:00:00Z')
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 3600_000).toISOString()

describe('licenceEnd', () => {
  it('adds a term in days to the start date', () => {
    const end = licenceEnd('2026-08-01T00:00:00Z', 30)
    expect(end.toISOString()).toBe('2026-08-31T00:00:00.000Z')
  })
})

describe('needsAlert — expired licence on a live deliverable (§9.5)', () => {
  it('fires TRUE when the licence has expired and the deliverable is live', () => {
    expect(needsAlert({ expires_at: days(-1) }, 'live', NOW)).toBe(true)
  })

  it('fires TRUE when the licence is near expiry (within the lead window) and live', () => {
    expect(needsAlert({ expires_at: days(3) }, 'live', NOW)).toBe(true)
  })

  it('is FALSE once the licence is extended well past the window', () => {
    expect(needsAlert({ expires_at: days(LICENCE_ALERT_WINDOW_DAYS + 30) }, 'live', NOW)).toBe(false)
  })

  it('is FALSE when the deliverable is not live, even if expired', () => {
    expect(needsAlert({ expires_at: days(-5) }, 'delivered', NOW)).toBe(false)
    expect(needsAlert({ expires_at: days(-5) }, 'paid', NOW)).toBe(false)
  })

  it('is FALSE for a perpetual grant (no expires_at)', () => {
    expect(needsAlert({ expires_at: null }, 'live', NOW)).toBe(false)
  })
})

describe('licenceStatus — reason + expiry detail', () => {
  it('reports expired with a negative daysUntilExpiry', () => {
    const s = licenceStatus({ expires_at: days(-2) }, 'live', NOW)
    expect(s.needsAlert).toBe(true)
    expect(s.expired).toBe(true)
    expect(s.daysUntilExpiry).toBeCloseTo(-2, 6)
    expect(s.reason).toMatch(/EXPIRED/)
  })

  it('clears the alert after extending expires_at', () => {
    const beforeExtend = licenceStatus({ expires_at: days(-2) }, 'live', NOW)
    expect(beforeExtend.needsAlert).toBe(true)
    const afterExtend = licenceStatus({ expires_at: days(90) }, 'live', NOW)
    expect(afterExtend.needsAlert).toBe(false)
    expect(afterExtend.reason).toBeNull()
  })
})
