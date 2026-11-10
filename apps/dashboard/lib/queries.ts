import { resolve } from 'node:path'
import { db, loadEnv } from '@goodfor/db'
import { DEFAULT_ALERT } from '@goodfor/scoring'

// Next only reads .env.local from the app directory, but in this monorepo it
// lives at the repo root. Load both, root first.
loadEnv(resolve(process.cwd(), '..', '..'))
loadEnv()

/**
 * Server-only. Uses the service-role client, which bypasses RLS — never import
 * this from a client component.
 */

export interface AlertRow {
  videoId: number
  ageHours: number
  zScore: number
  multiplier: number
  velocityVph: number
  acceleration: number
  baselineN: number
  computedAt: string
  description: string | null
  postedAt: string
  username: string
  displayName: string | null
}

export async function getAlerts(limit = 50): Promise<AlertRow[]> {
  const client = db()
  const { data, error } = await client
    .from('video_score')
    .select(
      `video_id, age_hours, z_score, multiplier_vs_median, velocity_vph, acceleration,
       baseline_n, computed_at,
       tracked_video!inner (
         description, created_at_tiktok,
         competitor_account!inner ( username, display_name, is_tracked )
       )`
    )
    // Only alert on accounts still being tracked. Untracking an account must
    // silence it: historical video_score rows survive (scores are never
    // deleted), so without this an untracked account keeps driving the ticker,
    // the AI brief and Command Center priorities forever.
    .eq('tracked_video.competitor_account.is_tracked', true)
    .gte('z_score', DEFAULT_ALERT.minZ)
    .lte('age_hours', DEFAULT_ALERT.maxAgeHours)
    .gt('acceleration', 0)
    .order('z_score', { ascending: false })
    .limit(limit)

  if (error) throw error

  return (data ?? []).map((r) => {
    const v = r.tracked_video as unknown as {
      description: string | null
      created_at_tiktok: string
      competitor_account: { username: string; display_name: string | null; is_tracked: boolean }
    }
    return {
      videoId: r.video_id,
      ageHours: r.age_hours,
      zScore: Number(r.z_score),
      multiplier: Number(r.multiplier_vs_median),
      velocityVph: Number(r.velocity_vph),
      acceleration: Number(r.acceleration),
      baselineN: r.baseline_n,
      computedAt: r.computed_at,
      description: v.description,
      postedAt: v.created_at_tiktok,
      username: v.competitor_account.username,
      displayName: v.competitor_account.display_name,
    }
  })
}

export interface TrendRow {
  term: string
  termType: string
  ts: string
  postCount: number | null
  viewCount: number | null
  velocity: number | null
  burstWeight: number | null
  state: string | null
}

/** Latest observation per tracked term. */
export async function getTrends(): Promise<TrendRow[]> {
  const client = db()
  const { data, error } = await client
    .from('keyword_trend')
    .select('term, term_type, ts, post_count, view_count, velocity, burst_weight, state')
    .order('ts', { ascending: false })
    .limit(400)
  if (error) throw error

  const seen = new Set<string>()
  const latest: TrendRow[] = []
  for (const r of data ?? []) {
    const key = `${r.term_type}:${r.term}`
    if (seen.has(key)) continue
    seen.add(key)
    latest.push({
      term: r.term,
      termType: r.term_type,
      ts: r.ts,
      postCount: r.post_count === null ? null : Number(r.post_count),
      viewCount: r.view_count === null ? null : Number(r.view_count),
      velocity: r.velocity === null ? null : Number(r.velocity),
      burstWeight: r.burst_weight === null ? null : Number(r.burst_weight),
      state: r.state,
    })
  }

  const order: Record<string, number> = { rising: 0, peaked: 1, bottoming: 2, decaying: 3 }
  return latest.sort((a, b) => {
    const d = (order[a.state ?? ''] ?? 9) - (order[b.state ?? ''] ?? 9)
    return d !== 0 ? d : (b.burstWeight ?? 0) - (a.burstWeight ?? 0)
  })
}

export interface AccountRow {
  id: number
  username: string
  displayName: string | null
  followerCount: number | null
  videoCount: number
  lastSynced: string | null
}

