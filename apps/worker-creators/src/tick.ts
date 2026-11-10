/**
 * Write-plane Creator-CRM tick loop (PHASE-5-scale-creators.md §Work-breakdown 5).
 *
 * 60s `setInterval` + `--once`, mirroring apps/worker-attribute/src/tick.ts. Each
 * pass does two write-plane sweeps:
 *   1. Licence-end alerts — flag any expired/near-expiry `rights_grant` on a live
 *      deliverable (the top routine legal exposure, §9.5).
 *   2. Outreach cadence — advance any collaboration whose `next_action_at` is due
 *      (one-shot DM first touch, then email day 2 / day 5 / terminal day 28).
 *
 * First touch is scheduled by setting a collaboration's `next_action_at` (a fresh
 * qualified collaboration with `first_contacted_at = null` fires its DM the first
 * time its `next_action_at` comes due).
 */

import { db } from '@goodfor/db'

import { boot, makeCreatorDeps, type CreatorDeps, type CollaborationRow, type CreatorAccountRow, type CreatorIdentityRow } from './deps.js'
import { scanLicenceAlerts } from './licence-alerts.js'
import { runOutreach, type OutreachTarget } from './outreach.js'
import { isTerminal, type Stage } from '@goodfor/creator-crm'

const TICK_MS = 60_000

/** Resolve collaborations whose next action is due, with the DM/email target. */
export async function resolveDueOutreachTargets(deps: CreatorDeps): Promise<OutreachTarget[]> {
  const nowIso = deps.now().toISOString()
  const { data, error } = await deps.client
    .from('collaboration')
    .select('*')
    .lte('next_action_at', nowIso)
  if (error) throw error
  const collabs = (data as CollaborationRow[] | null) ?? []

  const targets: OutreachTarget[] = []
  for (const collab of collabs) {
    if (isTerminal(collab.stage as Stage)) continue

    const { data: acctData, error: acctErr } = await deps.client
      .from('creator_account')
      .select('*')
      .eq('id', collab.creator_account_id)
      .maybeSingle()
    if (acctErr) throw acctErr
    const acct = acctData as CreatorAccountRow | null
    if (!acct) continue

    let email: string | null = null
    if (acct.creator_identity_id != null) {
      const { data: idData, error: idErr } = await deps.client
        .from('creator_identity')
        .select('*')
        .eq('id', acct.creator_identity_id)
        .maybeSingle()
      if (idErr) throw idErr
      email = (idData as CreatorIdentityRow | null)?.primary_email ?? null
    }

    targets.push({
      collaboration: collab,
      platform: acct.platform,
      platformUserId: acct.platform_user_id,
      email,
    })
  }
  return targets
}

export interface TickResult {
  licenceAlerts: number
  outreachRuns: number
}

/** One pass: licence-alert scan + outreach sweep. */
export async function runTick(deps: CreatorDeps): Promise<TickResult> {
  const alerts = await scanLicenceAlerts(deps)

  let outreachRuns = 0
  const targets = await resolveDueOutreachTargets(deps)
  for (const target of targets) {
    try {
      await runOutreach(deps, target)
      outreachRuns++
    } catch (err) {
      deps.logger.error(
        `[creators] outreach for collaboration ${target.collaboration.id} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return { licenceAlerts: alerts.length, outreachRuns }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
export async function main(): Promise<void> {
  boot()
  const deps = makeCreatorDeps({ client: db() })

  const res = await runTick(deps)
  console.log(`[creators] tick: ${res.licenceAlerts} licence alert(s), ${res.outreachRuns} outreach run(s)`)
  if (process.argv.includes('--once')) return

  console.log(`[creators] entering loop, every ${TICK_MS / 1000}s. Ctrl-C to stop.`)
  setInterval(() => {
    runTick(deps).catch((e) => console.error('[creators] tick error', e))
  }, TICK_MS)
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-creators[\\/]src[\\/]tick\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
