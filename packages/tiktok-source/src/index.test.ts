import { describe, it, expect } from 'vitest'
import { mapEnsembleVideo, mapApifyVideo, ApifyTikTokSource, FixtureSource, unwrapSearchItems, MediaOverrideSource, TikTokSourceError, extractEmail, type TikTokSource } from './index.js'

// A realistic EnsembleData "user posts" item, shaped from their documented
// aweme schema. This is the mapping README gap #1 flags as never verified live —
// these tests pin the contract so the first real response is trusted, not guessed.
const realItem = {
  aweme_id: '7300000000000000001',
  id: undefined,
  create_time: 1_719_792_000, // 2024-07-01 UTC
  desc: 'wait for it #fyp #dance',
  music: { id: 456789 },
  video: {
    duration: 15_000, // milliseconds
    // Two candidate URLs present — the no-watermark download must win.
    download_no_watermark_addr: { url_list: ['https://cdn.tiktok/nowm.mp4'] },
    play_addr: { url_list: ['https://cdn.tiktok/watermarked.mp4'] },
    cover: { url_list: ['https://cdn.tiktok/cover.jpg'] },
  },
  statistics: {
    play_count: 1_000_000,
    digg_count: 50_000,
    comment_count: 2_000,
    share_count: 800,
    collect_count: 300,
  },
  author: { uid: 'u1', sec_uid: 'sec1', unique_id: 'rival', nickname: 'Rival', follower_count: 120_000 },
}

describe('mapEnsembleVideo — live response contract', () => {
  it('maps a full EnsembleData item to the TikTokVideo contract', () => {
    const v = mapEnsembleVideo(realItem)!
    expect(v).not.toBeNull()
    expect(v.platformVideoId).toBe('7300000000000000001')
    expect(v.viewCount).toBe(1_000_000) // play_count -> viewCount
    expect(v.likeCount).toBe(50_000) // digg_count -> likeCount
    expect(v.commentCount).toBe(2_000)
    expect(v.shareCount).toBe(800)
    expect(v.favoritesCount).toBe(300) // collect_count -> favoritesCount
    expect(v.musicId).toBe('456789')
    expect(v.durationS).toBe(15) // 15000ms -> 15s
    expect(v.hashtags).toHaveLength(2)
    expect(v.createdAt.getUTCFullYear()).toBe(2024)
    expect(v.mediaUrl).toBe('https://cdn.tiktok/nowm.mp4') // prefers no-watermark
    expect(v.coverUrl).toBe('https://cdn.tiktok/cover.jpg')
  })

  it('accepts the alternate `id` field when `aweme_id` is absent', () => {
    const v = mapEnsembleVideo({ id: 'alt-1', statistics: { play_count: 5 } })!
    expect(v.platformVideoId).toBe('alt-1')
    expect(v.viewCount).toBe(5)
  })

  it('degrades gracefully on missing counters — no throw, zeros not NaN', () => {
    const v = mapEnsembleVideo({ aweme_id: 'x' })!
    expect(v.viewCount).toBe(0)
    expect(v.likeCount).toBe(0)
    expect(v.commentCount).toBe(0)
    expect(v.shareCount).toBe(0)
    expect(Number.isNaN(v.viewCount)).toBe(false)
    expect(v.favoritesCount).toBeNull()
    expect(v.musicId).toBeNull()
    expect(v.description).toBeNull()
    expect(v.durationS).toBeNull()
    expect(v.mediaUrl).toBeNull() // no video block -> no playable URL
    expect(v.coverUrl).toBeNull()
  })

  it('returns null for an item with no id (skipped, never scored)', () => {
    expect(mapEnsembleVideo({})).toBeNull()
    expect(mapEnsembleVideo(undefined)).toBeNull()
    expect(mapEnsembleVideo(null)).toBeNull()
  })
})

describe('FixtureSource — works with no vendor token', () => {
  it('returns a heavy-tailed set of videos with numeric counts', async () => {
    const res = await new FixtureSource().getUserPosts({ username: 'demo', depth: 3 })
    expect(res.videos.length).toBeGreaterThan(0)
    for (const v of res.videos) {
      expect(typeof v.viewCount).toBe('number')
      expect(Number.isNaN(v.viewCount)).toBe(false)
      expect(typeof v.platformVideoId).toBe('string')
      expect(v.mediaUrl).toBeNull() // fixtures carry no downloadable media
    }
    expect(res.profile.username).toBe('demo')
  })

  it('getPostMedia returns null — fixtures are never analysed', async () => {
    expect(await new FixtureSource().getPostMedia('https://www.tiktok.com/@x/video/1')).toBeNull()
  })
})