export async function getAccounts(): Promise<AccountRow[]> {
  const client = db()
  const { data, error } = await client
    .from('competitor_account')
    .select('id, username, display_name, follower_count, vendor_last_synced_at, tracked_video(count)')
    .eq('is_tracked', true)
    .order('username')
  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    followerCount: r.follower_count === null ? null : Number(r.follower_count),
    videoCount: (r.tracked_video as unknown as { count: number }[] | null)?.[0]?.count ?? 0,
    lastSynced: r.vendor_last_synced_at,
  }))
}

/**
 * Summed latest views per tracked-account id, keyed by account id. Mirrors the
 * getTopAccounts derivation (latest snapshot per video → sum by account) so the
 * accounts table can show a views column without a per-video call.
 */
export async function getAccountViews(): Promise<Record<number, number>> {
  const client = db()
  const [vidsRes, snapsRes] = await Promise.all([
    client.from('tracked_video').select('id, competitor_account_id'),
    client
      .from('video_metric_snapshot')
      .select('video_id, view_count, ts')
      .order('ts', { ascending: false })
      .limit(9000),
  ])
  const vidAcc = new Map((vidsRes.data ?? []).map((v) => [v.id, v.competitor_account_id]))
  const latest = new Map<number, number>()
  for (const s of snapsRes.data ?? []) if (!latest.has(s.video_id)) latest.set(s.video_id, Number(s.view_count))
  const byAcc: Record<number, number> = {}
  for (const [vid, views] of latest) {
    const aid = vidAcc.get(vid)
    if (aid == null) continue
    byAcc[aid] = (byAcc[aid] ?? 0) + views
  }
  return byAcc
}

export interface FormatRow {
  id: number
  label: string
  definition: string | null
  memberCount: number
  medianViews: number | null
  medianZ: number | null
}

export async function getFormats(): Promise<FormatRow[]> {
  const client = db()
  const { data, error } = await client
    .from('format_cluster')
    .select('id, label, definition, member_count, median_views, median_z')
    .order('member_count', { ascending: false })
  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id,
    label: r.label,
    definition: r.definition,
    memberCount: r.member_count,
    medianViews: r.median_views === null ? null : Number(r.median_views),
    medianZ: r.median_z === null ? null : Number(r.median_z),
  }))
}

export interface HookRow {
  hookType: string
  count: number
  medianZ: number | null
}

/**
 * Hook-type distribution joined to outperformance. This is the question the
 * whole analysis pipeline exists to answer: which openings actually work.
 */
export async function getHookPerformance(): Promise<HookRow[]> {
  const client = db()
  const { data, error } = await client
    .from('video_analysis')
    .select('video_id, hook_type')
    .not('hook_type', 'is', null)
    .limit(2000)
  if (error) throw error
  if (!data || data.length === 0) return []

  const ids = data.map((r) => r.video_id)
  const zByVideo = new Map<number, number>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data: scores } = await client
      .from('video_score')
      .select('video_id, z_score')
      .in('video_id', ids.slice(i, i + 100))
      .eq('age_hours', 6)
    for (const s of scores ?? []) {
      if (s.z_score !== null) zByVideo.set(s.video_id, Number(s.z_score))
    }
  }

  const buckets = new Map<string, number[]>()
  for (const r of data) {
    const key = r.hook_type as string
    const list = buckets.get(key) ?? []
    const z = zByVideo.get(r.video_id)
    if (z !== undefined) list.push(z)
    buckets.set(key, list)
  }

  const median = (xs: number[]) => {
    if (xs.length === 0) return null
    const s = [...xs].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
  }

  return [...buckets.entries()]
    .map(([hookType, zs]) => ({
      hookType,
      count: data.filter((r) => r.hook_type === hookType).length,
      medianZ: median(zs),
    }))
    .sort((a, b) => (b.medianZ ?? -99) - (a.medianZ ?? -99))
}

export async function getAnalysisProgress() {
  const client = db()
  const head = async (
    table: 'tracked_video' | 'video_analysis' | 'analysis_queue',
    filter?: (q: ReturnType<Db['from']>) => unknown
  ) => {
    let q = client.from(table).select('*', { count: 'exact', head: true })
    if (filter) q = filter(q as never) as never
    const { count } = await q
    return count ?? 0
  }

  const [videos, analysed] = await Promise.all([head('tracked_video'), head('video_analysis')])

  const { count: pending } = await client
    .from('analysis_queue')
    .select('*', { count: 'exact', head: true })
    .is('completed_at', null)

  const { data: costRows } = await client.from('video_analysis').select('cost_usd').limit(5000)
  const totalCost = (costRows ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)

  return { videos, analysed, pending: pending ?? 0, totalCost }
}

