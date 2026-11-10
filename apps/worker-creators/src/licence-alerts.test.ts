import { describe, it, expect } from 'vitest'
import {
  makeCreatorDeps,
  type CreatorDeps,
  type RightsGrantRow,
  type DeliverableRow,
} from './deps.js'
import { scanLicenceAlerts } from './licence-alerts.js'
import { mockDb, type Router } from './testutil.js'

const NOW = new Date('2026-08-16T00:00:00Z')
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 3600_000).toISOString()

function grant(over: Partial<RightsGrantRow> = {}): RightsGrantRow {
  return {
    id: 100,
    collaboration_id: 5,
    usage_scope: 'paid_ads',
    territories: ['US'],
    starts_at: days(-60),
    expires_at: days(-1), // expired yesterday
    exclusivity_window_days: null,
    renewal_price_cents: null,
    ...over,
  }
}

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

function capturingLogger() {
  const warns: string[] = []
  return { logger: { log() {}, warn: (m: string) => warns.push(m), error() {} }, warns }
}

function deps(router: Router, logger: CreatorDeps['logger']): { deps: CreatorDeps } {
  const { client } = mockDb(router)
  return { deps: makeCreatorDeps({ client, now: () => NOW, logger }) }
}

describe('scanLicenceAlerts — fires on expired licence + live deliverable (§9.5)', () => {
  it('raises an alert when an expired grant has a live deliverable', async () => {
    const router: Router = (op) => {
      if (op.table === 'rights_grant') return { data: [grant()] }
      if (op.table === 'deliverable') return { data: [deliverable()] }
      return { data: [] }
    }
    const { logger, warns } = capturingLogger()
    const { deps: d } = deps(router, logger)
    const alerts = await scanLicenceAlerts(d)

    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.expired).toBe(true)
    expect(alerts[0]!.rightsGrantId).toBe(100)
    expect(alerts[0]!.deliverableId).toBe(900)
    // Raised loudly.
    expect(warns.some((w) => /LICENCE-END ALERT/.test(w))).toBe(true)
  })

  it('does NOT alert when the deliverable is not live', async () => {
    const router: Router = (op) => {
      if (op.table === 'rights_grant') return { data: [grant()] }
      if (op.table === 'deliverable') return { data: [deliverable({ status: 'delivered' })] }
      return { data: [] }
    }
    const { logger } = capturingLogger()
    const { deps: d } = deps(router, logger)
    const alerts = await scanLicenceAlerts(d)
    expect(alerts).toHaveLength(0)
  })

  it('does NOT alert when the licence is extended past the window', async () => {
    const router: Router = (op) => {
      if (op.table === 'rights_grant') return { data: [grant({ expires_at: days(90) })] }
      if (op.table === 'deliverable') return { data: [deliverable()] }
      return { data: [] }
    }
    const { logger } = capturingLogger()
    const { deps: d } = deps(router, logger)
    const alerts = await scanLicenceAlerts(d)
    expect(alerts).toHaveLength(0)
  })
})
