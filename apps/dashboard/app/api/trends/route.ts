import { db } from '../../../lib/write'

// Trend Radar feed. Real keyword/hashtag/sound momentum from `keyword_trend`,
// which the read-plane trends worker populates.
//
// Honesty note: keyword_trend carries volume + momentum only. Engagement rate
// and "Goodfor fit" have no read-plane source, so they are returned null rather
// than invented; the UI renders them as "—".
export const dynamic = 'force-dynamic'

const TYPE_GLYPH: Record<string, string> = { keyword: 'KW', hashtag: '#', sound: '♫' }

const abbr = (v: number): string =>
  v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v))

// keyword_trend.state -> the design's status vocabulary.
const STATE_LABEL: Record<string, string> = {
  rising: 'Rising',
  peaked: 'Hot',
  decaying: 'Declining',
  bottoming: 'Stable',
}

export async function GET() {
  const client = db()

  const { data: terms, error: tErr } = await client
    .from('tracked_term')
    .select('id, term, term_type, is_tracked, last_synced_at')
    .eq('is_tracked', true)
  if (tErr) return Response.json({ error: tErr.message }, { status: 500 })
  if (!terms || !terms.length) return Response.json({ trends: [], terms: 0, points: 0 })

  const { data: rows, error: kErr } = await client
    .from('keyword_trend')
    .select('tracked_term_id, term, term_type, ts, post_count, view_count, velocity, state')
    .in('tracked_term_id', terms.map((t) => t.id))
    .order('ts', { ascending: false })
    .limit(1000)
  if (kErr) return Response.json({ error: kErr.message }, { status: 500 })

  // Group newest-first per term.
  const byTerm = new Map<number, typeof rows>()
  for (const r of rows ?? []) {
    const k = r.tracked_term_id as number
    if (!byTerm.has(k)) byTerm.set(k, [])
    byTerm.get(k)!.push(r)
  }

  const trends = terms
    .map((t) => {
      const series = byTerm.get(t.id) ?? []
      if (!series.length) return null
      const latest = series[0]!
      const oldest = series[series.length - 1]!
      const from = Number(oldest.view_count ?? 0)
      const to = Number(latest.view_count ?? 0)
      // Growth over the retained window; null until there are 2+ points.
      const growth = series.length > 1 && from > 0 ? Math.round(((to - from) / from) * 100) : null
      const posts = Number(latest.post_count ?? 0)
      return {
        type: TYPE_GLYPH[t.term_type] ?? 'KW',
        name: t.term,
        growth,
        // post_count is the sampled page size (~20 at depth 1), not the term's
        // total post volume — so views across the sample is the real signal.
        vol: abbr(to),
        posts,
        views: abbr(to),
        // Competition proxied by how much reach the term already commands.
        // A proxy, not a measured creator count.
        comp: to >= 20e6 ? 'High' : to >= 5e6 ? 'Medium' : 'Low',
        // No read-plane source: engagement rate per term and Goodfor audience
        // fit both need signals we do not collect. Returned null, shown as "—".
        eng: null,
        fit: null,
        status: STATE_LABEL[String(latest.state ?? '')] ?? 'Stable',
        points: series.length,
        lastSyncedAt: t.last_synced_at,
        spark: series
          .slice(0, 12)
          .reverse()
          .map((s) => Number(s.view_count ?? 0)),
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b!.growth ?? -999) - (a!.growth ?? -999))

  return Response.json({
    trends,
    terms: terms.length,
    points: (rows ?? []).length,
    tracked: terms.map((t) => ({ term: t.term, termType: t.term_type, lastSyncedAt: t.last_synced_at })),
  })
}