type Db = ReturnType<typeof db>

export async function getStats() {
  const client = db()
  const count = async (table: 'competitor_account' | 'tracked_video' | 'video_metric_snapshot') => {
    const { count: n } = await client.from(table).select('*', { count: 'exact', head: true })
    return n ?? 0
  }
  const [accounts, videos, snapshots] = await Promise.all([
    count('competitor_account'),
    count('tracked_video'),
    count('video_metric_snapshot'),
  ])
  return { accounts, videos, snapshots }
}

// ── Aggregates for the overview dashboard ──────────────────────────────

export interface MetricTotals {
  views: number; likes: number; comments: number; shares: number; engagement: number; videos: number
}

/** Latest snapshot per video, summed. */
export async function getMetricTotals(): Promise<MetricTotals> {
  const client = db()
  const { data, error } = await client
    .from('video_metric_snapshot')
    .select('video_id, view_count, like_count, comment_count, share_count, ts')
    .order('ts', { ascending: false })
    .limit(9000)
  if (error) throw error
  const seen = new Set<number>()
  let views = 0, likes = 0, comments = 0, shares = 0
  for (const r of data ?? []) {
    if (seen.has(r.video_id)) continue
    seen.add(r.video_id)
    views += Number(r.view_count); likes += Number(r.like_count)
    comments += Number(r.comment_count); shares += Number(r.share_count)
  }
  return { views, likes, comments, shares, engagement: likes + comments + shares, videos: seen.size }
}

export interface SeriesBucket { label: string; likes: number; comments: number; shares: number; views: number }

/** Snapshot volume bucketed evenly across its full time range (stacked bars + views line). */
export async function getMetricSeries(buckets = 14): Promise<SeriesBucket[]> {
  const client = db()
  const { data, error } = await client
    .from('video_metric_snapshot')
    .select('ts, view_count, like_count, comment_count, share_count')
    .order('ts', { ascending: true })
    .limit(9000)
  if (error) throw error
  const rows = data ?? []
  if (rows.length === 0) return []
  const t0 = new Date(rows[0]!.ts).getTime()
  const t1 = new Date(rows[rows.length - 1]!.ts).getTime()
  const span = Math.max(t1 - t0, 1)
  const acc = Array.from({ length: buckets }, () => ({ likes: 0, comments: 0, shares: 0, views: 0 }))
  for (const r of rows) {
    const i = Math.min(buckets - 1, Math.floor(((new Date(r.ts).getTime() - t0) / span) * buckets))
    acc[i]!.likes += Number(r.like_count); acc[i]!.comments += Number(r.comment_count)
    acc[i]!.shares += Number(r.share_count); acc[i]!.views += Number(r.view_count)
  }
  const fmt = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  return acc.map((b, i) => ({ label: fmt(t0 + (span * i) / buckets), ...b }))
}

export interface TopAccountRow { username: string; displayName: string | null; views: number; videos: number }

/** Owned-competitor accounts ranked by summed latest views. */
export async function getTopAccounts(): Promise<TopAccountRow[]> {
  const client = db()
  const [accsRes, vidsRes, snapsRes] = await Promise.all([
    // Untracked accounts (fixtures, paused competitors) must not appear in
    // leaderboards either - untracking is the one switch that silences an account.
    client.from('competitor_account').select('id, username, display_name').eq('is_tracked', true),
    client.from('tracked_video').select('id, competitor_account_id'),
    client.from('video_metric_snapshot').select('video_id, view_count, ts').order('ts', { ascending: false }).limit(9000),
  ])
  const accMap = new Map((accsRes.data ?? []).map((a) => [a.id, a]))
  const vidAcc = new Map((vidsRes.data ?? []).map((v) => [v.id, v.competitor_account_id]))
  const latest = new Map<number, number>()
  for (const s of snapsRes.data ?? []) if (!latest.has(s.video_id)) latest.set(s.video_id, Number(s.view_count))
  const byAcc = new Map<number, { views: number; videos: number }>()
  for (const [vid, views] of latest) {
    const aid = vidAcc.get(vid)
    // Skip videos whose account is untracked: accMap only holds tracked
    // accounts, so without this they aggregate into a nameless "-" row.
    if (aid == null || !accMap.has(aid)) continue
    const cur = byAcc.get(aid) ?? { views: 0, videos: 0 }
    cur.views += views; cur.videos += 1
    byAcc.set(aid, cur)
  }
  return [...byAcc.entries()]
    .map(([aid, v]) => {
      const a = accMap.get(aid)!
      return { username: a.username, displayName: a.display_name, views: v.views, videos: v.videos }
    })
    .sort((x, y) => y.views - x.views)
    .slice(0, 6)
}

