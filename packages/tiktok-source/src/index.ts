/**
 * Vendor abstraction for TikTok competitor data.
 *
 * WHY THIS INTERFACE EXISTS (completion.md §11.5): no data vendor indemnifies
 * you against TikTok's ToS, so Goodfor carries the risk either way.
 * Switchability is therefore the mitigation — for a vendor being blocked,
 * going under, or being told to stop. Every TikTok read goes through here.
 *
 * COST-CRITICAL DESIGN (completion.md §4.2): getUserPosts returns videos WITH
 * their engagement counts, because profile listings already carry them. Never
 * add a "fetch metrics for video X" method — per-video metric calls cost 2
 * units each on EnsembleData and would move the bill from $200/mo to $800/mo.
 */

export interface TikTokProfile {
  platformUserId: string
  secUid: string | null
  username: string
  displayName: string | null
  followerCount: number | null
}

export interface TikTokVideo {
  platformVideoId: string
  createdAt: Date
  description: string | null
  musicId: string | null
  hashtags: string[]
  durationS: number | null
  viewCount: number
  likeCount: number
  commentCount: number
  shareCount: number
  favoritesCount: number | null
  /**
   * No-watermark playable URL, if the listing carried one. EPHEMERAL: TikTok CDN
   * URLs are signed and expire (the response literally has a `cdn_url_expired`
   * flag), so NEVER persist this as durable state — re-fetch a fresh one via
   * {@link TikTokSource.getPostMedia} at the moment you download for analysis.
   */
  mediaUrl: string | null
  /** Static thumbnail URL — also ephemeral. Handy for vision without the full clip. */
  coverUrl: string | null
}

export interface UserPostsResult {
  profile: TikTokProfile
  videos: TikTokVideo[]
}

/** Fresh, ephemeral media locations for a single post — from {@link TikTokSource.getPostMedia}. */
export interface PostMedia {
  mediaUrl: string
  coverUrl: string | null
  captionUrl: string | null
  durationS: number | null
}

export interface GetUserPostsOptions {
  /** Prefer secUid: costs one unit less per call than username on EnsembleData. */
  secUid?: string
  username?: string
  /** Pages of ~10 posts. depth 3 ≈ 30 most recent videos. */
  depth?: number
}

export interface SearchOptions {
  term: string
  /** Pages of ~20 results. */
  depth?: number
}

/**
 * A creator surfaced by discovery, with the engagement we could measure from the
 * videos that surfaced them. Replaces the Modash Discovery shortlist (§9.1) —
 * see `discoverCreators`.
 */
export interface TikTokCreator {
  platformUserId: string
  secUid: string | null
  username: string
  displayName: string | null
  bio: string | null
  bioLink: string | null
  /** Parsed out of the public bio. Null unless the creator published one. */
  email: string | null
  avatarUrl: string | null
  profileUrl: string | null
  verified: boolean
  followers: number | null
  following: number | null
  hearts: number | null
  videoCount: number | null
  /** How many of this creator's videos the discovery sample contained. */
  sampledVideos: number
  sampledViews: number
  /** Mean views across the sampled videos — the honest "avg views" signal. */
  avgViews: number | null
  /** (likes+comments+shares)/views across the sample, as a percentage. */
  engagementRate: number | null
}

export interface DiscoverCreatorsOptions {
  term: string
  termType?: 'keyword' | 'hashtag'
  /** Pages of ~10-20 results. Higher depth = more creators, more cost. */
  depth?: number
}

// Public bio emails only. Deliberately conservative: no obfuscated forms, no
// guessing from a domain — a wrong outreach address is worse than none.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/

export function extractEmail(bio: string | null | undefined): string | null {
  if (!bio) return null
  const m = EMAIL_RE.exec(bio)
  return m ? m[0].replace(/[.,;:]+$/, '') : null
}

