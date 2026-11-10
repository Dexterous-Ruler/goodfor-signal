import { db, loadEnv } from '@goodfor/db'

loadEnv()

import { scoreAccount, slotFloor } from './pipeline.js'
import { AGE_GRID } from '@goodfor/scoring'

/**
 * Backfills a realistic multi-snapshot history so the scoring path can be
 * exercised end to end against the real database without waiting days for
 * organic polling to accumulate a baseline.
 *
 * Builds 30 videos on one account: 29 ordinary ones drawn from a tight
 * distribution, and one deliberate breakout. If the scorer is correct it
 * should flag exactly one video and stay silent on the other 29.
 *
 *   npx tsx apps/worker-read/src/demo.ts
 */

const ACCOUNT = 'demo_breakout_account'
const VIDEO_COUNT = 30
const BREAKOUT_INDEX = 3

// Deterministic LCG so runs are reproducible.
function rand(n: number): number {
  let x = (n + 1) * 1103515245 + 12345
  x = Math.abs(x % 2147483648)
  return x / 2147483648
}

/**
 * Ordinary videos follow a saturating exponential — fast at first, decelerating
 * throughout, plateauing within hours. That is the shape of a post that gets
 * its follower impressions and stops.
 *
 * The breakout follows a logistic S-curve: it ACCELERATES through the first
 * several hours as the For You feed widens distribution, then saturates. That
 * distinction is the whole basis of the alert rule — an alert should fire while
 * a video is still climbing, not once it has spent itself.
 */
function viewsAt(videoIndex: number, ageHours: number): number {
  if (videoIndex === BREAKOUT_INDEX) {
    const ceiling = 400_000
    const midpoint = 8 // hours to the inflection point
    const steepness = 0.4
    return Math.round(ceiling / (1 + Math.exp(-steepness * (ageHours - midpoint))))
  }
  const ceiling = 900 + Math.floor(rand(videoIndex) * 500)
  return Math.round(ceiling * (1 - Math.exp(-ageHours / 4)))
}

async function main() {
  const client = db()

  const { data: acct, error: acctErr } = await client
    .from('competitor_account')
    .upsert(
      {
        platform_user_id: `demo:${ACCOUNT}`,
        username: ACCOUNT,
        display_name: 'Demo Breakout Account',
        follower_count: 31_200,
        is_tracked: true,
      },
      { onConflict: 'platform_user_id' }
    )
    .select('id')
    .single()
  if (acctErr) throw acctErr
  const accountId = acct.id

  const now = Date.now()
  const maxAge = AGE_GRID[AGE_GRID.length - 1]!

  const videoRows = Array.from({ length: VIDEO_COUNT }, (_, i) => ({
    competitor_account_id: accountId,
    platform_video_id: `demo_${ACCOUNT}_${i}`,
    // All videos are older than the widest grid point, so every age is scoreable.
    created_at_tiktok: new Date(now - (maxAge + 24) * 3_600_000).toISOString(),
    duration_s: 20 + (i % 12),
    description:
      i === BREAKOUT_INDEX
        ? 'the one that took off #fyp'
        : `ordinary post ${i} #fyp`,
    music_id: `music_${i % 5}`,
    hashtags: ['fyp'],
    tracking_active: true,
  }))

  const { error: vErr } = await client
    .from('tracked_video')
    .upsert(videoRows, { onConflict: 'platform_video_id' })
  if (vErr) throw vErr

  const { data: stored, error: sErr } = await client
    .from('tracked_video')
    .select('id, platform_video_id, created_at_tiktok')
    .eq('competitor_account_id', accountId)
  if (sErr) throw sErr

  const snapshots: {
    video_id: number
    ts: string
    view_count: number
    like_count: number
    comment_count: number
    share_count: number
    favorites_count: number
  }[] = []

  for (const row of stored ?? []) {
    const idx = Number(row.platform_video_id.split('_').pop())
    const posted = new Date(row.created_at_tiktok).getTime()
    for (const age of AGE_GRID) {
      const views = viewsAt(idx, age)
      snapshots.push({
        video_id: row.id,
        ts: slotFloor(new Date(posted + age * 3_600_000)),
        view_count: views,
        like_count: Math.round(views * 0.06),
        comment_count: Math.round(views * 0.002),
        share_count: Math.round(views * 0.008),
        favorites_count: Math.round(views * 0.01),
      })
    }
  }

  for (let i = 0; i < snapshots.length; i += 200) {
    const { error } = await client
      .from('video_metric_snapshot')
      .upsert(snapshots.slice(i, i + 200), {
        onConflict: 'video_id,ts',
        ignoreDuplicates: true,
      })
    if (error) throw error
  }

  console.log(
    `Backfilled ${stored?.length ?? 0} videos x ${AGE_GRID.length} ages = ${snapshots.length} snapshots\n`
  )

  const { scored, alerts, reason } = await scoreAccount(client, accountId)
  console.log(`Scored ${scored} (video, age) pairs${reason ? ` (${reason})` : ''}`)
  console.log(`Alerts fired: ${alerts.length}\n`)
  for (const a of alerts) console.log(`  ALERT  ${a}`)

  const { data: top } = await client
    .from('video_score')
    .select('video_id, age_hours, z_score, multiplier_vs_median, baseline_n')
    .in('video_id', (stored ?? []).map((r) => r.id))
    .eq('age_hours', 6)
    .order('z_score', { ascending: false })
    .limit(5)

  console.log('\nTop 5 by z-score at age 6h:')
  for (const r of top ?? []) {
    console.log(
      `  video ${r.video_id}  z=${Number(r.z_score).toFixed(2).padStart(7)}  ` +
        `${Number(r.multiplier_vs_median).toFixed(1).padStart(7)}x median  (baseline n=${r.baseline_n})`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
