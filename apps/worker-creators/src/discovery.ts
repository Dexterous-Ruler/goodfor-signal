/**
 * Discovery (PHASE-5-scale-creators.md §Work-breakdown 5, §9.1/§9.5).
 *
 * Runs saved Modash Discovery searches and persists the shortlist. THREE schema
 * rules are enforced here:
 *
 *  1. DEDUPE ON platform_user_id, NEVER username (§9.5). A creator whose handle
 *     changed still resolves to the same `creator_account` via
 *     (platform, platform_user_id); a new identity is created ONLY for a
 *     genuinely new platform_user_id.
 *  2. PERSIST credibility IMMEDIATELY (§9.1). The Modash search response carries
 *     `credibility` (query-time-only); it is written straight into
 *     `creator_audience.credibility_score`. No shortlist row is written without
 *     the score captured — re-fetch never returns it.
 *  3. NEVER UPDATE metrics (§9.5). Follower/view/ER numbers are APPENDED to
 *     `creator_metric_snapshot`, never overwritten in place.
 *
 * Provenance (`source_vendor` + `vendor_last_synced_at`) is stamped on every
 * enriched `creator_account` row.
 */

import type { ModashCreator, ModashSearchParams } from '@goodfor/creator-crm'

import type {
  CreatorDeps,
  CreatorAccountInsert,
  CreatorAudienceInsert,
  CreatorIdentityInsert,
  CreatorMetricSnapshotInsert,
} from './deps.js'

export interface DiscoveryParams extends ModashSearchParams {}

export interface PersistCreatorResult {
  creatorAccountId: number | null
  /** True when a NEW creator_account (+identity) was created; false on dedupe. */
  created: boolean
  credibilityCaptured: number | null
}

async function findExistingAccountId(
  deps: CreatorDeps,
  platform: string,
  platformUserId: string
): Promise<number | null> {
  const { data, error } = await deps.client
    .from('creator_account')
    .select('id')
    .eq('platform', platform)
    .eq('platform_user_id', platformUserId) // dedupe key — never username
    .maybeSingle()
  if (error) throw error
  return (data as { id: number } | null)?.id ?? null
}

/**
 * Persist one discovered creator: resolve-or-create the account keyed on
 * platform_user_id, write the audience row WITH credibility, and append a metric
 * snapshot. Idempotent on the dedupe key.
 */
export async function persistCreator(
  deps: CreatorDeps,
  platform: string,
  creator: ModashCreator
): Promise<PersistCreatorResult> {
  const existingId = await findExistingAccountId(deps, platform, creator.platformUserId)

  let creatorAccountId = existingId
  let created = false

  if (creatorAccountId == null) {
    // New platform_user_id -> create the dedupe identity, then the account.
    const identityRow: CreatorIdentityInsert = { display_name: creator.username }
    const { data: idData, error: idErr } = await deps.client
      .from('creator_identity')
      .insert(identityRow)
      .select('id')
      .single()
    if (idErr) throw idErr
    const creatorIdentityId = (idData as { id: number } | null)?.id ?? null

    const accountRow: CreatorAccountInsert = {
      creator_identity_id: creatorIdentityId,
      platform,
      platform_user_id: creator.platformUserId,
      username: creator.username,
      url: creator.url,
      followers: creator.followers,
      engagement_rate: creator.engagementRate,
      avg_views: creator.avgViews,
      is_verified: creator.isVerified,
      source_vendor: creator.sourceVendor, // provenance stamp
      vendor_last_synced_at: creator.vendorLastSyncedAt,
    }
    const { data: acctData, error: acctErr } = await deps.client
      .from('creator_account')
      .insert(accountRow)
      .select('id')
      .single()
    if (acctErr) throw acctErr
    creatorAccountId = (acctData as { id: number } | null)?.id ?? null
    created = true
  }

  if (creatorAccountId == null) {
    throw new Error('persistCreator: failed to resolve a creator_account id')
  }

  // Persist credibility NOW — the whole reason search() returns it (§9.1).
  const audienceRow: CreatorAudienceInsert = {
    creator_account_id: creatorAccountId,
    captured_at: creator.vendorLastSyncedAt,
    credibility_score: creator.credibility,
  }
  const { error: audErr } = await deps.client.from('creator_audience').insert(audienceRow)
  if (audErr) throw audErr

  // Append a metric snapshot — never UPDATE metrics in place (§9.5).
  const snapshotRow: CreatorMetricSnapshotInsert = {
    creator_account_id: creatorAccountId,
    captured_at: creator.vendorLastSyncedAt,
    followers: creator.followers,
    avg_views: creator.avgViews,
    engagement_rate: creator.engagementRate,
  }
  const { error: snapErr } = await deps.client.from('creator_metric_snapshot').insert(snapshotRow)
  if (snapErr) throw snapErr

  return { creatorAccountId, created, credibilityCaptured: creator.credibility }
}

export interface DiscoveryResult {
  found: number
  created: number
  deduped: number
  creditsConsumed: number
}

/**
 * Run one saved search and persist the shortlist, deduping in-batch and against
 * existing rows on platform_user_id.
 */
export async function runDiscovery(deps: CreatorDeps, params: DiscoveryParams): Promise<DiscoveryResult> {
  const platform = params.platform ?? 'tiktok'
  const { creators, creditsConsumed } = await deps.modash.search(params)

  let created = 0
  let deduped = 0
  const seen = new Set<string>()
  for (const creator of creators) {
    // In-batch dedupe on platform_user_id too (two hits, same user).
    if (seen.has(creator.platformUserId)) {
      deduped++
      continue
    }
    seen.add(creator.platformUserId)
    const res = await persistCreator(deps, platform, creator)
    if (res.created) created++
    else deduped++
  }

  deps.logger.log(
    `[discovery] ${platform}: ${creators.length} found, ${created} new, ${deduped} deduped, ` +
      `${creditsConsumed.toFixed(2)} credits`
  )
  return { found: creators.length, created, deduped, creditsConsumed }
}

// ---------------------------------------------------------------------------
// Entrypoint (creators:discovery)
// ---------------------------------------------------------------------------
export async function main(): Promise<void> {
  const { boot, makeCreatorDeps } = await import('./deps.js')
  boot()
  const { db } = await import('@goodfor/db')
  const deps = makeCreatorDeps({ client: db() })
  // A real deployment iterates saved searches; here we no-op an empty filter run
  // guard so the entrypoint is runnable without a live Modash key crashing boot.
  deps.logger.log('[discovery] configure saved searches before running against a live Modash key.')
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-creators[\\/]src[\\/]discovery\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
