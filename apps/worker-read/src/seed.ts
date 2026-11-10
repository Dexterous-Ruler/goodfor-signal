import { db, loadEnv } from '@goodfor/db'

loadEnv()

/**
 * Registers competitor accounts to track.
 *
 * Usage:
 *   npm run seed -- username1 username2 ...
 *   npm run seed                      (loads the placeholder list below)
 *
 * secUid is left null; the first poll fills it in, and every poll after that
 * uses it because polling by secUid costs one unit less per call.
 */

const PLACEHOLDER = ['fixture_rival_a', 'fixture_rival_b', 'fixture_rival_c']

async function main() {
  const client = db()
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const usernames = args.length > 0 ? args : PLACEHOLDER

  if (args.length === 0) {
    console.log('No usernames passed — seeding fixture placeholders.')
    console.log('Real usage: npm run seed -- competitor1 competitor2\n')
  }

  const { data, error } = await client
    .from('competitor_account')
    .upsert(
      usernames.map((u) => ({
        platform_user_id: `pending:${u}`, // replaced by the real uid on first poll
        username: u,
        is_tracked: true,
      })),
      { onConflict: 'platform_user_id', ignoreDuplicates: true }
    )
    .select('id, username')

  if (error) throw error

  console.log(`Seeded ${usernames.length} account(s):`)
  for (const u of usernames) console.log(`  @${u}`)
  console.log(`\nNext: npm run poll:once`)
  return data
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
