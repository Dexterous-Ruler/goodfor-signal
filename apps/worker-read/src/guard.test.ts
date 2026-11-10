import { describe, it, expect } from 'vitest'
import { assertReadPlane, WRITE_PLANE_VARS } from './guard.js'

describe('assertReadPlane (read-plane isolation)', () => {
  it('throws if a write-plane secret is present', () => {
    expect(() => assertReadPlane({ TIKTOK_CLIENT_SECRET: 'live_secret' })).toThrow(/plane isolation/)
    expect(() => assertReadPlane({ TOKEN_ENCRYPTION_KEY: 'deadbeef' })).toThrow(/plane isolation/)
  })
  it('names the read plane and the offending var in the error', () => {
    expect(() => assertReadPlane({ TIKTOK_CLIENT_SECRET: 'x' })).toThrow(/worker-read/)
    expect(() => assertReadPlane({ TIKTOK_CLIENT_SECRET: 'x' })).toThrow(/TIKTOK_CLIENT_SECRET/)
  })
  it('treats a blank/whitespace value as absent (template placeholder)', () => {
    expect(() => assertReadPlane({ TIKTOK_CLIENT_SECRET: '' })).not.toThrow()
    expect(() => assertReadPlane({ TOKEN_ENCRYPTION_KEY: '   ' })).not.toThrow()
  })
  it('passes with a clean read-plane env (ENSEMBLEDATA_/APIFY_ are allowed here)', () => {
    expect(() => assertReadPlane({ ENSEMBLEDATA_TOKEN: 'ed', APIFY_TOKEN: 'ap' })).not.toThrow()
  })
  it('pins the guarded write-plane var list', () => {
    expect([...WRITE_PLANE_VARS]).toEqual(['TIKTOK_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'])
  })
})
