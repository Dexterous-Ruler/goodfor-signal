/**
 * Write-plane attribution tick loop (PHASE-4-attribute.md §Work-breakdown 4).
 *
 * 60s `setInterval` + `--once`, mirroring apps/worker-read/src/tick.ts and
 * apps/worker-write/src/tick.ts. Per pass it runs a reconcile: it pulls recent
 * OWNED-MEDIA conversions from Kochava and ingests any not already recorded as
 * an `attributed_install` (installs primarily arrive via the app's first-launch
 * callback; this pass catches anything the callback missed and surfaces the
 * free-tier ceiling alarm).
 *
 * The billing-trap ceiling alarm is logged every pass so an approaching 10K
 * free-tier ceiling is never silent (§10.2).
 */

import { db } from '@goodfor/db'

import { boot, makeAttributeDeps, type AttributeDeps } from './deps.js'
import { ingestInstall } from './install-ingest.js'

const TICK_MS = 60_000
const RECONCILE_WINDOW_DAYS = 2

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

async function alreadyIngested(deps: AttributeDeps, conversionId: string): Promise<boolean> {
  const { data, error } = await deps.client
    .from('attributed_install')
    .select('id')
    .eq('device_pseudo_id', conversionId)
    .maybeSingle()
  if (error) throw error
  return data != null
}

export interface TickResult {
  pulled: number
  ingested: number
  skipped: number
  ceilingAlarm: boolean
}

/**
 * One reconcile pass: pull owned-media conversions from Kochava and ingest the
 * new ones. Returns null if the pull failed (e.g. Kochava creds not present) —
 * the loop logs and carries on rather than crashing the process.
 */
export async function runTick(deps: AttributeDeps): Promise<TickResult | null> {
  const now = deps.now()
  const fromDate = isoDate(new Date(now.getTime() - RECONCILE_WINDOW_DAYS * 24 * 3600_000))
  const toDate = isoDate(now)

  let pull
  try {
    pull = await deps.kochava.pullOwnedMediaConversions({ fromDate, toDate })
  } catch (err) {
    deps.logger.error(`[attribute] Kochava pull failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  if (pull.ceiling.alarm) deps.logger.warn(`[attribute] ${pull.ceiling.message}`)

  let ingested = 0
  let skipped = 0
  for (const c of pull.conversions) {
    try {
      if (await alreadyIngested(deps, c.conversionId)) {
        skipped++
        continue
      }
      await ingestInstall(deps, {
        platform: c.platform === 'ios' ? 'ios' : 'android',
        utmContent: c.utmContent,
        installedAt: c.occurredAt,
        devicePseudoId: c.conversionId,
        source: 'kochava', // never play_referrer -> is_deterministic stays false
      })
      ingested++
    } catch (err) {
      deps.logger.error(
        `[attribute] ingest of conversion ${c.conversionId} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return { pulled: pull.conversions.length, ingested, skipped, ceilingAlarm: pull.ceiling.alarm }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  boot()
  const deps = makeAttributeDeps({ client: db() })

  const res = await runTick(deps)
  if (res) {
    console.log(
      `[attribute] tick: ${res.pulled} pulled, ${res.ingested} ingested, ${res.skipped} skipped` +
        (res.ceilingAlarm ? ' (CEILING ALARM)' : '')
    )
  }
  if (process.argv.includes('--once')) return

  console.log(`[attribute] entering loop, every ${TICK_MS / 1000}s. Ctrl-C to stop.`)
  setInterval(() => {
    runTick(deps).catch((e) => console.error('[attribute] tick error', e))
  }, TICK_MS)
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-attribute[\\/]src[\\/]tick\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
