/**
 * Write-plane / attribution / creator dashboard queries.
 *
 * Kept separate from lib/queries.ts (the read plane) to mirror the two-plane
 * architecture. All read via the service-role client; server components only.
 * Every table here is live but empty until Phases 3-5 start ingesting, so each
 * query degrades to an empty result and the pages render an empty state.
 */
import { resolve } from 'node:path'
import { db, loadEnv } from '@goodfor/db'

loadEnv(resolve(process.cwd(), '..', '..'))
loadEnv()

type Db = ReturnType<typeof db>
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

type CountTable =
  | 'owned_account'
  | 'scheduled_post'
  | 'attributed_install'
  | 'app_conversion'
  | 'creator_account'
  | 'collaboration'
  | 'rights_grant'

/* eslint-disable @typescript-eslint/no-explicit-any */
async function headCount(table: CountTable, build?: (q: any) => any): Promise<number> {
  const client = db()
  let q: any = client.from(table).select('*', { count: 'exact', head: true })
  if (build) q = build(q)
  const { count } = await q
  return count ?? 0
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─────────────────────────────────────────────────────────────
// Publishing (write plane)
// ─────────────────────────────────────────────────────────────

export interface ScheduledPostRow {
  id: number
  status: string
  caption: string | null
  scheduledFor: string
  disclosureType: string
  disclosureVerified: boolean
  disclosureRegion: string | null
  soundIsCml: boolean | null
  publicPostId: string | null
  username: string
  accountType: string
}

export async function getScheduledPosts(): Promise<ScheduledPostRow[]> {
  const client = db()
  const { data, error } = await client
    .from('scheduled_post')
    .select(
      `id, status, caption, scheduled_for, disclosure_type, disclosure_verified,
       disclosure_region, sound_is_cml, publicaly_available_post_id,
       owned_account!inner ( username, account_type )`
    )
    .order('scheduled_for', { ascending: true })
    .limit(60)
  if (error) throw error
  return (data ?? []).map((r) => {
    const a = r.owned_account as unknown as { username: string; account_type: string }
    return {
      id: r.id,
      status: r.status,
      caption: r.caption,
      scheduledFor: r.scheduled_for,
      disclosureType: r.disclosure_type,
      disclosureVerified: r.disclosure_verified,
      disclosureRegion: r.disclosure_region,
      soundIsCml: r.sound_is_cml,
      publicPostId: r.publicaly_available_post_id,
      username: a.username,
      accountType: a.account_type,
    }
  })
}

export interface BriefRow {
  id: number
  appSlug: string
  hookType: string | null
  targetAccountType: string
  soundIsCml: boolean | null
  status: string
  createdAt: string
}

export async function getBriefs(): Promise<BriefRow[]> {
  const client = db()
  const { data, error } = await client
    .from('brief')
    .select('id, app_slug, hook_type, target_account_type, sound_is_cml, status, created_at')
    .order('created_at', { ascending: false })
    .limit(60)
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    appSlug: r.app_slug,
    hookType: r.hook_type,
    targetAccountType: r.target_account_type,
    soundIsCml: r.sound_is_cml,
    status: r.status,
    createdAt: r.created_at,
  }))
}

export interface OwnedAccountRow {
  id: number
  username: string
  accountType: string
  postsLast24h: number
  uploadsInFlight: number
  quarantinedUntil: string | null
}

export async function getOwnedAccounts(): Promise<OwnedAccountRow[]> {
  const client = db()
  const { data, error } = await client
    .from('owned_account')
    .select('id, username, account_type, posts_last_24h, uploads_in_flight, quarantined_until')
    .order('username')
    .limit(60)
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    username: r.username,
    accountType: r.account_type,
    postsLast24h: r.posts_last_24h,
    uploadsInFlight: r.uploads_in_flight,
    quarantinedUntil: r.quarantined_until,
  }))
}

export async function getPublishStats() {
  const [accounts, drafts, pending, published] = await Promise.all([
    headCount('owned_account'),
    headCount('scheduled_post', (q) => q.eq('status', 'draft')),
    headCount('scheduled_post', (q) => q.eq('status', 'pending')),
    headCount('scheduled_post', (q) => q.eq('status', 'published')),
  ])
  return { accounts, drafts, pending, published }
}

// ─────────────────────────────────────────────────────────────
// Attribution
// ─────────────────────────────────────────────────────────────

export async function getAttributionFunnel() {
  const conv = (event: string) => headCount('app_conversion', (q) => q.eq('event_type', event))
  const [installs, signups, trials, subscriptions] = await Promise.all([
    headCount('attributed_install'),
    conv('signup'),
    conv('trial_start'),
    conv('subscription'),
  ])
  return { installs, signups, trials, subscriptions }
}

export interface VideoInstallRow {
  featuredPostId: number | null
  utmContent: string | null
  androidInstalls: number
  iosInstalls: number
}

