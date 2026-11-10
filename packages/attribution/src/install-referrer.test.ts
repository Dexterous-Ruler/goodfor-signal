import { describe, it, expect } from 'vitest'
import { parseInstallReferrer, tryParseInstallReferrer, ReferrerParseError } from './install-referrer.js'

describe('parseInstallReferrer', () => {
  it('parses a well-formed tiktok referrer', () => {
    const r = parseInstallReferrer('utm_source=tiktok&utm_content=7412345678901234567')
    expect(r).toEqual({ utmSource: 'tiktok', videoId: '7412345678901234567' })
  })

  it('ignores extra params and percent-decodes', () => {
    const r = parseInstallReferrer('utm_source=tiktok&utm_medium=organic&utm_content=1234567890')
    expect(r.videoId).toBe('1234567890')
  })

  it('rejects an empty referrer', () => {
    expect(() => parseInstallReferrer('')).toThrow(ReferrerParseError)
    expect(() => parseInstallReferrer('   ')).toThrow(/empty/)
  })

  it('rejects an unknown source', () => {
    expect(() => parseInstallReferrer('utm_source=instagram&utm_content=1234567890')).toThrow(/utm_source/)
  })

  it('rejects a missing video id', () => {
    expect(() => parseInstallReferrer('utm_source=tiktok')).toThrow(/utm_content/)
  })

  it('rejects a non-numeric video id (privacy invariant)', () => {
    expect(() => parseInstallReferrer('utm_source=tiktok&utm_content=not-a-video')).toThrow(/video id/)
  })

  it('rejects PII in utm_content — an email', () => {
    let err: unknown
    try {
      parseInstallReferrer('utm_source=tiktok&utm_content=alice@example.com')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ReferrerParseError)
    expect((err as ReferrerParseError).reason).toBe('pii')
  })

  it('rejects a device advertising id shape (GAID/UUID) as PII', () => {
    expect(() =>
      parseInstallReferrer('utm_source=tiktok&utm_content=38400000-8cf0-11bd-b23e-10b96e40000d')
    ).toThrow(/PII/)
  })

  it('honours a custom allowed-source list', () => {
    const r = parseInstallReferrer('utm_source=youtube&utm_content=1234567890', {
      allowedSources: ['youtube'],
    })
    expect(r.utmSource).toBe('youtube')
  })
})

describe('tryParseInstallReferrer', () => {
  it('returns null instead of throwing on bad input', () => {
    expect(tryParseInstallReferrer('garbage')).toBeNull()
    expect(tryParseInstallReferrer('utm_source=tiktok&utm_content=42')).toBeNull() // too short
  })
  it('returns the parsed result on good input', () => {
    expect(tryParseInstallReferrer('utm_source=tiktok&utm_content=1234567890')).not.toBeNull()
  })
})
