import { db, loadEnv, type Db } from '@goodfor/db'

import { assertReadPlane } from './guard.js'

loadEnv()
assertReadPlane()

import { createSource, type TikTokSource } from '@goodfor/tiktok-source'
import { classifyTrend, isActionableTrend, type TrendPoint } from '@goodfor/scoring'

/**
 * Keyword / hashtag / sound trend tracking.
 *
 *   npx tsx apps/worker-read/src/trends.ts --add hashtag:fyp keyword:"budget app"
 *   npx tsx apps/worker-read/src/trends.ts --once
 *   npx tsx apps/worker-read/src/trends.ts            (loop)
 */

const TICK_MS = 5 * 60_000
const HISTORY_POINTS = 12

// ---------------------------------------------------------------------------

async function addTerms(client: Db, specs: string[]) {
  const rows = specs.map((spec) => {
    const [rawType, ...rest] = spec.split(':')
    const hasType = rest.length > 0 && ['keyword', 'hashtag', 'sound'].includes(rawType ?? '')
    const term_type = hasType ? rawType! : 'hashtag'
    const term = (hasType ? rest.join(':') : spec).replace(/^#/, '').trim().toLowerCase()
    return { term, term_type, is_tracked: true }
  })

  const { error } = await client
    .from('tracked_term')
    .upsert(rows, { onConflict: 'term,term_type', ignoreDuplicates: true })
  if (error) throw error

  console.log(`Tracking ${rows.length} term(s):`)
  for (const r of rows) console.log(`  ${r.term_type}: ${r.term}`)
}

async function termsDue(client: Db, limit = 40) {
  const { data, error } = await client
    .from('tracked_term')
    .select('id, term, term_type, poll_interval_minutes')
    .eq('is_tracked', true)
    .lte('due_at', new Date().toISOString())
    .order('due_at', { ascending: true })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

// ---------------------------------------------------------------------------

async function pollTerm(
  client: Db,
  source: TikTokSource,
  term: { id: number; term: string; term_type: string; poll_interval_minutes: number }
) {
  const videos =
    term.term_type === 'keyword'
      ? await source.searchKeyword({ term: term.term, depth: 1 })
      : await source.searchHashtag({ term: term.term, depth: 1 })

  const postCount = videos.length
  const viewCount = videos.reduce((sum, v) => sum + v.viewCount, 0)
  const ts = new Date().toISOString()

  // Load recent history BEFORE inserting, then append the new point in memory,
  // so classification sees a consistent series regardless of write latency.
  const { data: history, error: hErr } = await client
    .from('keyword_trend')
    .select('ts, view_count')
    .eq('tracked_term_id', term.id)
    .order('ts', { ascending: false })
    .limit(HISTORY_POINTS)
  if (hErr) throw hErr

  const points: TrendPoint[] = [
    ...(history ?? []).map((h) => ({ ts: new Date(h.ts), value: Number(h.view_count ?? 0) })),
    { ts: new Date(ts), value: viewCount },
  ]

  const c = classifyTrend(points)

  const { error: insErr } = await client.from('keyword_trend').upsert(
    {
      tracked_term_id: term.id,
      term: term.term,
      term_type: term.term_type,
      ts,
      post_count: postCount,
      view_count: viewCount,
      velocity: c?.velocity ?? null,
      acceleration: c?.acceleration ?? null,
      burst_weight: c && Number.isFinite(c.burstWeight) ? c.burstWeight : null,
      state: c?.state ?? null,
    },
    { onConflict: 'term,term_type,ts', ignoreDuplicates: true }
  )
  if (insErr) throw insErr

  const nextDue = new Date(Date.now() + term.poll_interval_minutes * 60_000).toISOString()
  await client
    .from('tracked_term')
    .update({ due_at: nextDue, last_synced_at: ts })
    .eq('id', term.id)

  return { postCount, viewCount, classification: c }
}

async function tick(client: Db, source: TikTokSource) {
  const terms = await termsDue(client)
  if (terms.length === 0) {
    console.log('[trends] nothing due')
    return
  }

  console.log(`[trends] polling ${terms.length} term(s) via ${source.name}`)

  for (const t of terms) {
    try {
      const { postCount, viewCount, classification } = await pollTerm(client, source, t)
      const label = `${t.term_type}:${t.term}`.padEnd(28)

      if (!classification) {
        console.log(`  ${label} ${postCount} posts, ${viewCount.toLocaleString('en-GB')} views  (building history)`)
        continue
      }

      const flag = isActionableTrend(classification, viewCount) ? 'RISING' : '      '
      const breakout = classification.isBreakout ? '  BREAKOUT' : ''
      console.log(
        `  ${label} ${flag} ${classification.state.padEnd(9)} ` +
          `burst=${classification.burstWeight.toFixed(2).padStart(6)}  ` +
          `${viewCount.toLocaleString('en-GB')} views${breakout}`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ${t.term_type}:${t.term} FAILED - ${msg}`)
    }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const client = db()
  const argv = process.argv.slice(2)

  const addIdx = argv.indexOf('--add')
  if (addIdx !== -1) {
    const specs = argv.slice(addIdx + 1).filter((a) => !a.startsWith('--'))
    if (specs.length === 0) {
      console.error('--add needs at least one term, e.g. --add hashtag:fyp keyword:"budget app"')
      process.exit(1)
    }
    await addTerms(client, specs)
    return
  }

  const source = createSource()
  await tick(client, source)
  if (argv.includes('--once')) return

  console.log(`[trends] entering loop, every ${TICK_MS / 60_000}m. Ctrl-C to stop.`)
  setInterval(() => {
    tick(client, source).catch((e) => console.error('[trends] error', e))
  }, TICK_MS)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
