import { db, loadEnv, type Db } from '@goodfor/db'

import { assertReadPlane } from './guard.js'

loadEnv()
assertReadPlane()

import { createSource, type TikTokSource } from '@goodfor/tiktok-source'
import { accountsDue, persistListing, scoreAccount } from './pipeline.js'

const TICK_MS = 60_000

async function tick(client: Db, source: TikTokSource) {
  const accounts = await accountsDue(client)
  if (accounts.length === 0) {
    console.log('[tick] nothing due')
    return
  }

  console.log(`[tick] polling ${accounts.length} account(s) via ${source.name}`)

  for (const acc of accounts) {
    try {
      const { videos } = await source.getUserPosts({
        secUid: acc.sec_uid ?? undefined,
        username: acc.sec_uid ? undefined : acc.username,
        depth: 3,
      })

      const { upserted, snapshots } = await persistListing(client, acc.id, videos)
      const { scored, alerts, reason } = await scoreAccount(client, acc.id)

      console.log(
        `  @${acc.username}: ${upserted} videos, ${snapshots} snapshots, ` +
          `${scored} scores${reason ? ` (${reason})` : ''}`
      )
      for (const a of alerts) console.log(`  ALERT  ${a}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  @${acc.username}: FAILED - ${msg}`)
    }
  }
}

async function main() {
  const client = db()
  const source = createSource()

  await tick(client, source)
  if (process.argv.includes('--once')) return

  console.log(`[tick] entering loop, every ${TICK_MS / 1000}s. Ctrl-C to stop.`)
  setInterval(() => {
    tick(client, source).catch((e) => console.error('[tick] error', e))
  }, TICK_MS)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
