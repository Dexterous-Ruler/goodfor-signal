import { describe, it, expect } from 'vitest'
import { assertWritePlane, READ_PLANE_VARS } from './guard.js'

describe('assertWritePlane (plane isolation)', () => {
  it('throws when a read-plane credential is present with a real value', () => {
    expect(() => assertWritePlane({ ENSEMBLEDATA_TOKEN: 'ed_live_123' })).toThrow(/plane isolation/)
    expect(() => assertWritePlane({ SCRAPECREATORS_API_KEY: 'sc_live_456' })).toThrow(
      /SCRAPECREATORS_API_KEY/
    )
  })

  it('names every offending var', () => {
    expect(() =>
      assertWritePlane({ ENSEMBLEDATA_TOKEN: 'a', SCRAPECREATORS_API_KEY: 'b' })
    ).toThrow(/ENSEMBLEDATA_TOKEN.*SCRAPECREATORS_API_KEY|SCRAPECREATORS_API_KEY.*ENSEMBLEDATA_TOKEN/)
  })

  it('treats a blank value (template placeholder) as absent', () => {
    expect(() => assertWritePlane({ ENSEMBLEDATA_TOKEN: '' })).not.toThrow()
    expect(() => assertWritePlane({ ENSEMBLEDATA_TOKEN: '   ' })).not.toThrow()
  })

  it('passes with a clean write-plane env (write-plane secrets are allowed here)', () => {
    expect(() =>
      assertWritePlane({ TIKTOK_CLIENT_SECRET: 'secret', TOKEN_ENCRYPTION_KEY: 'key' })
    ).not.toThrow()
  })

  it('guards exactly the two read-plane vars', () => {
    expect([...READ_PLANE_VARS]).toEqual(['ENSEMBLEDATA_TOKEN', 'SCRAPECREATORS_API_KEY'])
  })
})
