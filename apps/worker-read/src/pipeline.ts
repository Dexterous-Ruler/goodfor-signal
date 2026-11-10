import type { Db } from '@goodfor/db'
import type { TikTokVideo } from '@goodfor/tiktok-source'
import {
  AGE_GRID,
  DEFAULT_BASELINE_N,
  MIN_BASELINE_N,
  scoreVideo,
  shouldAlert,
  tierForAge,
  nextDueAt,
  viewsAtAge,
  type Snapshot,
} from '@goodfor/scoring'

const SLOT_MS = 5 * 60_000

/**
 * Flooring the snapshot timestamp is what makes ingestion idempotent: a
 * redelivered message inside the same slot collides on the primary key and is
 * a no-op. That is why at-least-once delivery is sufficient and there is no
 * dedupe table.
 */
export function slotFloor(d: Date = new Date()): string {
  return new Date(Math.floor(d.getTime() / SLOT_MS) * SLOT_MS).toISOString()
}

export const hoursSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3_600_000

export async function accountsDue(client: Db, limit = 25) {
  const { data: dueVideos, error } = await client
    .from('tracked_video')
    .select('competitor_account_id')
    .eq('tracking_active', true)
    .lte('due_at', new Date().toISOString())
    .limit(500)
  if (error) throw error

  const dueIds = new Set((dueVideos ?? []).map((r) => r.competitor_account_id))

  const { data: neverPolled, error: e2 } = await client
    .from('competitor_account')
    .select('id')
    .eq('is_tracked', true)
    .is('vendor_last_synced_at', null)
  if (e2) throw e2
  for (const r of neverPolled ?? []) dueIds.add(r.id)

  if (dueIds.size === 0) return []

  const { data, error: e3 } = await client
    .from('competitor_account')
    .select('id, platform_user_id, sec_uid, username')
    .in('id', [...dueIds])
    .eq('is_tracked', true)
    .limit(limit)
  if (e3) throw e3
  return data ?? []
}

