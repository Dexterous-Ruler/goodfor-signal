import { describe, it, expect } from 'vitest'
import { assertReadPlane, WRITE_PLANE_VARS } from './guard.js'

describe('assertReadPlane (worker-analyse plane isolation)', () => {
  it('throws if a write-plane secret bled into the analyse process', () => {
    expect(() => assertReadPlane({ TIKTOK_CLIENT_SECRET: 'live' })).toThrow(/plane isolation/)
    expect(() => assertReadPlane({ TOKEN_ENCRYPTION_KEY: 'k' })).toThrow(/worker-analyse/)
  })
  it('treats blank as absent and passes on a clean read-plane env', () => {
    expect(() => assertReadPlane({ TIKTOK_CLIENT_SECRET: '' })).not.toThrow()
    expect(() => assertReadPlane({ ENSEMBLEDATA_TOKEN: 'ed', APIFY_TOKEN: 'ap' })).not.toThrow()
  })
  it('pins the guarded write-plane var list', () => {
    expect([...WRITE_PLANE_VARS]).toEqual(['TIKTOK_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'])
  })
})