export async function getVideoInstalls(): Promise<VideoInstallRow[]> {
  const client = db()
  const { data, error } = await client
    .from('attributed_install')
    .select('featured_post_id, utm_content, platform, is_deterministic')
    .limit(5000)
  if (error) throw error
  const byPost = new Map<string, VideoInstallRow>()
  for (const r of data ?? []) {
    const key = String(r.featured_post_id ?? r.utm_content ?? 'unattributed')
    const row = byPost.get(key) ?? {
      featuredPostId: r.featured_post_id,
      utmContent: r.utm_content,
      androidInstalls: 0,
      iosInstalls: 0,
    }
    if (r.platform === 'android') row.androidInstalls += 1
    else row.iosInstalls += 1
    byPost.set(key, row)
  }
  return [...byPost.values()].sort(
    (a, b) => b.androidInstalls + b.iosInstalls - (a.androidInstalls + a.iosInstalls)
  )
}

export async function getControlTotal() {
  const client = db()
  // Apple App-referrer installs (channel-level control total, newest processing_date).
  const { data } = await client
    .from('apple_analytics_daily')
    .select('report_date, processing_date, value')
    .eq('source_type', 'App referrer')
    .eq('metric_name', 'installs')
    .order('report_date', { ascending: false })
    .order('processing_date', { ascending: false })
    .limit(400)
  const seen = new Set<string>()
  let appleTotal = 0
  for (const r of data ?? []) {
    if (seen.has(r.report_date)) continue // newest processing_date wins per report_date
    seen.add(r.report_date)
    appleTotal += Number(r.value ?? 0)
  }
  const attributedTotal = await headCount('attributed_install')
  return { appleAppReferrer: appleTotal, attributedTotal }
}

export interface IncrementalityRow {
  id: number
  method: string
  channel: string
  startedAt: string
  endedAt: string | null
  incrementalInstalls: number | null
  computedCpiCents: number | null
}

export async function getIncrementality(): Promise<IncrementalityRow[]> {
  const client = db()
  const { data, error } = await client
    .from('incrementality_test')
    .select('id, method, channel, started_at, ended_at, incremental_installs, computed_cpi_cents')
    .order('started_at', { ascending: false })
    .limit(20)
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    method: r.method,
    channel: r.channel,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    incrementalInstalls: num(r.incremental_installs),
    computedCpiCents: num(r.computed_cpi_cents),
  }))
}

// ─────────────────────────────────────────────────────────────
// Creators (write plane)
// ─────────────────────────────────────────────────────────────

export const COLLAB_STAGES = [
  'sourced',
  'qualified',
  'contacted',
  'replied',
  'negotiating',
  'contracted',
  'delivered',
  'live',
] as const

export interface CollabCard {
  id: number
  username: string
  platform: string
  followers: number | null
  rateCents: number | null
  currency: string | null
  appSlug: string | null
}

export interface StageColumn {
  stage: string
  count: number
  cards: CollabCard[]
}

export async function getCreatorPipeline(): Promise<StageColumn[]> {
  const client = db()
  const { data, error } = await client
    .from('collaboration')
    .select(
      `id, stage, rate_cents, currency,
       creator_account!inner ( username, platform, followers ),
       campaign!inner ( app!inner ( slug ) )`
    )
    .limit(500)
  if (error) throw error
  const cards: (CollabCard & { stage: string })[] = (data ?? []).map((r) => {
    const c = r.creator_account as unknown as {
      username: string
      platform: string
      followers: number | null
    }
    const camp = r.campaign as unknown as { app: { slug: string } | null } | null
    return {
      id: r.id,
      stage: r.stage,
      username: c.username,
      platform: c.platform,
      followers: num(c.followers),
      rateCents: num(r.rate_cents),
      currency: r.currency,
      appSlug: camp?.app?.slug ?? null,
    }
  })
  return COLLAB_STAGES.map((stage) => {
    const inStage = cards.filter((c) => c.stage === stage)
    return { stage, count: inStage.length, cards: inStage }
  })
}

export async function getCreatorStats() {
  const [creators, live, expiring] = await Promise.all([
    headCount('creator_account'),
    headCount('collaboration', (q) => q.eq('stage', 'live')),
    headCount('rights_grant', (q) => q.not('expires_at', 'is', null)),
  ])
  return { creators, live, rightsTracked: expiring }
}

export interface RightsAlertRow {
  id: number
  usageScope: string
  expiresAt: string | null
  username: string | null
  stage: string | null
}

export async function getRightsAlerts(): Promise<RightsAlertRow[]> {
  const client = db()
  const { data, error } = await client
    .from('rights_grant')
    .select(
      `id, usage_scope, expires_at,
       collaboration!inner ( stage, creator_account!inner ( username ) )`
    )
    .not('expires_at', 'is', null)
    .order('expires_at', { ascending: true })
    .limit(60)
  if (error) throw error
  return (data ?? []).map((r) => {
    const collab = r.collaboration as unknown as {
      stage: string
      creator_account: { username: string } | null
    } | null
    return {
      id: r.id,
      usageScope: r.usage_scope,
      expiresAt: r.expires_at,
      username: collab?.creator_account?.username ?? null,
      stage: collab?.stage ?? null,
    }
  })
}