export async function persistListing(client: Db, accountId: number, videos: TikTokVideo[]) {
  if (videos.length === 0) return { upserted: 0, snapshots: 0 }

  const { error: upErr } = await client.from('tracked_video').upsert(
    videos.map((v) => ({
      competitor_account_id: accountId,
      platform_video_id: v.platformVideoId,
      created_at_tiktok: v.createdAt.toISOString(),
      duration_s: v.durationS,
      description: v.description,
      music_id: v.musicId,
      hashtags: v.hashtags,
      tracking_active: true,
    })),
    { onConflict: 'platform_video_id', ignoreDuplicates: false }
  )
  if (upErr) throw upErr

  const { data: rows, error: selErr } = await client
    .from('tracked_video')
    .select('id, platform_video_id, created_at_tiktok')
    .in(
      'platform_video_id',
      videos.map((v) => v.platformVideoId)
    )
  if (selErr) throw selErr

  const idByPlatform = new Map((rows ?? []).map((r) => [r.platform_video_id, r.id]))
  const ts = slotFloor()

  const snapshots = videos
    .map((v) => {
      const id = idByPlatform.get(v.platformVideoId)
      if (id === undefined) return null
      return {
        video_id: id,
        ts,
        view_count: v.viewCount,
        like_count: v.likeCount,
        comment_count: v.commentCount,
        share_count: v.shareCount,
        favorites_count: v.favoritesCount,
      }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)

  const { error: snapErr } = await client
    .from('video_metric_snapshot')
    .upsert(snapshots, { onConflict: 'video_id,ts', ignoreDuplicates: true })
  if (snapErr) throw snapErr

  for (const r of rows ?? []) {
    const tier = tierForAge(hoursSince(r.created_at_tiktok)).tier
    const { error } = await client
      .from('tracked_video')
      .update({ poll_tier: tier, due_at: nextDueAt(tier).toISOString() })
      .eq('id', r.id)
    if (error) throw error
  }

  await client
    .from('competitor_account')
    .update({ vendor_last_synced_at: new Date().toISOString() })
    .eq('id', accountId)

  return { upserted: videos.length, snapshots: snapshots.length }
}

export async function loadSnapshots(client: Db, videoIds: number[]) {
  const out: { video_id: number; ts: string; view_count: number }[] = []
  // Chunked: PostgREST has a practical URL length ceiling on .in() filters.
  for (let i = 0; i < videoIds.length; i += 40) {
    const chunk = videoIds.slice(i, i + 40)
    const { data, error } = await client
      .from('video_metric_snapshot')
      .select('video_id, ts, view_count')
      .in('video_id', chunk)
      .order('ts', { ascending: true })
    if (error) throw error
    for (const r of data ?? []) {
      out.push({ video_id: r.video_id, ts: r.ts, view_count: Number(r.view_count) })
    }
  }
  return out
}

export interface AccountScoreResult {
  scored: number
  alerts: string[]
  reason: string | null
}

export async function scoreAccount(client: Db, accountId: number): Promise<AccountScoreResult> {
  const { data: videos, error } = await client
    .from('tracked_video')
    .select('id, created_at_tiktok, description')
    .eq('competitor_account_id', accountId)
    .eq('tracking_active', true)
    .order('created_at_tiktok', { ascending: false })
    .limit(DEFAULT_BASELINE_N + 20)
  if (error) throw error
  if (!videos || videos.length < MIN_BASELINE_N + 1) {
    return { scored: 0, alerts: [], reason: 'insufficient-history' }
  }

  const raw = await loadSnapshots(
    client,
    videos.map((v) => v.id)
  )

  const postedAt = new Map(videos.map((v) => [v.id, new Date(v.created_at_tiktok).getTime()]))
  const byVideo = new Map<number, Snapshot[]>()
  for (const r of raw) {
    const posted = postedAt.get(r.video_id)
    if (posted === undefined) continue
    const list = byVideo.get(r.video_id) ?? []
    list.push({
      ageHours: (new Date(r.ts).getTime() - posted) / 3_600_000,
      viewCount: r.view_count,
    })
    byVideo.set(r.video_id, list)
  }

  const alerts: string[] = []
  const enqueued = new Set<number>()
  let scored = 0

  for (const v of videos) {
    const snaps = byVideo.get(v.id)
    if (!snaps || snaps.length < 2) continue
    const ageNow = hoursSince(v.created_at_tiktok)

    for (const age of AGE_GRID) {
      if (age > ageNow) break

      const baseline: number[] = []
      for (const [otherId, otherSnaps] of byVideo) {
        if (otherId === v.id) continue
        const val = viewsAtAge(otherSnaps, age)
        if (val !== null) baseline.push(val)
      }
      if (baseline.length < MIN_BASELINE_N) continue

      const score = scoreVideo({ snapshots: snaps, baselineViewsAtAge: baseline, ageHours: age })
      if (!score) continue

      const { error: upErr } = await client.from('video_score').upsert(
        {
          video_id: v.id,
          age_hours: age,
          z_score: score.zScore,
          multiplier_vs_median: score.multiplierVsMedian,
          velocity_vph: score.velocityVph,
          acceleration: score.acceleration,
          baseline_n: score.baselineN,
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'video_id,age_hours' }
      )
      if (upErr) throw upErr
      scored++

      const current = snaps[snaps.length - 1]!.viewCount
      if (shouldAlert(score, current)) {
        const label = (v.description ?? '').slice(0, 48)
        // Pin the locale: toLocaleString() otherwise follows the host machine,
        // so the same alert renders differently on different servers.
        const vph = Math.round(score.velocityVph).toLocaleString('en-GB')
        alerts.push(
          `video ${v.id} "${label}" — z=${score.zScore.toFixed(2)}, ` +
            `${score.multiplierVsMedian.toFixed(1)}x median at ${age}h, ` +
            `${vph} views/hr, accelerating`
        )

        // Hand the alert off to the Phase-2 analysis worker as a durable row —
        // priority 0 jumps the corpus feed (reason='corpus', priority 5). We
        // ENQUEUE ONLY; the AI providers (ffmpeg + Groq + Gemini + minutes of
        // latency) run in apps/worker-analyse, never inline in this 60s poll.
        // ON CONFLICT (video_id) DO NOTHING via ignoreDuplicates; deduped within
        // this call so multiple age-grid hits enqueue a video at most once.
        if (!enqueued.has(v.id)) {
          enqueued.add(v.id)
          const { error: qErr } = await client
            .from('analysis_queue')
            .upsert(
              { video_id: v.id, priority: 0, reason: 'alert' },
              { onConflict: 'video_id', ignoreDuplicates: true }
            )
          if (qErr) throw qErr
        }
      }
    }
  }

  return { scored, alerts, reason: null }
}
