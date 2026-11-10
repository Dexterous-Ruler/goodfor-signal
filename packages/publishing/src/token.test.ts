import { describe, it, expect } from 'vitest'
import { sealToken, openToken, PublishingKeyError } from './index.js'

// A deterministic, correctly-sized base64 key for tests (never a real key).
const KEY = Buffer.alloc(32, 7).toString('base64')
const OTHER_KEY = Buffer.alloc(32, 8).toString('base64')

describe('sealToken / openToken', () => {
  it('round-trips plaintext through AES-256-GCM', () => {
    const secret = 'act.example-access-token.abcdef0123456789'
    const sealed = sealToken(secret, KEY)
    expect(Buffer.isBuffer(sealed)).toBe(true)
    expect(openToken(sealed, KEY)).toBe(secret)
  })

  it('lays out ciphertext as iv(12) ‖ authTag(16) ‖ data', () => {
    const sealed = sealToken('x', KEY)
    // 12 + 16 + ciphertext(len of 'x' under GCM = 1)
    expect(sealed.length).toBe(12 + 16 + 1)
  })

  it('uses a fresh random iv per call (two seals of the same text differ)', () => {
    const a = sealToken('same', KEY)
    const b = sealToken('same', KEY)
    expect(a.equals(b)).toBe(false)
    expect(openToken(a, KEY)).toBe('same')
    expect(openToken(b, KEY)).toBe('same')
  })

  it('rejects a tampered ciphertext body (GCM tag fails)', () => {
    const sealed = sealToken('tamper-me', KEY)
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1]! ^= 0x01 // flip a bit in the data
    expect(() => openToken(tampered, KEY)).toThrow()
  })

  it('rejects a tampered auth tag', () => {
    const sealed = sealToken('tamper-tag', KEY)
    const tampered = Buffer.from(sealed)
    tampered[13]! ^= 0x01 // a byte inside the 16-byte tag region
    expect(() => openToken(tampered, KEY)).toThrow()
  })

  it('rejects the wrong key', () => {
    const sealed = sealToken('secret', KEY)
    expect(() => openToken(sealed, OTHER_KEY)).toThrow()
  })

  it('throws on a key that does not decode to 32 bytes', () => {
    const shortKey = Buffer.alloc(16, 1).toString('base64')
    expect(() => sealToken('x', shortKey)).toThrow(PublishingKeyError)
  })

  it('throws a clear error when no key is available', () => {
    const prev = process.env.TOKEN_ENCRYPTION_KEY
    delete process.env.TOKEN_ENCRYPTION_KEY
    try {
      expect(() => sealToken('x')).toThrow(/TOKEN_ENCRYPTION_KEY/)
    } finally {
      if (prev !== undefined) process.env.TOKEN_ENCRYPTION_KEY = prev
    }
  })
})
