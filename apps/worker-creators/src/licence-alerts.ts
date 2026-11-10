/**
 * Licence-end alerting (PHASE-5-scale-creators.md §9.5, top routine legal exposure).
 *
 * Nightly scan: for every `rights_grant` whose `expires_at` has passed or is
 * within the lead-time window, check whether a LINKED deliverable is still
 * `live`. A live paid ad on an expired usage licence is the single largest
 * routine legal exposure, so each hit is raised loudly (logged) and returned for
 * the caller to surface on the rights dashboard.
 *
 * The decision itself is pure (`@goodfor/creator-crm` `licenceStatus`); this
 * module only does the DB scan and raises the alert.
 */

import { licenceStatus, LICENCE_ALERT_WINDOW_DAYS, LIVE_STAGE } from '@goodfor/creator-crm'

import type { CreatorDeps, RightsGrantRow, DeliverableRow } from './deps.js'

export interface LicenceAlert {
  rightsGrantId: number
  collaborationId: number
  deliverableId: number
  expiresAt: string | null
  expired: boolean
  daysUntilExpiry: number | null
  reason: string
}

export interface LicenceAlertOptions {
  alertWindowDays?: number
}

/**
 * Scan for licence-end alerts. Returns one alert per (expiring grant × live
 * deliverable). Raises each via `logger.warn` so an approaching/expired licence
 * on a live ad is never silent.
 */
export async function scanLicenceAlerts(
  deps: CreatorDeps,
  opts: LicenceAlertOptions = {}
): Promise<LicenceAlert[]> {
  const windowDays = opts.alertWindowDays ?? LICENCE_ALERT_WINDOW_DAYS
  const now = deps.now()
  const windowIso = new Date(now.getTime() + windowDays * 24 * 3600_000).toISOString()

  // Grants with an expiry at/before the window horizon (passed OR approaching).
  const { data: grantData, error: grantErr } = await deps.client
    .from('rights_grant')
    .select('*')
    .not('expires_at', 'is', null)
    .lte('expires_at', windowIso)
  if (grantErr) throw grantErr
  const grants = (grantData as RightsGrantRow[] | null) ?? []

  const alerts: LicenceAlert[] = []
  for (const grant of grants) {
    const { data: delivData, error: delivErr } = await deps.client
      .from('deliverable')
      .select('*')
      .eq('collaboration_id', grant.collaboration_id)
    if (delivErr) throw delivErr
    const deliverables = (delivData as DeliverableRow[] | null) ?? []

    for (const deliverable of deliverables) {
      if (deliverable.status !== LIVE_STAGE) continue
      const status = licenceStatus(grant, LIVE_STAGE, now, { alertWindowDays: windowDays })
      if (!status.needsAlert) continue
      const alert: LicenceAlert = {
        rightsGrantId: grant.id,
        collaborationId: grant.collaboration_id,
        deliverableId: deliverable.id,
        expiresAt: grant.expires_at,
        expired: status.expired,
        daysUntilExpiry: status.daysUntilExpiry,
        reason: status.reason ?? 'licence-end alert',
      }
      alerts.push(alert)
      deps.logger.warn(
        `[licence-alerts] LICENCE-END ALERT grant=${grant.id} collaboration=${grant.collaboration_id} ` +
          `deliverable=${deliverable.id}: ${alert.reason}`
      )
    }
  }

  deps.logger.log(`[licence-alerts] scanned ${grants.length} expiring grant(s), ${alerts.length} alert(s) raised`)
  return alerts
}

// ---------------------------------------------------------------------------
// Entrypoint (creators:licence-alerts)
// ---------------------------------------------------------------------------
export async function main(): Promise<void> {
  const { boot, makeCreatorDeps } = await import('./deps.js')
  boot()
  const { db } = await import('@goodfor/db')
  const deps = makeCreatorDeps({ client: db() })
  const alerts = await scanLicenceAlerts(deps)
  deps.logger.log(`[licence-alerts] done: ${alerts.length} alert(s)`)
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  /worker-creators[\\/]src[\\/]licence-alerts\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
