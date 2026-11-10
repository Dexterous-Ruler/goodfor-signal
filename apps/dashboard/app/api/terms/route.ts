import { db, readJson } from '../../../lib/write'

// Tracked keywords / hashtags / sounds — the watchlist the read-plane trends
// worker polls (apps/worker-read/src/trends.ts). Read-plane CRM write only.
//   GET  /api/terms                                  -> list
//   POST /api/terms { term, termType, tracked? }      -> add / pause / resume
export const dynamic = 'force-dynamic'

const TERM_TYPES = ['keyword', 'hashtag', 'sound'] as const

export async function GET() {
  const client = db()
  const { data, error } = await client
    .from('tracked_term')
    .select('id, term, term_type, is_tracked, poll_interval_minutes, due_at, last_synced_at, added_at')
    .order('added_at', { ascending: false })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ terms: data ?? [], count: (data ?? []).length })
}

export async function POST(req: Request) {
  const b = await readJson(req)

  // "Poll now": make tracked terms due immediately so the next worker tick
  // re-polls them, instead of waiting out poll_interval_minutes.
  if (b.pollNow === true) {
    const client = db()
    let q = client.from('tracked_term').update({ due_at: new Date().toISOString() }).eq('is_tracked', true)
    if (typeof b.term === 'string' && b.term.trim()) q = q.eq('term', b.term.replace(/^#/, '').trim().toLowerCase())
    const { data, error } = await q.select('id, term, term_type')
    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json({ ok: true, queued: (data ?? []).length, terms: data ?? [] })
  }

  const termType = TERM_TYPES.includes(b.termType as (typeof TERM_TYPES)[number])
    ? (b.termType as string)
    : 'hashtag'
  // Normalise the same way the worker does: strip a leading #, trim, lowercase.
  const term = typeof b.term === 'string' ? b.term.replace(/^#/, '').trim().toLowerCase() : ''
  if (!term) return Response.json({ error: 'term required' }, { status: 400 })

  const client = db()

  // Pause / resume an existing term.
  if (b.tracked === false || b.tracked === true) {
    const { data, error } = await client
      .from('tracked_term')
      .update({ is_tracked: b.tracked })
      .eq('term', term)
      .eq('term_type', termType)
      .select('id, term, term_type, is_tracked')
    if (error) return Response.json({ error: error.message }, { status: 500 })
    if (!data || !data.length) return Response.json({ error: `not tracked: ${termType}:${term}` }, { status: 404 })
    return Response.json({ ok: true, ...data[0] })
  }

  // Add. due_at defaults to now() so the next worker tick picks it up.
  const { data, error } = await client
    .from('tracked_term')
    .upsert({ term, term_type: termType, is_tracked: true }, { onConflict: 'term,term_type', ignoreDuplicates: true })
    .select('id, term, term_type, is_tracked')
  if (error) return Response.json({ error: error.message }, { status: 500 })

  // ignoreDuplicates returns no row when it already existed — report it as existing.
  if (!data || !data.length) {
    return Response.json({ ok: true, term, termType, existing: true })
  }
  return Response.json({ ok: true, ...data[0], existing: false })
}