export interface TopVideoRow {
  id: number
  username: string
  caption: string | null
  views: number
  likes: number
  comments: number
  shares: number
  durationS: number | null
  postedAt: string
  multiplier: number | null
  /**
   * Views over this account's OWN median views. Derived locally so the card can
   * rank and label relative performance before the scorer has produced a
   * multiplier. Distinct from `multiplier`, which is the scorer's age-matched
   * figure and is the one to trust once present.
   */
  relToAccountMedian?: number
  velocityVph: number | null
  hookType: string | null
}

/** Tracked videos ranked by latest views, enriched with velocity score + AI hook. */
export async function getTopVideos(limit = 5): Promise<TopVideoRow[]> {
  const client = db()
  const [vidsRes, snapsRes, accsRes, scoreRes, anaRes] = await Promise.all([
    client.from('tracked_video').select('id, description, created_at_tiktok, duration_s, competitor_account_id'),
    client.from('video_metric_snapshot').select('video_id, view_count, like_count, comment_count, share_count, ts').order('ts', { ascending: false }).limit(9000),
    client.from('competitor_account').select('id, username').eq('is_tracked', true),
    client.from('video_score').select('video_id, multiplier_vs_median, velocity_vph, computed_at').order('computed_at', { ascending: false }).limit(9000),
    client.from('video_analysis').select('video_id, hook_type'),
  ])
  const acc = new Map((accsRes.data ?? []).map((a) => [a.id, a.username]))
  const latest = new Map<number, { view_count: number; like_count: number; comment_count: number; share_count: number }>()
  for (const s of snapsRes.data ?? []) if (!latest.has(s.video_id)) latest.set(s.video_id, s)
  const score = new Map<number, { multiplier_vs_median: number | null; velocity_vph: number | null }>()
  for (const sc of scoreRes.data ?? []) if (!score.has(sc.video_id)) score.set(sc.video_id, sc)
  const hook = new Map((anaRes.data ?? []).map((a) => [a.video_id, a.hook_type]))
  const rows: TopVideoRow[] = []
  for (const v of vidsRes.data ?? []) {
    // `acc` only contains tracked accounts, so anything missing belongs to an
    // untracked one (fixtures, paused competitors) and must not surface.
    if (!acc.has(v.competitor_account_id)) continue
    const s = latest.get(v.id)
    if (!s) continue
    const sc = score.get(v.id)
    rows.push({
      id: v.id,
      username: acc.get(v.competitor_account_id)!,
      caption: v.description,
      views: Number(s.view_count),
      likes: Number(s.like_count),
      comments: Number(s.comment_count),
      shares: Number(s.share_count),
      durationS: v.duration_s,
      postedAt: v.created_at_tiktok,
      multiplier: sc?.multiplier_vs_median ?? null,
      velocityVph: sc?.velocity_vph ?? null,
      hookType: hook.get(v.id) ?? null,
    })
  }
  // RANK BY RELATIVE PERFORMANCE, NOT RAW VIEWS.
  //
  // Sorting by views lets benchmark accounts (@mrbeast, @zachking) with billions
  // of views permanently bury the competitors we actually track, whose videos
  // peak in the thousands - so the card showed celebrities instead of rivals.
  // Rank each video against ITS OWN account's median instead, which is the same
  // question the breakout scorer asks. Prefer the scorer's multiplier when it
  // exists; otherwise derive one here so the ranking works before scores land.
  const viewsByAccount = new Map<string, number[]>()
  for (const r of rows) {
    if (!viewsByAccount.has(r.username)) viewsByAccount.set(r.username, [])
    viewsByAccount.get(r.username)!.push(r.views)
  }
  const medianByAccount = new Map<string, number>()
  for (const [user, vals] of viewsByAccount) {
    const sorted = [...vals].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const med = sorted.length % 2 ? sorted[mid]! : ((sorted[mid - 1]! + sorted[mid]!) / 2)
    medianByAccount.set(user, med || 1)
  }
  const relative = (r: TopVideoRow): number =>
    r.multiplier ?? r.views / (medianByAccount.get(r.username) ?? 1)

  for (const r of rows) r.relToAccountMedian = r.views / (medianByAccount.get(r.username) ?? 1)

  return rows
    .sort((a, b) => relative(b) - relative(a) || b.views - a.views)
    .slice(0, limit)
}

