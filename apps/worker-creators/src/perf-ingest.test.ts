import { describe, it, expect } from 'vitest'
import { makeCreatorDeps, type CreatorDeps, type DeliverableRow } from './deps.js'
import { ingestPerformance, countFunnelForPost } from './perf-ingest.js'
import { mockDb, opsFor, quietLogger, type Router } from './testutil.js'

const NOW = new Date('2026-08-16T12:00:00Z')

function deliverable(over: Partial<DeliverableRow> = {}): DeliverableRow {
  return {
    id: 900,
    collaboration_id: 5,
    type: 'video',
    due_date: null,
    status: 'live',
    asset_url: null,
    posted_url: null,
    platform_post_id: '7412345678901234567',
    is_spark_ads_authorized: true,
    spark_ads_code: null,
    spark_ads_expires_at: null,
    ...over,
  }
}

/** Router joining attributed_install (Phase 4) -> app_conversion by utm_content. */
const funnelRouter: Router = (op) => {
  if (op.table === 'attributed_install' && op.kind === 'select') return { data: [{ id: 1 }, { id: 2 }] }
  if (op.table === 'app_conversion' && op.kind === 'select') {
    return {
      data: [
        { event_type: 'install', revenue_cents: null },
        { event_type: 'signup', revenue_cents: null },
        { event_type: 'trial_start', revenue_cents: null },
        { event_type: 'subscription', revenue_cents: 999 },
      ],
    }
  }
  return { data: null }
}

function deps(router: Router): { deps: CreatorDeps; calls: ReturnType<typeof mockDb>['calls'] } {
  const { client, calls } = mockDb(router)
  return { deps: makeCreatorDeps({ client, now: () => NOW, logger: quietLogger }), calls }
}

describe('countFunnelForPost — joins to the Phase 4 app_conversion funnel', () => {
  it('tallies install/signup/trial/subscription + revenue for an organic post id', async () => {
    const { deps: d } = deps(funnelRouter)
    const funnel = await countFunnelForPost(d, '7412345678901234567')
    expect(funnel).toEqual({ install: 2, signup: 1, trial: 1, subscription: 1, revenueCents: 999 })
  })

  it('returns zeros when the post has no attributed installs', async () => {
    const { deps: d } = deps((op) => (op.table === 'attributed_install' ? { data: [] } : { data: null }))
    const funnel = await countFunnelForPost(d, 'no_installs')
    expect(funnel).toEqual({ install: 0, signup: 0, trial: 0, subscription: 0, revenueCents: 0 })
  })
})

describe('ingestPerformance — appends performance_fact joined to the funnel (never UPDATE)', () => {
  it('writes one row with organic metrics + funnel counts', async () => {
    const { deps: d, calls } = deps(funnelRouter)
    const res = await ingestPerformance(d, deliverable(), { views: 100_000, likes: 8000, comments: 300, shares: 200, saves: 150 })

    expect(res.funnel.install).toBe(2)
    expect(res.funnel.subscription).toBe(1)

    const insert = opsFor(calls, 'performance_fact', 'insert')[0]!
    expect(insert.payload.deliverable_id).toBe(900)
    expect(insert.payload.views).toBe(100_000)
    expect(insert.payload.install_count).toBe(2)
    expect(insert.payload.signup_count).toBe(1)
    expect(insert.payload.trial_count).toBe(1)
    expect(insert.payload.subscription_count).toBe(1)
    expect(insert.payload.revenue_cents).toBe(999)
    // Append-only — never an UPDATE (§9.5).
    expect(opsFor(calls, 'performance_fact', 'update')).toHaveLength(0)
  })
})