describe('mapApifyVideo — clockworks/free-tiktok-scraper contract', () => {
  it('maps a clockworks item, incl. the re-hosted media URL', () => {
    const v = mapApifyVideo({
      id: '7614544494150667542',
      text: 'go extra hard #fyp #work',
      createTimeISO: '2026-03-07T16:01:41.000Z',
      playCount: 99200,
      diggCount: 1729,
      commentCount: 93,
      shareCount: 298,
      collectCount: 1180,
      hashtags: [{ name: 'FYP' }, { name: 'work' }],
      musicMeta: { musicId: 7614544491634084630 },
      videoMeta: { duration: 48, coverUrl: 'https://cdn/cover.jpg' },
      mediaUrls: ['https://api.apify.com/v2/key-value-stores/x/records/v.mp4'],
      authorMeta: { id: 'a1', name: 'grapple_law', nickName: 'Grapple Law', fans: 2671 },
    })!
    expect(v.platformVideoId).toBe('7614544494150667542')
    expect(v.viewCount).toBe(99200)
    expect(v.favoritesCount).toBe(1180) // collectCount -> favoritesCount
    expect(v.durationS).toBe(48) // clockworks duration is already seconds
    expect(v.hashtags).toEqual(['fyp', 'work'])
    expect(v.mediaUrl).toBe('https://api.apify.com/v2/key-value-stores/x/records/v.mp4')
    expect(v.coverUrl).toBe('https://cdn/cover.jpg')
  })

  it('returns null for an item with no id, and needs a token to construct', () => {
    expect(mapApifyVideo({})).toBeNull()
    expect(() => new ApifyTikTokSource('')).toThrow()
    expect(new ApifyTikTokSource('tok').name).toBe('apify')
  })
})

