import { describe, it, expect } from 'vitest'
import { CtCodec, encodeBase36, decodeBase36, isValidCt, assertValidCt, CT_MAX_LEN } from './ct-codec.js'

describe('base36 round-trip', () => {
  it('encodes and decodes back to the same integer', () => {
    for (const n of [0, 1, 35, 36, 1000, 999999]) {
      expect(decodeBase36(encodeBase36(n))).toBe(n)
    }
  })
  it('rejects negatives / non-integers', () => {
    expect(() => encodeBase36(-1)).toThrow()
    expect(() => encodeBase36(1.5)).toThrow()
  })
})

describe('isValidCt / assertValidCt (≤30 alphanumeric)', () => {
  it('accepts 1–30 alphanumeric chars', () => {
    expect(isValidCt('a')).toBe(true)
    expect(isValidCt('a'.repeat(CT_MAX_LEN))).toBe(true)
  })
  it('rejects >30 chars', () => {
    expect(isValidCt('a'.repeat(31))).toBe(false)
    expect(() => assertValidCt('a'.repeat(31))).toThrow(/30/)
  })
  it('rejects non-alphanumeric', () => {
    expect(isValidCt('has-dash')).toBe(false)
    expect(isValidCt('has space')).toBe(false)
  })
})

describe('CtCodec', () => {
  it('assigns a stable code per key and round-trips', () => {
    const c = new CtCodec()
    const code = c.codeFor('format:talking_head')
    expect(c.codeFor('format:talking_head')).toBe(code) // stable
    expect(c.keyFor(code)).toBe('format:talking_head') // reverse
    expect(isValidCt(code)).toBe(true)
  })

  it('assigns distinct codes to distinct keys', () => {
    const c = new CtCodec()
    const a = c.codeFor('a')
    const b = c.codeFor('b')
    expect(a).not.toBe(b)
  })

  it('fires onAssign only for NEW keys, for persistence', () => {
    const assigned: [string, string][] = []
    const c = new CtCodec([], { onAssign: (k, code) => assigned.push([k, code]) })
    const code = c.codeFor('x')
    c.codeFor('x') // no second assign
    expect(assigned).toEqual([['x', code]])
  })

  it('seeds from persisted entries and never collides with them', () => {
    const c = new CtCodec([['legacy', 'z9']], { prefix: '', startSeq: 0 })
    expect(c.keyFor('z9')).toBe('legacy')
    // Auto-assigned codes must skip the seeded 'z9' if the counter ever reaches it.
    const fresh = c.codeFor('new')
    expect(fresh).not.toBe('z9')
    expect(isValidCt(fresh)).toBe(true)
  })

  it('respects a prefix and keeps codes ≤30 chars', () => {
    const c = new CtCodec([], { prefix: 'f' })
    const code = c.codeFor('k')
    expect(code.startsWith('f')).toBe(true)
    expect(code.length).toBeLessThanOrEqual(CT_MAX_LEN)
  })

  it('rejects an explicit register of an over-long code', () => {
    const c = new CtCodec()
    expect(() => c.register('k', 'a'.repeat(31))).toThrow(/30/)
  })

  it('refuses to remap a key or reuse a code', () => {
    const c = new CtCodec([['k', 'aa']])
    expect(() => c.register('k', 'bb')).toThrow(/already mapped/)
    expect(() => c.register('other', 'aa')).toThrow(/already used/)
  })
})
