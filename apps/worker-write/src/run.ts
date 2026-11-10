/**
 * Write-plane CLI dispatch (Phase 3 §Week-11 task, run.ts).
 *
 * Routes argv to the module entrypoints, all of which also run standalone (the
 * `publish:*` package scripts call each file directly). `boot()` inside each
 * module loads the write-plane env and asserts plane isolation before anything
 * touches a credential.
 *
 *   (default)    tick   — drain due scheduled_post through the state machine
 *   --once       tick, single pass
 *   --oauth      oauth  — start the callback listener
 *   --reconcile  reconcile — resolve publish_id -> public post id
 *   --health     health — poll account health
 *   --refresh    token  — rotate tokens nearing expiry (T-6h)
 */

import { main as oauthMain } from './oauth.js'
import { main as reconcileMain } from './reconcile.js'
import { main as healthMain } from './health.js'
import { main as tokenMain } from './token.js'
import { main as tickMain } from './tick.js'

export async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.includes('--oauth')) return oauthMain()
  if (argv.includes('--reconcile')) return reconcileMain()
  if (argv.includes('--health')) return healthMain()
  if (argv.includes('--refresh')) return tokenMain()

  // Default (and --once) is the publishing tick.
  return tickMain()
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-write[\\/]src[\\/]run\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