export interface TikTokSource {
  readonly name: string
  getUserPosts(opts: GetUserPostsOptions): Promise<UserPostsResult>
  searchKeyword(opts: SearchOptions): Promise<TikTokVideo[]>
  searchHashtag(opts: SearchOptions): Promise<TikTokVideo[]>
  /**
   * Find creators posting about a term, with follower counts and the engagement
   * measurable from their sampled videos. This is the Modash-Discovery
   * replacement: the vendor listings we already pay for carry author data, so
   * discovery costs nothing beyond the search itself.
   */
  discoverCreators(opts: DiscoverCreatorsOptions): Promise<TikTokCreator[]>
  /**
   * Resolve fresh, playable media for ONE post by its canonical tiktok.com URL
   * (`https://www.tiktok.com/@<user>/video/<id>`). Costs ~1 unit, so it's for
   * the small set of videos actually being analysed — never bulk metric polling
   * (see the cost note atop this file). Returns null when the vendor can't
   * resolve it (private/removed) or has no downloadable media (FixtureSource).
   */
  getPostMedia(url: string): Promise<PostMedia | null>
}

export class TikTokSourceError extends Error {
  constructor(
    message: string,
    readonly vendor: string,
    readonly status?: number,
    readonly retryable = false,
    /**
     * The vendor itself cannot serve ANY request right now (expired
     * subscription, exhausted quota) — as opposed to this one call failing.
     * Signals the caller to fail over to another vendor rather than retry.
     */
    readonly vendorUnavailable = false
  ) {
    super(message)
    this.name = 'TikTokSourceError'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HASHTAG_RE = /#([\p{L}\p{N}_]+)/gu

export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return []
  return [...text.matchAll(HASHTAG_RE)].map((m) => m[1]!.toLowerCase())
}

/** TikTok timestamps are epoch SECONDS, not milliseconds. */
export function fromUnixSeconds(v: unknown): Date {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return new Date(0)
  return new Date(n * 1000)
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** TikTok media fields are `{ url_list: [cdn1, cdn2, …] }`; take the first live URL. */
function firstUrl(addr: unknown): string | null {
  const list = (addr as { url_list?: unknown } | undefined)?.url_list
  return Array.isArray(list) && typeof list[0] === 'string' ? list[0] : null
}

/**
 * Pick the most analysis-friendly playable URL from an EnsembleData `video`
 * object: prefer the no-watermark download, then the H.264 stream (widest ffmpeg
 * compatibility), then the default play address (often HEVC/bytevc1).
 */
function pickMediaUrl(video: unknown): string | null {
  const v = video as Record<string, unknown> | undefined
  if (!v) return null
  return (
    firstUrl(v.download_no_watermark_addr) ??
    firstUrl(v.play_addr_h264) ??
    firstUrl(v.play_addr) ??
    null
  )
}

// ---------------------------------------------------------------------------
// EnsembleData
// ---------------------------------------------------------------------------

/**
 * NOTE: the field mapping below is written from EnsembleData's documented
 * response shape but has NOT been validated against a live response — we have
 * no key yet. Run `npm run poll:once` against a real token and check
 * mapEnsembleVideo() before trusting any score computed from it.
 */
export class EnsembleDataSource implements TikTokSource {
  readonly name = 'ensembledata'
  private readonly base = 'https://ensembledata.com/apis'

  constructor(private readonly token: string) {
    if (!token) throw new Error('EnsembleDataSource requires a token')
  }

  private async get(path: string, params: Record<string, string | number>): Promise<unknown> {
    const url = new URL(this.base + path)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
    url.searchParams.set('token', this.token)

    const res = await fetch(url, { headers: { accept: 'application/json' } })

    // 493/495 are EnsembleData account-level states: the token is fine but the
    // account cannot serve requests. Verified live: 493 returns
    // {"detail":"Subscription expired. ..."}. Both must fail over, not retry.
    if (res.status === 493) {
      throw new TikTokSourceError(
        'subscription expired — renew at ensembledata.com',
        this.name,
        493,
        false,
        true
      )
    }
    if (res.status === 495) {
      throw new TikTokSourceError('daily unit quota exhausted', this.name, 495, false, true)
    }
    if (res.status === 429 || res.status >= 500) {
      throw new TikTokSourceError(`upstream ${res.status}`, this.name, res.status, true)
    }
    if (!res.ok) {
      throw new TikTokSourceError(`request failed: ${res.status}`, this.name, res.status, false)
    }
    return res.json()
  }

  async getUserPosts(opts: GetUserPostsOptions): Promise<UserPostsResult> {
    const depth = opts.depth ?? 3
    const params: Record<string, string | number> = { depth }

    // VERIFIED against the live API (2026-09): /tt/user/posts accepts either
    // sec_uid OR username. The documented `/tt/user/posts-from-username` 404s,
    // and the param is snake_case `sec_uid`. sec_uid is 1 unit cheaper (§4.2).
    if (opts.secUid) {
      params.sec_uid = opts.secUid
    } else if (opts.username) {
      params.username = opts.username
    } else {
      throw new TikTokSourceError('getUserPosts requires secUid or username', this.name)
    }

    const raw = (await this.get('/tt/user/posts', params)) as { data?: unknown }
    const items = Array.isArray(raw?.data) ? raw.data : []

    const videos = items.map(mapEnsembleVideo).filter((v): v is TikTokVideo => v !== null)
    const profile = mapEnsembleProfile(items[0], opts)

    return { profile, videos }
  }

  async searchKeyword({ term, depth = 1 }: SearchOptions): Promise<TikTokVideo[]> {
    const raw = await this.get('/tt/keyword/search', { name: term, period: 0, depth })
    return unwrapSearchItems(raw).map(mapEnsembleVideo).filter((v): v is TikTokVideo => v !== null)
  }

  async searchHashtag({ term, depth = 1 }: SearchOptions): Promise<TikTokVideo[]> {
    const raw = await this.get('/tt/hashtag/posts', { name: term, depth })
    return unwrapSearchItems(raw).map(mapEnsembleVideo).filter((v): v is TikTokVideo => v !== null)
  }

  /** Same fold as Apify, over EnsembleData's search payload. */
  async discoverCreators({ term, termType = 'hashtag', depth = 1 }: DiscoverCreatorsOptions): Promise<TikTokCreator[]> {
    const raw =
      termType === 'keyword'
        ? await this.get('/tt/keyword/search', { name: term, period: 0, depth })
        : await this.get('/tt/hashtag/posts', { name: term.replace(/^#/, ''), depth })
    const items = unwrapSearchItems(raw) as EnsembleItem[]

    type Agg = { a: NonNullable<EnsembleItem['author']>; videos: number; views: number; eng: number }
    const agg = new Map<string, Agg>()
    for (const it of items) {
      const a = it?.author
      const handle = a?.unique_id
      if (!a || !handle) continue
      const s = it.statistics ?? {}
      const cur: Agg = agg.get(handle) ?? { a, videos: 0, views: 0, eng: 0 }
      cur.videos += 1
      cur.views += num(s.play_count)
      cur.eng += num(s.digg_count) + num(s.comment_count) + num(s.share_count)
      agg.set(handle, cur)
    }

    return [...agg.values()]
      .map(({ a, videos, views, eng }) => {
        const extra = a as { signature?: string; avatar_larger?: { url_list?: string[] } }
        return {
          platformUserId: String(a.uid ?? a.unique_id),
          secUid: a.sec_uid ?? null,
          username: a.unique_id as string,
          displayName: a.nickname ?? null,
          bio: extra.signature ?? null,
          bioLink: null,
          email: extractEmail(extra.signature),
          avatarUrl: firstUrl(extra.avatar_larger),
          profileUrl: `https://www.tiktok.com/@${a.unique_id}`,
          verified: false,
          followers: a.follower_count ?? null,
          following: null,
          hearts: null,
          videoCount: null,
          sampledVideos: videos,
          sampledViews: views,
          avgViews: videos ? Math.round(views / videos) : null,
          engagementRate: views > 0 ? (eng / views) * 100 : null,
        }
      })
      .sort((x, y) => (y.followers ?? 0) - (x.followers ?? 0))
  }

  async getPostMedia(url: string): Promise<PostMedia | null> {
    // /tt/post/info returns the full aweme for one post by its tiktok.com URL,
    // carrying FRESH (re-signed) CDN addresses — verified live against the API.
    const raw = (await this.get('/tt/post/info', { url })) as { data?: unknown }
    const item = (Array.isArray(raw?.data) ? raw.data[0] : raw?.data) as EnsembleItem | undefined
    const v = item?.video
    const mediaUrl = pickMediaUrl(v)
    if (!mediaUrl) return null
    return {
      mediaUrl,
      coverUrl: firstUrl(v?.cover),
      captionUrl: null,
      durationS: v?.duration != null ? Math.round(num(v.duration) / 1000) : null,
    }
  }
}

interface EnsembleItem {
  aweme_id?: string
  id?: string
  desc?: string
  create_time?: number
  video?: {
    duration?: number
    play_addr?: { url_list?: string[] }
    play_addr_h264?: { url_list?: string[] }
    download_no_watermark_addr?: { url_list?: string[] }
    cover?: { url_list?: string[] }
  }
  music?: { id?: string | number }
  statistics?: {
    play_count?: number
    digg_count?: number
    comment_count?: number
    share_count?: number
    collect_count?: number
  }
  author?: {
    uid?: string
    sec_uid?: string
    unique_id?: string
    nickname?: string
    follower_count?: number
  }
}

/**
 * Unwrap an EnsembleData *search* response into a flat list of aweme objects.
 *
 * VERIFIED against the live API (2026-09): both `/tt/keyword/search` and
 * `/tt/hashtag/posts` return `{ data: { nextCursor, data: [...] } }` — the
 * payload is nested one level deeper than `/tt/user/posts`. Reading `raw.data`
 * as an array yields `[]`, which silently reported "0 posts" for every tracked
 * term instead of failing. Additionally, `/tt/keyword/search` wraps each result
 * as `{ type, aweme_info, ... }`, while `/tt/hashtag/posts` returns the aweme
 * directly. Both shapes (and a flat array, defensively) are handled here.
 */
export function unwrapSearchItems(raw: unknown): unknown[] {
  const outer = (raw as { data?: unknown } | undefined)?.data
  const items: unknown[] = Array.isArray(outer)
    ? outer
    : Array.isArray((outer as { data?: unknown } | undefined)?.data)
      ? ((outer as { data: unknown[] }).data)
      : []
  return items.map((it) => {
    const o = it as { aweme_info?: unknown } | null
    return o && typeof o === 'object' && o.aweme_info ? o.aweme_info : it
  })
}

export function mapEnsembleVideo(item: unknown): TikTokVideo | null {
  const it = item as EnsembleItem | undefined
  const id = it?.aweme_id ?? it?.id
  if (!it || !id) return null

  const s = it.statistics ?? {}
  return {
    platformVideoId: String(id),
    createdAt: fromUnixSeconds(it.create_time),
    description: it.desc ?? null,
    musicId: it.music?.id != null ? String(it.music.id) : null,
    hashtags: extractHashtags(it.desc),
    durationS: it.video?.duration != null ? Math.round(num(it.video.duration) / 1000) : null,
    viewCount: num(s.play_count),
    likeCount: num(s.digg_count),
    commentCount: num(s.comment_count),
    shareCount: num(s.share_count),
    favoritesCount: s.collect_count != null ? num(s.collect_count) : null,
    mediaUrl: pickMediaUrl(it.video),
    coverUrl: firstUrl(it.video?.cover),
  }
}

function mapEnsembleProfile(item: unknown, opts: GetUserPostsOptions): TikTokProfile {
  const a = (item as EnsembleItem | undefined)?.author
  return {
    platformUserId: a?.uid ?? opts.secUid ?? opts.username ?? 'unknown',
    secUid: a?.sec_uid ?? opts.secUid ?? null,
    username: a?.unique_id ?? opts.username ?? 'unknown',
    displayName: a?.nickname ?? null,
    followerCount: a?.follower_count != null ? num(a.follower_count) : null,
  }
}

// ---------------------------------------------------------------------------
// Fixture source — deterministic, no network, no spend
// ---------------------------------------------------------------------------

/**
 * Simulates an account whose videos follow a heavy-tailed view distribution,
 * with one deliberate breakout. Lets the whole pipeline run end to end before
 * any vendor contract exists, and gives the scoring tests a realistic shape.
 */
export class FixtureSource implements TikTokSource {
  readonly name = 'fixture'

  /** Fixtures never invent creators — discovery returns nothing offline. */
  async discoverCreators(_opts: DiscoverCreatorsOptions): Promise<TikTokCreator[]> {
    return []
  }

  constructor(private readonly seed = 42) {}

  private rand(n: number): number {
    // Deterministic LCG — no Math.random, so runs are reproducible.
    let x = (this.seed + n) * 1103515245 + 12345
    x = Math.abs(x % 2147483648)
    return x / 2147483648
  }

  async getUserPosts(opts: GetUserPostsOptions): Promise<UserPostsResult> {
    const username = opts.username ?? 'fixture_account'
    const count = (opts.depth ?? 3) * 10
    const now = Date.now()

    const videos: TikTokVideo[] = Array.from({ length: count }, (_, i) => {
      const ageHours = i * 6 + 1
      const isBreakout = i === 1
      const baseline = 800 + Math.floor(this.rand(i) * 600)
      const views = isBreakout ? 180_000 : baseline

      return {
        platformVideoId: `fixture_${username}_${i}`,
        createdAt: new Date(now - ageHours * 3_600_000),
        description: isBreakout
          ? 'POV: you finally found an app that does this #fyp #app'
          : `day ${i} of building in public #fyp`,
        musicId: `music_${i % 5}`,
        hashtags: isBreakout ? ['fyp', 'app'] : ['fyp'],
        durationS: 22 + (i % 15),
        viewCount: views,
        likeCount: Math.floor(views * 0.06),
        commentCount: Math.floor(views * 0.002),
        shareCount: Math.floor(views * 0.008),
        favoritesCount: Math.floor(views * 0.01),
        mediaUrl: null, // no downloadable clip — analysis skips fixtures by design
        coverUrl: null,
      }
    })

    return {
      profile: {
        platformUserId: `fixture_uid_${username}`,
        secUid: `fixture_secuid_${username}`,
        username,
        displayName: `Fixture ${username}`,
        followerCount: 24_800,
      },
      videos,
    }
  }

  async searchKeyword({ term }: SearchOptions): Promise<TikTokVideo[]> {
    const { videos } = await this.getUserPosts({ username: `kw_${term}`, depth: 1 })
    return videos
  }

  async searchHashtag({ term }: SearchOptions): Promise<TikTokVideo[]> {
    const { videos } = await this.getUserPosts({ username: `tag_${term}`, depth: 1 })
    return videos
  }

  async getPostMedia(_url: string): Promise<PostMedia | null> {
    return null // fixtures have no real media to download
  }
}

// ---------------------------------------------------------------------------
// Apify — clockworks/free-tiktok-scraper (the team's preferred vendor)
// ---------------------------------------------------------------------------

interface ApifyItem {
  id?: string
  aweme_id?: string
  text?: string
  createTimeISO?: string
  playCount?: number
  diggCount?: number
  commentCount?: number
  shareCount?: number
  collectCount?: number
  hashtags?: { name?: string }[]
  mediaUrls?: string[]
  musicMeta?: { musicId?: string | number }
  videoMeta?: { duration?: number; coverUrl?: string }
  authorMeta?: {
    id?: string
    name?: string
    nickName?: string
    fans?: number
    secUid?: string
    verified?: boolean
    signature?: string
    bioLink?: string | null
    avatar?: string
    profileUrl?: string
    following?: number
    heart?: number
    video?: number
  }
}

/** Map a clockworks/free-tiktok-scraper item to the TikTokVideo contract. */
export function mapApifyVideo(item: unknown): TikTokVideo | null {
  const it = item as ApifyItem | undefined
  const id = it?.id ?? it?.aweme_id
  if (!it || !id) return null
  return {
    platformVideoId: String(id),
    createdAt: it.createTimeISO ? new Date(it.createTimeISO) : new Date(0),
    description: it.text ?? null,
    musicId: it.musicMeta?.musicId != null ? String(it.musicMeta.musicId) : null,
    hashtags: (it.hashtags ?? [])
      .map((h) => h?.name)
      .filter((n): n is string => typeof n === 'string')
      .map((n) => n.toLowerCase()),
    // clockworks reports duration already in SECONDS (EnsembleData uses ms).
    durationS: it.videoMeta?.duration != null ? Math.round(num(it.videoMeta.duration)) : null,
    viewCount: num(it.playCount),
    likeCount: num(it.diggCount),
    commentCount: num(it.commentCount),
    shareCount: num(it.shareCount),
    favoritesCount: it.collectCount != null ? num(it.collectCount) : null,
    mediaUrl: it.mediaUrls?.[0] ?? null,
    coverUrl: it.videoMeta?.coverUrl ?? null,
  }
}

function mapApifyProfile(item: unknown, opts: GetUserPostsOptions): TikTokProfile {
  const a = (item as ApifyItem | undefined)?.authorMeta
  return {
    platformUserId: a?.id ?? opts.username ?? 'unknown',
    secUid: a?.secUid ?? opts.secUid ?? null,
    username: a?.name ?? opts.username ?? 'unknown',
    displayName: a?.nickName ?? null,
    followerCount: a?.fans != null ? num(a.fans) : null,
  }
}

export class ApifyTikTokSource implements TikTokSource {
  readonly name = 'apify'
  private readonly actor = 'clockworks~free-tiktok-scraper'

  constructor(private readonly token: string) {
    if (!token) throw new Error('ApifyTikTokSource requires an APIFY_TOKEN')
  }

  private async runActor(input: Record<string, unknown>): Promise<unknown[]> {
    const url = `https://api.apify.com/v2/acts/${this.actor}/run-sync-get-dataset-items?token=${encodeURIComponent(this.token)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    })
    if (res.status === 429 || res.status >= 500) {
      throw new TikTokSourceError(`apify upstream ${res.status}`, this.name, res.status, true)
    }
    if (!res.ok) {
      throw new TikTokSourceError(`apify request failed: ${res.status}`, this.name, res.status, false)
    }
    const data = (await res.json()) as unknown
    return Array.isArray(data) ? data : []
  }

  async getUserPosts(opts: GetUserPostsOptions): Promise<UserPostsResult> {
    const username = opts.username ?? opts.secUid
    if (!username) throw new TikTokSourceError('getUserPosts requires a username', this.name)
    const items = await this.runActor({
      profiles: [username],
      resultsPerPage: (opts.depth ?? 3) * 10,
      profileScrapeSections: ['videos'],
      profileSorting: 'latest',
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
    })
    const videos = items.map(mapApifyVideo).filter((v): v is TikTokVideo => v !== null)
    return { profile: mapApifyProfile(items[0], opts), videos }
  }

  async searchKeyword({ term, depth = 1 }: SearchOptions): Promise<TikTokVideo[]> {
    const items = await this.runActor({ searchQueries: [term], resultsPerPage: depth * 10, shouldDownloadVideos: false })
    return items.map(mapApifyVideo).filter((v): v is TikTokVideo => v !== null)
  }

  async searchHashtag({ term, depth = 1 }: SearchOptions): Promise<TikTokVideo[]> {
    const items = await this.runActor({ hashtags: [term.replace(/^#/, '')], resultsPerPage: depth * 10, shouldDownloadVideos: false })
    return items.map(mapApifyVideo).filter((v): v is TikTokVideo => v !== null)
  }

  /**
   * Discovery from listings we already pay for. Every search item carries
   * `authorMeta` (handle, follower count, bio, verified); folding those by
   * creator turns one hashtag/keyword search into a creator shortlist at no
   * cost beyond the search. Verified live: a 30-video #lawtok search yields
   * ~20 unique creators, ~45% of them publishing a contact email.
   */
  async discoverCreators({ term, termType = 'hashtag', depth = 1 }: DiscoverCreatorsOptions): Promise<TikTokCreator[]> {
    const input =
      termType === 'keyword'
        ? { searchQueries: [term], resultsPerPage: depth * 20, shouldDownloadVideos: false }
        : { hashtags: [term.replace(/^#/, '')], resultsPerPage: depth * 20, shouldDownloadVideos: false }
    const items = (await this.runActor(input)) as ApifyItem[]

    type Agg = { a: NonNullable<ApifyItem['authorMeta']>; videos: number; views: number; eng: number }
    const agg = new Map<string, Agg>()
    for (const it of items) {
      const a = it?.authorMeta
      if (!a?.name) continue
      const cur: Agg = agg.get(a.name) ?? { a, videos: 0, views: 0, eng: 0 }
      cur.videos += 1
      cur.views += num(it.playCount)
      cur.eng += num(it.diggCount) + num(it.commentCount) + num(it.shareCount)
      agg.set(a.name, cur)
    }

    return [...agg.values()]
      .map(({ a, videos, views, eng }) => ({
        platformUserId: String(a.id ?? a.name),
        secUid: a.secUid ?? null,
        username: a.name as string,
        displayName: a.nickName ?? null,
        bio: a.signature ?? null,
        bioLink: a.bioLink ?? null,
        email: extractEmail(a.signature),
        avatarUrl: a.avatar ?? null,
        profileUrl: a.profileUrl ?? `https://www.tiktok.com/@${a.name}`,
        verified: a.verified === true,
        followers: a.fans ?? null,
        following: a.following ?? null,
        hearts: a.heart ?? null,
        videoCount: a.video ?? null,
        sampledVideos: videos,
        sampledViews: views,
        avgViews: videos ? Math.round(views / videos) : null,
        engagementRate: views > 0 ? (eng / views) * 100 : null,
      }))
      .sort((x, y) => (y.followers ?? 0) - (x.followers ?? 0))
  }

  async getPostMedia(url: string): Promise<PostMedia | null> {
    // shouldDownloadVideos re-hosts the clip on Apify (mediaUrls) — a stable,
    // ffmpeg-fetchable MP4 — sidestepping EnsembleData's daily unit cap.
    const items = await this.runActor({
      postURLs: [url],
      shouldDownloadVideos: true,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
    })
    const it = items[0] as ApifyItem | undefined
    const mediaUrl = it?.mediaUrls?.[0]
    if (!mediaUrl) return null
    return {
      mediaUrl,
      coverUrl: it?.videoMeta?.coverUrl ?? null,
      captionUrl: null,
      durationS: it?.videoMeta?.duration != null ? Math.round(num(it.videoMeta.duration)) : null,
    }
  }
}

/**
 * Wraps a primary source but routes getPostMedia to a different vendor — so the
 * cheap bulk metric polling can stay on EnsembleData while the analyser fetches
 * playable media from Apify (free, and on a separate quota).
 */
export class MediaOverrideSource implements TikTokSource {
  readonly name: string
  constructor(
    private readonly listings: TikTokSource,
    private readonly media: TikTokSource
  ) {
    this.name = `${listings.name}+${media.name}-media`
  }
  /**
   * Run against the listings vendor, failing over to the media vendor when the
   * listings vendor is account-level unavailable (expired subscription, blown
   * quota). Both vendors implement the full TikTokSource contract, so the
   * fallback is a straight swap — it keeps ingestion alive on one vendor
   * outage instead of silently stalling the whole read plane.
   */
  private async withFailover<T>(op: string, run: (s: TikTokSource) => Promise<T>): Promise<T> {
    try {
      return await run(this.listings)
    } catch (err) {
      if (err instanceof TikTokSourceError && err.vendorUnavailable) {
        console.warn(
          `[tiktok-source] ${this.listings.name} unavailable (${err.message}) — ` +
            `failing over to ${this.media.name} for ${op}`
        )
        return await run(this.media)
      }
      throw err
    }
  }
  getUserPosts(o: GetUserPostsOptions): Promise<UserPostsResult> {
    return this.withFailover('getUserPosts', (s) => s.getUserPosts(o))
  }
  searchKeyword(o: SearchOptions): Promise<TikTokVideo[]> {
    return this.withFailover('searchKeyword', (s) => s.searchKeyword(o))
  }
  searchHashtag(o: SearchOptions): Promise<TikTokVideo[]> {
    return this.withFailover('searchHashtag', (s) => s.searchHashtag(o))
  }
  discoverCreators(o: DiscoverCreatorsOptions): Promise<TikTokCreator[]> {
    return this.withFailover('discoverCreators', (s) => s.discoverCreators(o))
  }
  getPostMedia(url: string): Promise<PostMedia | null> {
    return this.media.getPostMedia(url)
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSource(): TikTokSource {
  const ed = process.env.ENSEMBLEDATA_TOKEN
  const apify = process.env.APIFY_TOKEN
  // Both: EnsembleData for cheap bulk listings, Apify for playable media.
  if (ed && apify) return new MediaOverrideSource(new EnsembleDataSource(ed), new ApifyTikTokSource(apify))
  if (apify) return new ApifyTikTokSource(apify)
  if (ed) return new EnsembleDataSource(ed)
  // Never write fake competitor data into a real deployment: fail closed in prod.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[tiktok-source] No ENSEMBLEDATA_TOKEN / APIFY_TOKEN set in production — refusing to ' +
        'fall back to FixtureSource (fake data). Provision a real vendor token for the read plane.'
    )
  }
  console.warn('[tiktok-source] No ENSEMBLEDATA_TOKEN / APIFY_TOKEN set — using FixtureSource (no real data).')
  return new FixtureSource()
}
