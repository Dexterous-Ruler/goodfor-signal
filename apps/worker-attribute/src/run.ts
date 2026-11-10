/**
 * Write-plane attribution CLI dispatch (mirrors apps/worker-write/src/run.ts).
 *
 * Routes argv to the module entrypoints, each of which also runs standalone (the
 * `attribute:*` package scripts call each file directly). Each module's `boot()`
 * loads the write-plane env and asserts plane isolation before anything touches
 * a credential.
 *
 *   (default)      tick       — reconcile owned-media conversions into installs
 *   --once         tick, single pass
 *   --apple-poll   apple-poll — idempotent Analytics Reports load
 *   --lift-fit     lift-fit   — nightly format-lift regression
 */

import { main as tickMain } from './tick.js'
import { main as applePollMain } from './apple-poll.js'
import { main as liftFitMain } from './lift-fit.js'

export async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.includes('--apple-poll')) return applePollMain()
  if (argv.includes('--lift-fit')) return liftFitMain()

  // Default (and --once) is the reconcile tick.
  return tickMain()
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-attribute[\\/]src[\\/]run\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
