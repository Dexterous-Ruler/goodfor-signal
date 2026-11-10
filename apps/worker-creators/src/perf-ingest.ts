/**
 * Performance ingest (PHASE-5-scale-creators.md §Work-breakdown 5, DoD 6).
 *
 * APPEND-ONLY per capture — `performance_fact` is never UPDATEd in place (§9.5).
 * Each row joins a deliverable's organic engagement to the Phase 4 attribution
 * funnel so creator ROI and organic ROI are measured on ONE RULER: the same
 * install/signup/trial/subscription counters from `app_conversion`.
 *
 * THE JOIN KEY (§9.3, Phase 4). The organic post id lives on
 * `deliverable.platform_post_id` AND on `attributed_install.utm_content` (the
 * published video id). Funnel counts are tallied by matching those, then rolled
 * up per `app_conversion.event_type`.
 */

import type { CreatorDeps, DeliverableRow, PerformanceFactInsert } from './deps.js'

export interface FunnelCounts {
  install: number
  signup: number
  trial: number
  subscription: number
  revenueCents: number
}

const ZERO_FUNNEL: FunnelCounts = { install: 0, signup: 0, trial: 0, subscription: 0, revenueCents: 0 }

/**
 * Tally the Phase 4 funnel for one organic post id (= published video id). Joins
 * `attributed_install.utm_content = platformPostId` -> `app_conversion.install_id`
 * and rolls up by event_type. Read-only.
 */
export async function countFunnelForPost(deps: CreatorDeps, platformPostId: string): Promise<FunnelCounts> {
  const { data: installData, error: installErr } = await deps.client
    .from('attributed_install')
    .select('id')
    .eq('utm_content', platformPostId)
  if (installErr) throw installErr
  const installIds = ((installData as { id: number }[] | null) ?? []).map((r) => r.id)
  if (installIds.length === 0) return { ...ZERO_FUNNEL }

  const { data: convData, error: convErr } = await deps.client
    .from('app_conversion')
    .select('event_type, revenue_cents')
    .in('install_id', installIds)
  if (convErr) throw convErr
  const conversions = (convData as { event_type: string; revenue_cents: number | null }[] | null) ?? []

  const counts: FunnelCounts = { ...ZERO_FUNNEL }
  counts.install = installIds.length
  for (const c of conversions) {
    switch (c.event_type) {
      case 'signup':
        counts.signup++
        break
      case 'trial_start':
        counts.trial++
        break
      case 'subscription':
        counts.subscription++
        break
      default:
        break
    }
    if (typeof c.revenue_cents === 'number') counts.revenueCents += c.revenue_cents
  }
  return counts
}

export interface OrganicMetrics {
  views?: number | null
  likes?: number | null
  comments?: number | null
  shares?: number | null
  saves?: number | null
}

export interface IngestPerformanceResult {
  funnel: FunnelCounts
  inserted: boolean
}

/**
 * Append one `performance_fact` for a deliverable, joining its organic metrics to
 * the Phase 4 funnel. Never UPDATEs — a new capture is always a new row (§9.5).
 */
export async function ingestPerformance(
  deps: CreatorDeps,
  deliverable: DeliverableRow,
  organic: OrganicMetrics = {}
): Promise<IngestPerformanceResult> {
  const funnel = deliverable.platform_post_id
    ? await countFunnelForPost(deps, deliverable.platform_post_id)
    : { ...ZERO_FUNNEL }

  const row: PerformanceFactInsert = {
    deliverable_id: deliverable.id,
    captured_at: deps.now().toISOString(),
    views: organic.views ?? null,
    likes: organic.likes ?? null,
    comments: organic.comments ?? null,
    shares: organic.shares ?? null,
    saves: organic.saves ?? null,
    install_count: funnel.install,
    signup_count: funnel.signup,
    trial_count: funnel.trial,
    subscription_count: funnel.subscription,
    revenue_cents: funnel.revenueCents,
  }
  const { error } = await deps.client.from('performance_fact').insert(row)
  if (error) throw error

  deps.logger.log(
    `[perf-ingest] deliverable ${deliverable.id} (post ${deliverable.platform_post_id ?? 'none'}): ` +
      `${funnel.install} installs / ${funnel.signup} signups / ${funnel.trial} trials / ` +
      `${funnel.subscription} subs / ${funnel.revenueCents}c`
  )
  return { funnel, inserted: true }
}
