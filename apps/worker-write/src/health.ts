/**
 * Account-health poller (Phase 3 §Week-14 task 14).
 *
 * Persists, per owned account, a snapshot row into `account_health`:
 *   - `strike_count_by_area` — the rolling 90-day strike window per policy area;
 *   - `fyf_traffic_share` — For-You-feed traffic share;
 *   - `search_traffic_share` — persisted so the suppression detector is even
 *     possible (caveat: confirm Search is broken out as a distinct source in the
 *     2026 analytics before trusting it);
 *   - `originality_status` — Account Check originality per post;
 *   - `suppression_flag` — fires when FYF share COLLAPSES while other sources
 *     hold (the real risk from replicated content is silent FYF reach
 *     suppression, not a hard strike).
 *
 * The insight source is the TikTok API for Business, injected as
 * `deps.businessInsights`. // UNVERIFIED business-API response shapes — flagged
 * on the `BusinessInsight` type; the default implementation throws until a real
 * client is wired, so this poller records nothing rather than inventing numbers.
 */

import { db } from '@goodfor/db'

import {
  boot,
  makeWriteDeps,
  type AccountHealthInsert,
  type BusinessInsight,
  type OwnedAccountRow,
  type WriteDeps,
} from './deps.js'

/** FYF share at/under this is "collapsed". */
export const FYF_COLLAPSE_THRESHOLD = 0.15
/** A non-FYF source counts as "holding" at/above this share. */
export const OTHER_HOLDS_THRESHOLD = 0.2

/**
 * Suppression fires when the For-You feed collapses while another traffic source
 * still holds — i.e. the account keeps getting reach from search/follow/profile
 * but the algorithmic feed stopped promoting it. A whole-account decline (every
 * source down) is NOT suppression; it is just a quiet week.
 *
 * Pure — testable without any I/O.
 */
export function computeSuppressionFlag(insight: BusinessInsight): boolean {
  const fyf = insight.fyfTrafficShare
  if (fyf === null || fyf === undefined) return false
  if (fyf > FYF_COLLAPSE_THRESHOLD) return false
  const others = [insight.searchTrafficShare, insight.otherTrafficShare].filter(
    (v): v is number => typeof v === 'number'
  )
  return others.some((v) => v >= OTHER_HOLDS_THRESHOLD)
}

/** Poll + persist one account's health snapshot. Returns the flag, or null if no data. */
export async function pollAccountHealth(deps: WriteDeps, account: OwnedAccountRow): Promise<boolean | null> {
  let insight: BusinessInsight | null
  try {
    insight = await deps.businessInsights(account)
  } catch (err) {
    deps.logger.error(`[health] account ${account.id}: insight fetch failed — ${errMsg(err)}`)
    return null
  }
  if (!insight) return null

  const suppression = computeSuppressionFlag(insight)
  const row: AccountHealthInsert = {
    owned_account_id: account.id,
    strike_count_by_area: insight.strikeCountByArea as AccountHealthInsert['strike_count_by_area'],
    fyf_traffic_share: insight.fyfTrafficShare,
    search_traffic_share: insight.searchTrafficShare,
    originality_status: insight.originalityStatus,
    suppression_flag: suppression,
  }
  const { error } = await deps.client.from('account_health').insert(row)
  if (error) throw error

  if (suppression) {
    deps.logger.warn(
      `[health] account ${account.id}: SUPPRESSION flag — FYF share ${insight.fyfTrafficShare} ` +
        `collapsed while another source held. Investigate originality/reach.`
    )
  }
  return suppression
}

export async function pollAllHealth(deps: WriteDeps): Promise<{ polled: number; suppressed: number }> {
  const accounts = await loadAccounts(deps)
  let polled = 0
  let suppressed = 0
  for (const account of accounts) {
    try {
      const flag = await pollAccountHealth(deps, account)
      if (flag !== null) {
        polled++
        if (flag) suppressed++
      }
    } catch (err) {
      deps.logger.error(`[health] account ${account.id} threw: ${errMsg(err)}`)
    }
  }
  return { polled, suppressed }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function loadAccounts(deps: WriteDeps): Promise<OwnedAccountRow[]> {
  const { data, error } = await deps.client.from('owned_account').select('*').limit(500)
  if (error) throw error
  return (data as OwnedAccountRow[] | null) ?? []
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  boot()
  const deps = makeWriteDeps({ client: db() })
  const res = await pollAllHealth(deps)
  console.log(`[health] polled ${res.polled} account(s), ${res.suppressed} with a suppression flag`)
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-write[\\/]src[\\/]health\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
