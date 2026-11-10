import { toCsv } from '../../../lib/write'
import { getTopVideos, getTopAccounts, getAlerts } from '../../../lib/queries'

// CSV export of read-plane intelligence. GET /api/export?type=videos|competitors|alerts
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const type = new URL(req.url).searchParams.get('type') ?? 'videos'

  let rows: Record<string, unknown>[] = []
  if (type === 'competitors') {
    const top = await getTopAccounts()
    rows = top.map((a) => ({
      username: a.username,
      display_name: a.displayName ?? '',
      total_views: a.views,
      videos_tracked: a.videos,
    }))
  } else if (type === 'alerts') {
    const alerts = await getAlerts(50)
    rows = alerts.map((a) => ({
      username: a.username,
      z_score: a.zScore.toFixed(2),
      multiplier_vs_median: a.multiplier?.toFixed(2) ?? '',
      velocity_vph: a.velocityVph ? Math.round(a.velocityVph) : '',
      baseline_n: a.baselineN,
      age_hours: a.ageHours,
      posted_at: a.postedAt,
    }))
  } else if (type === 'videos') {
    const vids = await getTopVideos(100)
    rows = vids.map((v) => ({
      video_id: v.id,
      username: v.username,
      caption: v.caption ?? '',
      views: v.views,
      likes: v.likes,
      comments: v.comments,
      shares: v.shares,
      multiplier_vs_median: v.multiplier?.toFixed(2) ?? '',
      velocity_vph: v.velocityVph ? Math.round(v.velocityVph) : '',
      hook_type: v.hookType ?? '',
      duration_s: v.durationS ?? '',
      posted_at: v.postedAt,
    }))
  } else {
    return Response.json({ error: `unknown type "${type}"` }, { status: 400 })
  }

  const body = toCsv(rows)
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="goodfor-${type}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