export interface AccountPulse {
  username: string
  displayName: string | null
  followers: number | null
  avgViews: number
  engRate: number
  postsPerWeek: number
  videos: number
}

/** Top tracked accounts by average views, with follower/engagement/cadence — for the competitor pulse. */
export async function getAccountPulse(limit = 3): Promise<AccountPulse[]> {
  const client = db()
  const [accsRes, vidsRes, snapsRes] = await Promise.all([
    client.from('competitor_account').select('id, username, display_name, follower_count').eq('is_tracked', true).not('follower_count', 'is', null),
    client.from('tracked_video').select('id, competitor_account_id, created_at_tiktok'),
    client.from('video_metric_snapshot').select('video_id, view_count, like_count, comment_count, share_count, ts').order('ts', { ascending: false }).limit(9000),
  ])
  const latest = new Map<number, { views: number; eng: number }>()
  for (const s of snapsRes.data ?? []) if (!latest.has(s.video_id)) latest.set(s.video_id, { views: Number(s.view_count), eng: Number(s.like_count) + Number(s.comment_count) + Number(s.share_count) })
  const byAcc = new Map<number, { views: number; eng: number; videos: number; first: number; last: number }>()
  for (const v of vidsRes.data ?? []) {
    const s = latest.get(v.id)
    if (!s) continue
    const cur = byAcc.get(v.competitor_account_id) ?? { views: 0, eng: 0, videos: 0, first: Infinity, last: 0 }
    cur.views += s.views
    cur.eng += s.eng
    cur.videos += 1
    const t = new Date(v.created_at_tiktok).getTime()
    cur.first = Math.min(cur.first, t)
    cur.last = Math.max(cur.last, t)
    byAcc.set(v.competitor_account_id, cur)
  }
  const out: AccountPulse[] = []
  for (const a of accsRes.data ?? []) {
    const b = byAcc.get(a.id)
    if (!b || b.videos === 0) continue
    const weeks = Math.max(1, (b.last - b.first) / (7 * 864e5))
    out.push({
      username: a.username,
      displayName: a.display_name,
      followers: a.follower_count,
      avgViews: b.views / b.videos,
      engRate: b.views > 0 ? (b.eng / b.views) * 100 : 0,
      postsPerWeek: b.videos / weeks,
      videos: b.videos,
    })
  }
  return out.sort((x, y) => y.avgViews - x.avgViews).slice(0, limit)
}

export interface BriefSeed {
  /** FK to tracked_video — lets a generated brief link its inspiration. */
  videoId: number
  username: string
  views: number
  multiplier: number | null
  accelerating: boolean
  hookType: string | null
  formatSummary: string | null
  durationS: number | null
  baselineN: number
}

/** The single strongest current outperformer, for the AI Brief "WHAT" line. */
export async function getBriefSeed(): Promise<BriefSeed | null> {
  const alerts = await getAlerts(1)
  const a = alerts[0]
  if (!a) return null
  const client = db()
  const [snapRes, anaRes, vidRes] = await Promise.all([
    client.from('video_metric_snapshot').select('view_count, ts').eq('video_id', a.videoId).order('ts', { ascending: false }).limit(1),
    client.from('video_analysis').select('hook_type, format_summary').eq('video_id', a.videoId).maybeSingle(),
    client.from('tracked_video').select('duration_s').eq('id', a.videoId).maybeSingle(),
  ])
  return {
    videoId: a.videoId,
    username: a.username,
    views: Number(snapRes.data?.[0]?.view_count ?? 0),
    multiplier: a.multiplier,
    accelerating: a.acceleration > 0,
    hookType: anaRes.data?.hook_type ?? null,
    formatSummary: anaRes.data?.format_summary ?? null,
    durationS: vidRes.data?.duration_s ?? null,
    baselineN: a.baselineN,
  }
}
