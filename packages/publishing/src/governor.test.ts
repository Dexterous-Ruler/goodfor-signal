import { describe, it, expect } from 'vitest'
import {
  Governor,
  MAX_POSTS_PER_24H,
  MAX_IN_FLIGHT_UPLOADS,
  QUARANTINE_MS,
  type AccountPostingState,
} from './index.js'

const base: AccountPostingState = { postsLast24h: 0, uploadsInFlight: 0, quarantinedUntil: null }
const NOW = new Date('2026-08-16T12:00:00Z')

describe('Governor.canPost', () => {
  const gov = new Governor()

  it('allows a post when under every cap', () => {
    expect(gov.canPost(base, { now: NOW })).toEqual({ ok: true })
  })

  it('refuses the 13th post in 24h (cap is 12)', () => {
    const state = { ...base, postsLast24h: MAX_POSTS_PER_24H } // 12 already posted
    expect(gov.canPost(state, { now: NOW })).toEqual({ ok: false, reason: 'daily_cap' })
  })

  it('refuses the 5th in-flight upload (cap is 4)', () => {
    const state = { ...base, uploadsInFlight: MAX_IN_FLIGHT_UPLOADS } // 4 already in flight
    expect(gov.canPost(state, { now: NOW })).toEqual({ ok: false, reason: 'in_flight_cap' })
  })

  it('refuses while quarantined and clears once the window passes', () => {
    const until = new Date(NOW.getTime() + 60_000)
    const state = { ...base, quarantinedUntil: until }
    expect(gov.canPost(state, { now: NOW })).toEqual({ ok: false, reason: 'quarantined' })
    // after the window
    const later = new Date(until.getTime() + 1)
    expect(gov.canPost(state, { now: later })).toEqual({ ok: true })
  })

  it('honours X-RateLimit-Remaining/Reset', () => {
    const rl = { remaining: 0, resetAt: new Date(NOW.getTime() + 30_000) }
    expect(gov.canPost(base, { now: NOW, rateLimit: rl })).toEqual({ ok: false, reason: 'rate_limited' })
    // once reset has passed, remaining is moot
    const past = { remaining: 0, resetAt: new Date(NOW.getTime() - 1) }
    expect(gov.canPost(base, { now: NOW, rateLimit: past })).toEqual({ ok: true })
  })
})

describe('Governor.register', () => {
  it('reserves an in-flight slot without mutating the input', () => {
    const gov = new Governor()
    const next = gov.register(base)
    expect(next.uploadsInFlight).toBe(1)
    expect(base.uploadsInFlight).toBe(0)
  })
})

describe('Governor.onResult', () => {
  const gov = new Governor()

  it('quarantines 24h on any spam_risk_* and does NOT retry', () => {
    const state = { ...base, uploadsInFlight: 1 }
    const out = gov.onResult(state, { errorCode: 'spam_risk_user_banned_from_posting' }, { now: NOW })
    expect(out.quarantined).toBe(true)
    expect(out.retry).toBe(false)
    expect(out.state.quarantinedUntil?.getTime()).toBe(NOW.getTime() + QUARANTINE_MS)
    expect(out.state.uploadsInFlight).toBe(0) // slot released
    expect(out.state.postsLast24h).toBe(0) // a spam-blocked attempt is not a post
  })

  it('counts a success against the 24h cap and releases the slot', () => {
    const state = { ...base, uploadsInFlight: 1, postsLast24h: 3 }
    const out = gov.onResult(state, { success: true, errorCode: 'ok' }, { now: NOW })
    expect(out.quarantined).toBe(false)
    expect(out.state.postsLast24h).toBe(4)
    expect(out.state.uploadsInFlight).toBe(0)
  })

  it('marks a transient error retryable but a fatal one not', () => {
    const state = { ...base, uploadsInFlight: 1 }
    expect(gov.onResult(state, { errorCode: 'rate_limit_exceeded' }, { now: NOW }).retry).toBe(true)
    expect(gov.onResult(state, { errorCode: 'url_ownership_unverified' }, { now: NOW }).retry).toBe(false)
  })
})
