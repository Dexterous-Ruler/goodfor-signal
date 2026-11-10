import { readFileSync } from 'node:fs'
import { db, loadEnv } from '@goodfor/db'
import type { TikTokVideo } from '@goodfor/tiktok-source'
import { persistListing, scoreAccount } from './apps/worker-read/src/pipeline.ts'

loadEnv()
const c = db()

interface Row {
  u: string; fu: number; nn: string; aid: string; id: string; t: string; ts: string
  v: number; l: number; c: number; s: number; f: number | null; d: number | null; m: string | null; tags: string[]
}
const rows: Row[] = JSON.parse(readFileSync('./_competitors.json', 'utf8'))

// 1. (opt-in) Clear the placeholder/demo graph (fixtures + mrbeast/khaby/zachking).
//    Destructive — only runs with PURGE=1 so the default ingest just ADDS real data.
if (process.env.PURGE === '1') {
  for (const [table, col] of [
    ['video_analysis', 'video_id'], ['video_score', 'video_id'], ['analysis_queue', 'video_id'],
    ['video_metric_snapshot', 'video_id'], ['tracked_video', 'id'], ['competitor_account', 'id'],
  ] as const) {
    const { error } = await c.from(table).delete().gte(col, 0)
    if (error) throw new Error(`clear ${table}: ${error.message}`)
  }
  console.log('cleared placeholder data (PURGE=1)')
}

// 2 + 3. Per account: upsert competitor_account, then persist its videos via the real pipeline.
const byUser = new Map<string, Row[]>()
for (const r of rows) (byUser.get(r.u) ?? byUser.set(r.u, []).get(r.u)!).push(r)

const toVideo = (r: Row): TikTokVideo => ({
  platformVideoId: r.id,
  createdAt: new Date(r.ts),
  description: r.t,
  musicId: r.m ?? null,
  hashtags: r.tags ?? [],
  durationS: r.d ?? null,
  viewCount: r.v ?? 0,
  likeCount: r.l ?? 0,
  commentCount: r.c ?? 0,
  shareCount: r.s ?? 0,
  favoritesCount: r.f ?? null,
  mediaUrl: null,
  coverUrl: null,
})

for (const [u, items] of byUser) {
  const head = items[0]!
  const { data: acct, error } = await c
    .from('competitor_account')
    .upsert(
      { platform_user_id: head.aid, username: u, display_name: head.nn, follower_count: head.fu, is_tracked: true },
      { onConflict: 'platform_user_id' }
    )
    .select('id')
    .single()
  if (error || !acct) throw new Error(`account ${u}: ${error?.message}`)
  const res = await persistListing(c, acct.id, items.map(toVideo))
  await scoreAccount(c, acct.id).catch(() => {})
  console.log(`@${u}  (${head.fu} followers) -> ${res.upserted} videos, ${res.snapshots} snapshots`)
}

// 4. Totals
const cnt = async (t: string) => (await c.from(t).select('*', { count: 'exact', head: true })).count
console.log(`TOTALS accounts=${await cnt('competitor_account')} videos=${await cnt('tracked_video')} snapshots=${await cnt('video_metric_snapshot')}`)
