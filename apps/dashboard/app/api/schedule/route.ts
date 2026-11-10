import { db, readJson } from '../../../lib/write'

// Enqueue a post. This is the read->write handoff (completion.md §8.3): the
// dashboard only INSERTS a scheduled_post row as 'draft'/'queued'; the separate
// worker-write deployment (which alone holds TOKEN_ENCRYPTION_KEY and the TikTok
// client secret) drains it, runs creator_info -> init -> upload -> status, and
// the non-bypassable DB disclosure-gate trigger blocks any promotional post that
// lacks a verified disclosure. The dashboard never calls TikTok itself.
export const dynamic = 'force-dynamic'

const OAUTH_START =
  (process.env.WORKER_WRITE_OAUTH_URL ?? 'http://localhost:3100') + '/auth/tiktok/start'

export async function POST(req: Request) {
  const b = await readJson(req)
  const appSlug = typeof b.appSlug === 'string' && b.appSlug ? b.appSlug : 'goodfor'
  const client = db()

  // Need an OAuth-linked owned account to post from. Linking happens in
  // worker-write's isolated OAuth server, never here.
  let q = client.from('owned_account').select('id, username, account_type').limit(1)
  if (typeof b.ownedAccountId === 'number') q = client.from('owned_account').select('id, username, account_type').eq('id', b.ownedAccountId).limit(1)
  const { data: accts, error: acctErr } = await q
  if (acctErr) return Response.json({ error: acctErr.message }, { status: 500 })
  if (!accts || !accts.length) {
    return Response.json(
      {
        error: 'No TikTok account connected. Link one in worker-write first.',
        connectUrl: `${OAUTH_START}?app_slug=${encodeURIComponent(appSlug)}&account_type=business`,
        needsConnect: true,
      },
      { status: 409 },
    )
  }
  const account = accts[0]!

  const disclosureType =
    b.disclosureType === 'your_brand' || b.disclosureType === 'branded_content' ? b.disclosureType : 'none'
  const scheduledFor = typeof b.scheduledFor === 'string' ? b.scheduledFor : new Date().toISOString()

  const row = {
    owned_account_id: account.id,
    scheduled_for: scheduledFor,
    status: 'draft' as const,
    caption: typeof b.caption === 'string' ? b.caption : null,
    video_asset_url: typeof b.videoAssetUrl === 'string' ? b.videoAssetUrl : null,
    privacy_level: typeof b.privacyLevel === 'string' ? b.privacyLevel : 'SELF_ONLY',
    disclosure_type: disclosureType,
    disclosure_verified: disclosureType === 'none' ? true : b.disclosureVerified === true,
    disclosure_region: typeof b.disclosureRegion === 'string' ? b.disclosureRegion : null,
    sound_id: typeof b.soundId === 'string' ? b.soundId : null,
    sound_is_cml: b.soundIsCml === true,
    source_brief_id: typeof b.briefId === 'number' ? b.briefId : null,
    idempotency_key: `dash-${account.id}-${Date.now()}`,
  }

  const { data, error } = await client.from('scheduled_post').insert(row).select('id, status, scheduled_for').single()
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({
    ok: true,
    id: data.id,
    status: data.status,
    scheduledFor: data.scheduled_for,
    account: account.username,
    note: 'Queued as draft — worker-write will pick it up and publish via the TikTok inbox flow.',
  })
}

export async function GET() {
  const client = db()
  const { data, error } = await client
    .from('scheduled_post')
    .select('id, status, scheduled_for, caption, published_at, fail_reason')
    .order('scheduled_for', { ascending: false })
    .limit(25)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ posts: data ?? [] })
}
