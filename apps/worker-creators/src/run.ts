/**
 * Write-plane Creator-CRM CLI dispatch (mirrors apps/worker-attribute/src/run.ts).
 *
 * Routes argv to the module entrypoints, each of which also runs standalone (the
 * `creators:*` package scripts call each file directly). Each module's `boot()`
 * loads the write-plane env and asserts plane isolation before anything touches a
 * credential.
 *
 *   (default)          tick           — licence-alert scan + outreach sweep
 *   --once             tick, single pass
 *   --discovery        discovery      — run saved Modash searches, persist shortlist
 *   --outreach         outreach       — advance due collaborations' cadence
 *   --licence-alerts   licence-alerts — nightly licence-end scan
 */

import { main as tickMain } from './tick.js'
import { main as discoveryMain } from './discovery.js'
import { main as outreachMain } from './outreach.js'
import { main as licenceAlertsMain } from './licence-alerts.js'

export async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.includes('--discovery')) return discoveryMain()
  if (argv.includes('--outreach')) return outreachMain()
  if (argv.includes('--licence-alerts')) return licenceAlertsMain()

  // Default (and --once) is the tick.
  return tickMain()
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-creators[\\/]src[\\/]run\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
