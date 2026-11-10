import { describe, it, expect } from 'vitest'
import { computeCpi } from './cpi.js'

describe('computeCpi', () => {
  it('divides fully-loaded cost by incremental installs', () => {
    // $100.00 (10000c) over 40 incremental installs → $2.50 (250c)
    expect(computeCpi({ fullyLoadedCostCents: 10_000, incrementalInstalls: 40 })).toBe(250)
  })

  it('rounds to the nearest whole cent', () => {
    expect(computeCpi({ fullyLoadedCostCents: 1000, incrementalInstalls: 3 })).toBe(333)
  })

  it('throws on zero incremental installs (divide-by-zero guard)', () => {
    expect(() => computeCpi({ fullyLoadedCostCents: 10_000, incrementalInstalls: 0 })).toThrow(
      /inconclusive/
    )
  })

  it('throws on negative incremental installs', () => {
    expect(() => computeCpi({ fullyLoadedCostCents: 10_000, incrementalInstalls: -5 })).toThrow()
  })

  it('throws on a negative cost', () => {
    expect(() => computeCpi({ fullyLoadedCostCents: -1, incrementalInstalls: 10 })).toThrow(
      /non-negative/
    )
  })
})
