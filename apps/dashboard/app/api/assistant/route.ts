import { db, readJson } from '../../../lib/write'
import { getMetricTotals, getStats, getTopAccounts, getTopVideos, getAlerts, getAccountPulse } from '../../../lib/queries'

/**
 * Grounded assistant for the Intelligence UI.
 *
 * THE WHOLE POINT IS THE GROUNDING. A generic chatbot bolted onto this product
 * would confidently invent competitors, view counts and "insights" — exactly the
 * failure mode the rest of this app was built to avoid. So every answer is
 * constrained to a context block assembled from the database on each request,
 * and the model is told to say it does not know rather than fill a gap.
 *
 * Uses Gemini (already proven in packages/vision). No new vendor, no new key.
 */
export const dynamic = 'force-dynamic'

const BASE = 'https://generativelanguage.googleapis.com'
const MODEL = 'gemini-2.5-flash'

const fmt = (v: number): string =>
  v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v))

/** Assemble everything the assistant is allowed to know, from live rows. */
async function buildContext(): Promise<string> {
  const c = db()
  const [totals, stats, top, vids, alerts, pulse] = await Promise.all([
    getMetricTotals(),
    getStats(),
    getTopAccounts(),
    getTopVideos(12),
    getAlerts(10),
    getAccountPulse(5),
  ])
  const [{ data: terms }, { data: creators }, { data: briefs }, { data: owned }, { data: analyses }] = await Promise.all([
    c.from('tracked_term').select('term, term_type, is_tracked'),
    c.from('creator_account').select('username, followers, engagement_rate, avg_views').order('followers', { ascending: false }).limit(15),
    c.from('brief').select('id, hook_type, target_account_type, status').order('created_at', { ascending: false }).limit(10),
    c.from('owned_account').select('username, account_type'),
    c.from('video_analysis').select('video_id, hook_type, format_summary').limit(20),
  ])

  const L: string[] = []
  L.push(`TODAY: ${new Date().toISOString().slice(0, 10)}`)
  L.push(`TOTALS: ${fmt(totals.views)} views, ${fmt(totals.likes)} likes, ${fmt(totals.comments)} comments across ${stats.videos} tracked videos from ${stats.accounts} accounts (${fmt(stats.snapshots)} snapshots).`)

  L.push(`\nTRACKED COMPETITOR ACCOUNTS (by total views):`)
  for (const a of top) L.push(`- @${a.username}: ${fmt(a.views)} total views over ${a.videos} videos`)

  L.push(`\nACCOUNT PULSE (followers / avg views / engagement / posts per week):`)
  for (const p of pulse) L.push(`- @${p.username}: ${p.followers ?? '?'} followers, ${fmt(p.avgViews)} avg views, ${p.engRate.toFixed(1)}% eng, ${p.postsPerWeek.toFixed(1)} posts/wk`)

  L.push(`\nTOP VIDEOS (ranked by performance vs that account's own median):`)
  for (const v of vids.slice(0, 8)) {
    const rel = v.multiplier ?? v.relToAccountMedian
    L.push(`- @${v.username} ${fmt(v.views)} views${rel ? `, ${rel.toFixed(1)}x own median` : ''}: "${(v.caption ?? '').slice(0, 90)}"`)
  }

  L.push(`\nBREAKOUT ALERTS: ${alerts.length === 0 ? 'NONE. Scoring needs videos observed while ageing through the 1-168h grid; with the poll run only manually, no age-matched baseline exists yet.' : ''}`)
  for (const a of alerts) L.push(`- @${a.username}: z=${a.zScore.toFixed(1)}, ${a.multiplier?.toFixed(1)}x median, ${a.ageHours}h old`)

  const t = terms ?? []
  L.push(`\nTRACKED TERMS: ${t.filter((x) => x.is_tracked).map((x) => `${x.term_type}:${x.term}`).join(', ') || 'none'}`)
  if (t.some((x) => !x.is_tracked)) L.push(`PAUSED TERMS: ${t.filter((x) => !x.is_tracked).map((x) => x.term).join(', ')}`)

  L.push(`\nDISCOVERED CREATORS (top by reach): ${(creators ?? []).map((x) => `@${x.username} (${x.followers ? fmt(Number(x.followers)) : '?'})`).join(', ') || 'none'}`)

  const hooks = [...new Set((analyses ?? []).map((a) => a.hook_type).filter(Boolean))]
  L.push(`\nANALYSED VIDEO HOOKS: ${hooks.join(', ') || 'none analysed yet'} (${(analyses ?? []).length} videos analysed)`)

  L.push(`\nBRIEFS: ${(briefs ?? []).map((b) => `#${b.id} ${b.hook_type} (${b.status})`).join(', ') || 'none'}`)

  // HOOK GAPS: the most actionable derivation in the product - hooks that
  // competitors demonstrably use and no brief targets. Without this the
  // assistant cannot answer "what should I brief next", which is the question
  // the product exists to answer.
  const briefedHooks = new Set((briefs ?? []).map((b) => b.hook_type).filter(Boolean) as string[])
  const hookCounts = new Map<string, number>()
  for (const a of analyses ?? []) {
    if (!a.hook_type) continue
    hookCounts.set(a.hook_type, (hookCounts.get(a.hook_type) ?? 0) + 1)
  }
  const gapList = [...hookCounts.entries()].filter(([k]) => !briefedHooks.has(k)).sort((x, y) => y[1] - x[1])
  L.push(`
HOOK GAPS (competitor hooks with NO brief against them - this is the "what to brief next" answer):`)
  if (!gapList.length) L.push('- none: every analysed competitor hook already has a brief, or nothing is analysed yet')
  for (const [hook, n] of gapList) L.push(`- ${hook.replace(/_/g, ' ')}: used in ${n} of ${(analyses ?? []).length} analysed competitor videos, 0 Goodfor briefs`)

  L.push(`
CREATOR OUTREACH: ${(creators ?? []).length} creators discovered. Contact emails are parsed from public bios into creator_identity.primary_email. No collaboration has been opened yet.`)
  L.push(`\nOWN TIKTOK ACCOUNTS CONNECTED: ${(owned ?? []).length === 0 ? 'NONE — so there is no own-account analytics, no publishing, and no attribution/revenue data at all.' : (owned ?? []).map((o) => `@${o.username}`).join(', ')}`)

  return L.join('\n')
}

const SYSTEM = `You are the analyst built into Goodfor Signal, a TikTok competitor-intelligence tool.

Answer ONLY from the CONTEXT block below. It is a live snapshot of the user's database.

Hard rules:
- Never invent a competitor, creator, view count, percentage or trend. If the context does not contain it, say plainly what is missing and what would produce it.
- If the context says something is empty or unavailable, state that directly instead of guessing or hedging.
- Quote real numbers from the context when they support your answer.
- Be concise and concrete. Lead with the answer, not a preamble.
- You may explain how the product works (scoring, polling, the read/write plane split) and give strategy advice, but any CLAIM ABOUT THEIR DATA must come from the context.`

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY
  if (!key) {
    return Response.json({ error: 'GEMINI_API_KEY is not set — the assistant needs it to answer.' }, { status: 503 })
  }

  const b = await readJson(req)
  const message = typeof b.message === 'string' ? b.message.trim() : ''
  if (!message) return Response.json({ error: 'message required' }, { status: 400 })

  const history = Array.isArray(b.history) ? b.history.slice(-8) : []
  const context = await buildContext()

  // Gemini has no system role; prepend the instructions + context to the first turn.
  const contents = [
    { role: 'user', parts: [{ text: `${SYSTEM}\n\n--- CONTEXT (live from the database) ---\n${context}\n--- END CONTEXT ---\n\nAcknowledge with "Ready." only.` }] },
    { role: 'model', parts: [{ text: 'Ready.' }] },
    ...history
      .filter((h): h is { role: string; text: string } => !!h && typeof (h as { text?: unknown }).text === 'string')
      .map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: message }] },
  ]

  try {
    const res = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: 900 },
      }),
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)
      return Response.json({ error: `Gemini ${res.status}: ${detail}` }, { status: 502 })
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim()
    if (!text) return Response.json({ error: 'Empty response from the model.' }, { status: 502 })
    return Response.json({ ok: true, reply: text })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
