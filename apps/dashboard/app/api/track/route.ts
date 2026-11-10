import { db, readJson } from '../../../lib/write'

// Toggle whether a competitor account is actively tracked by the read-plane poll.
// POST /api/track  { username: string, tracked: boolean }
// This is a read-plane CRM write: flipping is_tracked pauses/resumes the vendor
// poll for that account. It never touches TikTok or write-plane secrets.
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = await readJson(req)
  const username = typeof body.username === 'string' ? body.username.replace(/^@/, '').trim() : ''
  const tracked = body.tracked !== false // default true
  if (!username) return Response.json({ error: 'username required' }, { status: 400 })

  const client = db()
  const { data, error } = await client
    .from('competitor_account')
    .update({ is_tracked: tracked })
    .eq('username', username)
    .select('id, username, is_tracked')
  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (!data || !data.length) return Response.json({ error: `no tracked account @${username}` }, { status: 404 })

  return Response.json({ ok: true, username, tracked: data[0]!.is_tracked })
}
