import { describe, it, expect } from 'vitest'
import {
  fakeFollowerGate,
  erViews,
  rankByErViews,
  tierForFollowers,
  classifyErViews,
  ER_VIEWS_MEDIAN_BAND,
  type RankableCreator,
} from './vetting.js'

describe('fakeFollowerGate — hire <25%, avoid >50% (§9.4)', () => {
  it('hires below 25% fake', () => {
    expect(fakeFollowerGate(0)).toBe('hire')
    expect(fakeFollowerGate(24.9)).toBe('hire')
  })

  it('gates exactly at the 25% boundary to review (not hire)', () => {
    expect(fakeFollowerGate(25)).toBe('review')
  })

  it('reviews the 25–50% band', () => {
    expect(fakeFollowerGate(30)).toBe('review')
    expect(fakeFollowerGate(50)).toBe('review')
  })

  it('gates above the 50% boundary to avoid', () => {
    expect(fakeFollowerGate(50.1)).toBe('avoid')
    expect(fakeFollowerGate(80)).toBe('avoid')
  })
})

describe('erViews — views denominator, never followers (§9.4)', () => {
  it('computes (likes + comments + shares) / views × 100', () => {
    // (600 + 300 + 100) / 10000 × 100 = 10
    expect(erViews({ likes: 600, comments: 300, shares: 100, views: 10_000 })).toBeCloseTo(10, 6)
  })

  it('returns 0 for zero/missing views (no infinite rate)', () => {
    expect(erViews({ likes: 5, comments: 5, shares: 5, views: 0 })).toBe(0)
  })
})

describe('tierForFollowers + band classification', () => {
  it('buckets followers into tiers', () => {
    expect(tierForFollowers(5_000)).toBe('nano')
    expect(tierForFollowers(50_000)).toBe('micro')
    expect(tierForFollowers(250_000)).toBe('mid')
    expect(tierForFollowers(750_000)).toBe('macro')
    expect(tierForFollowers(2_000_000)).toBe('mega')
  })

  it('classifies er_views against the 6–8% micro band', () => {
    expect(ER_VIEWS_MEDIAN_BAND.micro).toEqual({ min: 6, max: 8 })
    expect(classifyErViews(4, 'micro')).toBe('below')
    expect(classifyErViews(7, 'micro')).toBe('in_band')
    expect(classifyErViews(12, 'micro')).toBe('above')
  })
})

describe('rankByErViews — ranks on er_views descending', () => {
  it('orders creators by engagement, best first, annotated with tier + band', () => {
    const creators: RankableCreator[] = [
      { followers: 50_000, likes: 200, comments: 50, shares: 50, views: 10_000 }, // er_views 3 (below)
      { followers: 50_000, likes: 600, comments: 200, shares: 100, views: 10_000 }, // er_views 9 (above)
      { followers: 50_000, likes: 500, comments: 100, shares: 100, views: 10_000 }, // er_views 7 (in_band)
    ]
    const ranked = rankByErViews(creators)
    expect(ranked.map((r) => Math.round(r.erViews))).toEqual([9, 7, 3])
    expect(ranked[0]!.band).toBe('above')
    expect(ranked[1]!.band).toBe('in_band')
    expect(ranked[2]!.band).toBe('below')
    expect(ranked[0]!.tier).toBe('micro')
  })
})
