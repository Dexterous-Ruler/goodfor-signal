import { db, loadEnv, type Db } from '@goodfor/db'

import { assertReadPlane } from './guard.js'

loadEnv()
assertReadPlane()

import { createSource, type TikTokSource, type TikTokCreator } from '@goodfor/tiktok-source'

/**
 * Creator discovery — the Modash Discovery replacement (completion.md §9.1).
 *
 * WHY THIS LIVES IN THE READ PLANE: discovery runs on the scraping vendor, so
 * it must never share a process with the write plane's TikTok OAuth and payment
 * credentials (§1.3). `worker-creators` keeps the outreach/CRM half — stages,
 * rights, payments — which is where a licensed vendor key would belong. This
 * module only sources public profile data and parks it in `creator_account`.
 *
 * COST: the listings we already buy for trend tracking carry `authorMeta`, so a
 * creator shortlist is a fold over a search we were running anyway. Measured at
 * ~$0.09 per 30-video search yielding ~20 creators — against Modash's $199/mo
 * floor.
 *
 *   npx tsx apps/worker-read/src/creators.ts --once
 *   npx tsx apps/worker-read/src/creators.ts --term "ai lawyer" --type keyword
 */

const DEPTH = 2

async function trackedTerms(client: Db) {
  const { data, error } = await client
    .from('tracked_term')
    .select('term, term_type')
    .eq('is_tracked', true)
    .in('term_type', ['keyword', 'hashtag'])
  if (error) throw error
  return data ?? []
}

/**
 * Persist one creator. `creator_account` is keyed on (platform, platform_user_id)
 * — never the username, which changes (§9.5). Metrics are written to the account
 * row; the human behind it gets a `creator_identity` carrying the public contact
 * email so outreach has somewhere to start.
 */
async function persist(client: Db, c: TikTokCreator): Promise<'inserted' | 'updated'> {
  const { data: existing, error: exErr } = await client
    .from('creator_account')
    .select('id, creator_identity_id')
    .eq('platform', 'tiktok')
    .eq('platform_user_id', c.platformUserId)
    .maybeSingle()
  if (exErr) throw exErr

  let identityId = existing?.creator_identity_id ?? null
  if (!identityId) {
    const { data: ident, error: idErr } = await client
      .from('creator_identity')
      .insert({
        display_name: c.displayName ?? c.username,
        primary_email: c.email,
        notes: c.bio,
      })
      .select('id')
      .single()
    if (idErr) throw idErr
    identityId = ident.id
  } else if (c.email) {
    // Backfill a contact we did not have before; never overwrite a known one.
    await client
      .from('creator_identity')
      .update({ primary_email: c.email })
      .eq('id', identityId)
      .is('primary_email', null)
  }

  const row = {
    creator_identity_id: identityId,
    platform: 'tiktok',
    platform_user_id: c.platformUserId,
    username: c.username,
    url: c.profileUrl,
    followers: c.followers,
    engagement_rate: c.engagementRate,
    avg_views: c.avgViews,
    is_verified: c.verified,
    source_vendor: 'apify',
    vendor_last_synced_at: new Date().toISOString(),
  }

  const { error: upErr } = await client
    .from('creator_account')
    .upsert(row, { onConflict: 'platform,platform_user_id' })
  if (upErr) throw upErr
  return existing ? 'updated' : 'inserted'
}

async function discoverFor(
  client: Db,
  source: TikTokSource,
  term: string,
  termType: 'keyword' | 'hashtag',
): Promise<void> {
  const creators = await source.discoverCreators({ term, termType, depth: DEPTH })
  let ins = 0
  let upd = 0
  let withEmail = 0
  for (const c of creators) {
    try {
      const r = await persist(client, c)
      if (r === 'inserted') ins++
      else upd++
      if (c.email) withEmail++
    } catch (err) {
      console.error(`  ! ${c.username}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(
    `  ${(termType + ':' + term).padEnd(26)} ${creators.length} creators  ` +
      `(${ins} new, ${upd} updated, ${withEmail} with email)`,
  )
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const client = db()
  const source = createSource()

  const termFlag = argv.indexOf('--term')
  if (termFlag !== -1 && argv[termFlag + 1]) {
    const typeFlag = argv.indexOf('--type')
    const termType = (typeFlag !== -1 && argv[typeFlag + 1] === 'keyword' ? 'keyword' : 'hashtag') as
      | 'keyword'
      | 'hashtag'
    console.log(`[creators] discovering via ${source.name}`)
    await discoverFor(client, source, argv[termFlag + 1]!, termType)
    return
  }

  const terms = await trackedTerms(client)
  if (!terms.length) {
    console.log('[creators] no tracked terms — add one on Trend Radar first')
    return
  }
  console.log(`[creators] discovering across ${terms.length} tracked term(s) via ${source.name}`)
  for (const t of terms) {
    try {
      await discoverFor(client, source, t.term, t.term_type === 'keyword' ? 'keyword' : 'hashtag')
    } catch (err) {
      console.error(`  ! ${t.term_type}:${t.term} FAILED - ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
