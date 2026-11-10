import { db, readJson } from '../../../lib/write'

// Content Library — saved references (videos, creators, trends, briefs, sounds).
//   POST   /api/library  { kind, title, meta?, videoId?, creatorId?, briefId?, term?, tags?, collection? }
//   DELETE /api/library  { id }
//
// A saved item is a POINTER, never a copy: TikTok media URLs are signed and
// expire, so the library stores the reference and the note, and media is
// re-resolved at use time.
export const dynamic = 'force-dynamic'

const KINDS = ['video', 'creator', 'trend', 'brief', 'sound', 'hashtag', 'idea'] as const

export async function POST(req: Request) {
  const b = await readJson(req)
  const kind = KINDS.includes(b.kind as (typeof KINDS)[number]) ? (b.kind as string) : null
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!kind) return Response.json({ error: `kind must be one of ${KINDS.join(', ')}` }, { status: 400 })
  if (!title) return Response.json({ error: 'title required' }, { status: 400 })

  const row = {
    kind,
    title: title.slice(0, 300),
    meta: typeof b.meta === 'string' ? b.meta : null,
    video_id: typeof b.videoId === 'number' ? b.videoId : null,
    creator_id: typeof b.creatorId === 'number' ? b.creatorId : null,
    brief_id: typeof b.briefId === 'number' ? b.briefId : null,
    term: typeof b.term === 'string' ? b.term : null,
    tags: Array.isArray(b.tags) ? (b.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    collection: typeof b.collection === 'string' && b.collection.trim() ? b.collection.trim() : 'All saved',
    notes: typeof b.notes === 'string' ? b.notes : null,
  }

  const { data, error } = await db().from('library_item').insert(row).select('id, kind, title, collection').single()
  if (error) {
    // 23505 = the unique index on (kind, video_id): already saved, not an error
    // worth surfacing as a failure.
    if (error.code === '23505') return Response.json({ ok: true, alreadySaved: true })
    return Response.json({ error: error.message }, { status: 500 })
  }
  return Response.json({ ok: true, ...data })
}

export async function DELETE(req: Request) {
  const b = await readJson(req)
  const id = typeof b.id === 'number' ? b.id : null
  if (id == null) return Response.json({ error: 'id required' }, { status: 400 })
  const { error } = await db().from('library_item').delete().eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true, removed: id })
}