// ---------------------------------------------------------------------------
// Search response unwrapping — regression for the silent "0 posts" bug.
//
// The live search endpoints nest results one level deeper than /tt/user/posts:
// { data: { nextCursor, data: [...] } }. Reading raw.data as an array returned
// [] for every tracked term, so trend tracking reported 0 posts / 0 views with
// no error. /tt/keyword/search additionally wraps each hit in `aweme_info`.
describe('unwrapSearchItems — live search response contract', () => {
  it('unwraps the nested hashtag shape { data: { data: [aweme] } }', () => {
    const raw = { data: { nextCursor: 20, data: [realItem] } }
    const items = unwrapSearchItems(raw)
    expect(items).toHaveLength(1)
    expect(mapEnsembleVideo(items[0])!.viewCount).toBe(1_000_000)
  })

  it('unwraps keyword hits that nest the aweme under aweme_info', () => {
    const raw = { data: { nextCursor: 20, data: [{ type: 1, aweme_info: realItem }] } }
    const items = unwrapSearchItems(raw)
    expect(items).toHaveLength(1)
    expect(mapEnsembleVideo(items[0])!.platformVideoId).toBe('7300000000000000001')
  })

  it('still accepts a flat array, and yields [] for an empty/absent payload', () => {
    expect(unwrapSearchItems({ data: [realItem] })).toHaveLength(1)
    expect(unwrapSearchItems({ data: { nextCursor: 0, data: [] } })).toHaveLength(0)
    expect(unwrapSearchItems({})).toHaveLength(0)
    expect(unwrapSearchItems(undefined)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Vendor failover. EnsembleData returns 493 "Subscription expired" (verified
// live) and 495 for a blown quota — both are account-level, so the read plane
// must swap vendors instead of retrying or stalling.
describe('MediaOverrideSource — vendor failover', () => {
  const video = mapEnsembleVideo(realItem)!
  const unavailable = (v: string) => new TikTokSourceError('subscription expired', v, 493, false, true)

  const stub = (name: string, impl: Partial<TikTokSource>): TikTokSource =>
    ({
      name,
      getUserPosts: async () => ({ profile: {} as never, videos: [] }),
      searchKeyword: async () => [],
      searchHashtag: async () => [],
      getPostMedia: async () => null,
      ...impl,
    }) as TikTokSource

  it('falls back to the media vendor when listings are vendor-unavailable', async () => {
    const dead = stub('dead', {
      searchHashtag: async () => { throw unavailable('dead') },
      searchKeyword: async () => { throw unavailable('dead') },
    })
    const alive = stub('alive', { searchHashtag: async () => [video], searchKeyword: async () => [video] })
    const src = new MediaOverrideSource(dead, alive)
    expect(await src.searchHashtag({ term: 'lawtok' })).toHaveLength(1)
    expect(await src.searchKeyword({ term: 'ai lawyer' })).toHaveLength(1)
  })

  it('does NOT fail over for an ordinary error — that would mask real bugs', async () => {
    const broken = stub('broken', {
      searchHashtag: async () => { throw new TikTokSourceError('bad request', 'broken', 400, false) },
    })
    const alive = stub('alive', { searchHashtag: async () => [video] })
    const src = new MediaOverrideSource(broken, alive)
    await expect(src.searchHashtag({ term: 'x' })).rejects.toThrow('bad request')
  })
})

// ---------------------------------------------------------------------------
// Creator discovery — the Modash Discovery replacement. Listing items already
// carry authorMeta, so folding them by creator yields a shortlist for free.
describe('extractEmail — public bio contact parsing', () => {
  it('pulls a business email out of a bio', () => {
    expect(extractEmail('NC | 3L law student. Business: partners@lawbymike.com')).toBe('partners@lawbymike.com')
    expect(extractEmail('dm me | courtney@clrmgmt.com.')).toBe('courtney@clrmgmt.com')
  })
  it('returns null rather than guessing', () => {
    expect(extractEmail('link in bio, dm for collabs')).toBeNull()
    expect(extractEmail('see lawbymike.com')).toBeNull() // a domain is not an address
    expect(extractEmail(null)).toBeNull()
    expect(extractEmail('')).toBeNull()
  })
})

describe('ApifyTikTokSource.discoverCreators — fold listings into creators', () => {
  const item = (name: string, fans: number, plays: number, diggs: number, signature = '') => ({
    id: String(Math.random()).slice(2),
    playCount: plays,
    diggCount: diggs,
    commentCount: 0,
    shareCount: 0,
    authorMeta: { id: 'u_' + name, name, nickName: name.toUpperCase(), fans, verified: true, signature },
  })

  it('dedupes by creator, aggregates their videos, and parses contact emails', async () => {
    const src = new ApifyTikTokSource('t')
    // Two videos from the same creator plus one from another.
    const payload = [
      item('lawbymike', 11_600_000, 1000, 100, 'biz: partners@lawbymike.com'),
      item('lawbymike', 11_600_000, 3000, 200),
      item('smallfry', 1000, 500, 50),
    ]
    ;(src as unknown as { runActor: () => Promise<unknown[]> }).runActor = async () => payload

    const creators = await src.discoverCreators({ term: 'lawtok', termType: 'hashtag' })
    expect(creators).toHaveLength(2)

    // Sorted by followers, so the big account leads.
    const mike = creators[0]!
    expect(mike.username).toBe('lawbymike')
    expect(mike.sampledVideos).toBe(2)
    expect(mike.sampledViews).toBe(4000)
    expect(mike.avgViews).toBe(2000)
    expect(mike.engagementRate).toBeCloseTo(7.5, 5) // 300 eng / 4000 views
    expect(mike.email).toBe('partners@lawbymike.com')
    expect(mike.profileUrl).toBe('https://www.tiktok.com/@lawbymike')

    expect(creators[1]!.username).toBe('smallfry')
    expect(creators[1]!.email).toBeNull()
  })

  it('skips items with no author and never divides by zero', async () => {
    const src = new ApifyTikTokSource('t')
    ;(src as unknown as { runActor: () => Promise<unknown[]> }).runActor = async () => [
      { id: '1', playCount: 0, diggCount: 0 },
      { id: '2', playCount: 0, diggCount: 0, authorMeta: { name: 'ghost', fans: 0 } },
    ]
    const creators = await src.discoverCreators({ term: 'x' })
    expect(creators).toHaveLength(1)
    expect(creators[0]!.engagementRate).toBeNull() // 0 views -> null, not NaN
  })
})
