import { describe, it, expect } from 'vitest'
import { assertWritePlane, READ_PLANE_VARS } from './guard.js'

describe('assertWritePlane (creator-CRM plane isolation)', () => {
  it('throws when a read-plane credential is present with a real value', () => {
    expect(() => assertWritePlane({ ENSEMBLEDATA_TOKEN: 'ed_live_123' })).toThrow(/plane isolation/)
    expect(() => assertWritePlane({ SCRAPECREATORS_API_KEY: 'sc_live_456' })).toThrow(
      /SCRAPECREATORS_API_KEY/
    )
  })

  it('names the worker so the error is attributable', () => {
    expect(() => assertWritePlane({ ENSEMBLEDATA_TOKEN: 'x' })).toThrow(/worker-creators/)
  })

  it('treats a blank value (template placeholder) as absent', () => {
    expect(() => assertWritePlane({ ENSEMBLEDATA_TOKEN: '' })).not.toThrow()
    expect(() => assertWritePlane({ SCRAPECREATORS_API_KEY: '   ' })).not.toThrow()
  })

  it('passes with a clean write-plane env (MODASH_/HYPEAUDITOR_ secrets are allowed here)', () => {
    expect(() =>
      assertWritePlane({
        MODASH_API_KEY: 'md',
        HYPEAUDITOR_API_TOKEN: 'ha',
        TIKTOK_BUSINESS_ACCESS_TOKEN: 'bc',
      })
    ).not.toThrow()
  })

  it('guards exactly the two read-plane vars', () => {
    expect([...READ_PLANE_VARS]).toEqual(['ENSEMBLEDATA_TOKEN', 'SCRAPECREATORS_API_KEY'])
  })
})
