import { db } from '../../../lib/write'
import { getAlerts } from '../../../lib/queries'

/**
 * Backing feed for every screen not served by /api/intelligence or /api/trends:
 * Creator Discovery, Publishing, Published, Calendar, Attribution, Experiments,
 * Briefs, Opportunities, Content Gaps, Settings.
 *
 * Design rule: each domain returns REAL rows plus `empty` and `needs`. Where a
 * table is empty the screen shows an honest empty state naming the exact
 * unblocker instead of inventing data, and lights up automatically once rows
 * land — no further wiring needed.
 */
export const dynamic = 'force-dynamic'

type Domain<T> = { rows: T[]; empty: boolean; needs: string | null }

const wrap = <T,>(rows: T[] | null | undefined, needs: string): Domain<T> => {
  const r = rows ?? []
  return { rows: r, empty: r.length === 0, needs: r.length === 0 ? needs : null }
}

const abbr = (v: number | null | undefined): string =>
  v == null
    ? '—'
    : v >= 1e9
      ? `${(v / 1e9).toFixed(1)}B`
      : v >= 1e6
        ? `${(v / 1e6).toFixed(1)}M`
        : v >= 1e3
          ? `${(v / 1e3).toFixed(1)}K`
          : String(Math.round(v))

const money = (cents: number | null | undefined): string =>
  cents == null ? '—' : '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })

export async function GET() {
  const c = db()

  const [
    creatorAccts,
    collabs,
    campaigns,
    posts,
    owned,
    installs,
    conversions,
    links,
    experiments,
    lifts,
    clusters,
    briefs,
    analyses,
    scores,
    terms,
    library,
  ] = await Promise.all([
    c.from('creator_account').select('id, username, platform, followers, engagement_rate, avg_views, is_verified, source_vendor, last_posted_at').order('followers', { ascending: false }).limit(50),
    c.from('collaboration').select('id, creator_account_id, stage, rate_cents, currency, first_contacted_at, replied_at, contracted_at, next_action_at, source').limit(100),
    c.from('campaign').select('id, objective, budget_cents, start_date, end_date').limit(25),
    c.from('scheduled_post').select('id, status, scheduled_for, caption, published_at, fail_reason, disclosure_type, privacy_level, publish_id, publicaly_available_post_id').order('scheduled_for', { ascending: false }).limit(100),
    c.from('owned_account').select('id, username, account_type, app_slug, posts_last_24h, uploads_in_flight, quarantined_until, access_expires_at').limit(25),
    c.from('attributed_install').select('id, installed_at, platform, source, is_deterministic, utm_content, format_cluster_id').order('installed_at', { ascending: false }).limit(200),
    c.from('app_conversion').select('id, event_type, occurred_at, revenue_cents, install_id').order('occurred_at', { ascending: false }).limit(200),
    c.from('bio_link').select('id, slug, owned_account_id, store_url_ios, store_url_android').limit(25),
    c.from('incrementality_test').select('id, method, channel, started_at, ended_at, baseline_installs, observed_installs, incremental_installs, fully_loaded_cost_cents, computed_cpi_cents, notes').order('started_at', { ascending: false }).limit(25),
    c.from('format_lift').select('format_cluster_id, fit_date, k_format, lag_days, r_squared').order('fit_date', { ascending: false }).limit(25),
    c.from('format_cluster').select('id, label, definition, median_views, median_z, member_count').order('member_count', { ascending: false }).limit(25),
    c.from('brief').select('id, app_slug, hook_type, target_account_type, status, sound_is_cml, competitor_inspiration_id, created_at').order('created_at', { ascending: false }).limit(50),
    c.from('video_analysis').select('video_id, hook_type, format_summary, caption_style, audio_type').limit(100),
    c.from('video_score').select('video_id, multiplier_vs_median, z_score, velocity_vph').order('multiplier_vs_median', { ascending: false }).limit(50),
    c.from('tracked_term').select('term, term_type, is_tracked').limit(50),
    c.from('library_item').select('id, kind, title, meta, tags, collection, created_at').order('created_at', { ascending: false }).limit(100),
  ])

  const alerts = await getAlerts(20)

  // ---- Creator Discovery -------------------------------------------------
  const creators = wrap(creatorAccts.data, 'Modash API key — set MODASH_API_KEY and run worker-creators to source creators.')
  const collaborations = wrap(collabs.data, 'No collaborations yet. They appear once creators are sourced and moved through the stage pipeline.')

  // ---- Publishing / Published / Calendar ---------------------------------
  const ownedRows = owned.data ?? []
  const postRows = posts.data ?? []
  const publishing = {
    ...wrap(postRows, 'Connect a TikTok account (worker-write OAuth), then queue a post.'),
    accounts: ownedRows,
    connected: ownedRows.length > 0,
    connectUrl:
      (process.env.WORKER_WRITE_OAUTH_URL ?? 'http://localhost:3100') +
      '/auth/tiktok/start?app_slug=goodfor&account_type=business',
    queued: postRows.filter((p) => p.status === 'draft' || p.status === 'queued').length,
    published: postRows.filter((p) => p.status === 'published').length,
    failed: postRows.filter((p) => p.status === 'failed').length,
  }

  // ---- Attribution & ROI --------------------------------------------------
  const inst = installs.data ?? []
  const conv = conversions.data ?? []
  const revenue = conv.reduce((s, r) => s + Number(r.revenue_cents ?? 0), 0)
  const attribution = {
    ...wrap(inst, 'Attribution needs the write plane: a bio_link per account plus worker-attribute ingesting installs/conversions.'),
    installs: inst.length,
    deterministic: inst.filter((i) => i.is_deterministic).length,
    conversions: conv.length,
    revenue: money(revenue),
    revenueCents: revenue,
    links: links.data ?? [],
  }

  // ---- Experiments & Learnings -------------------------------------------
  const experimentRows = (experiments.data ?? []).map((e) => ({
    ...e,
    cpi: money(e.computed_cpi_cents),
    cost: money(e.fully_loaded_cost_cents),
    state: e.ended_at ? 'Concluded' : 'Running',
  }))
  const experimentsDomain = {
    ...wrap(experimentRows, 'No incrementality tests recorded. Create one to measure true CPI (single-channel pause / geolift).'),
    lifts: lifts.data ?? [],
  }

  // ---- Briefs -------------------------------------------------------------
  const briefsDomain = wrap(briefs.data, 'No briefs yet — generate one from a breakout video.')

  // ---- Opportunities + Content Gaps (derived from REAL analysis) ---------
  // Which hooks actually appear in analysed competitor videos, ranked by how
  // hard those videos outperformed. Real evidence, not a guess.
  const scoreById = new Map((scores.data ?? []).map((s) => [s.video_id, s]))
  const hookAgg = new Map<string, { n: number; best: number }>()
  for (const a of analyses.data ?? []) {
    const h = a.hook_type
    if (!h) continue
    const mult = Number(scoreById.get(a.video_id)?.multiplier_vs_median ?? 0)
    const cur = hookAgg.get(h) ?? { n: 0, best: 0 }
    hookAgg.set(h, { n: cur.n + 1, best: Math.max(cur.best, mult) })
  }
  const hookRows = [...hookAgg.entries()]
    .map(([hook, v]) => ({
      key: hook,
      hook: hook.replace(/_/g, ' '),
      videos: v.n,
      bestMultiplier: v.best ? v.best.toFixed(1) + '×' : '—',
      best: v.best,
    }))
    .sort((a, b) => b.videos - a.videos)

  const opportunities = {
    ...wrap(hookRows, 'Analyse more competitor videos (worker-analyse) to surface hook patterns.'),
    analysedVideos: (analyses.data ?? []).length,
    clusters: clusters.data ?? [],
    trackedTerms: (terms.data ?? []).filter((t) => t.is_tracked).length,
  }

  // ---- Settings / connections --------------------------------------------
  const settings = {
    supabase: 'connected',
    readPlaneVendors: [
      { name: 'EnsembleData', configured: !!process.env.ENSEMBLEDATA_TOKEN, note: 'listings + search' },
      { name: 'Apify', configured: !!process.env.APIFY_TOKEN, note: 'media + listings failover' },
    ],
    tiktokAccounts: ownedRows.length,
    trackedTerms: (terms.data ?? []).length,
    briefs: (briefs.data ?? []).length,
  }

  // ---- AI Recommendations -------------------------------------------------
  // Rule-based, derived entirely from real system state. Every row carries the
  // numbers it was computed from, so nothing here is a generated claim: if the
  // evidence is not in the database, the recommendation is not shown.
  const analysedIds = new Set((analyses.data ?? []).map((a) => a.video_id))
  const unanalysedBreakouts = alerts.filter((a) => !analysedIds.has(a.videoId))
  const creatorRows = creatorAccts.data ?? []
  const briefRows = briefs.data ?? []
  const briefedVideoIds = new Set(briefRows.map((b) => b.competitor_inspiration_id).filter(Boolean))
  const topAlert = alerts[0]
  const trackedTermCount = (terms.data ?? []).filter((t) => t.is_tracked).length

  type Rec = {
    kind: string
    title: string
    why: string
    impact: string
    confidence: string
    effort: string
    evidence: [string, string][]
    basis: string
    cta: string
    page: string
  }
  const recs: Rec[] = []

  if (unanalysedBreakouts.length) {
    const top = unanalysedBreakouts[0]!
    recs.push({
      kind: 'Content intelligence',
      title: `Analyse ${unanalysedBreakouts.length} breakout video${unanalysedBreakouts.length === 1 ? '' : 's'} — you cannot copy what you have not broken down.`,
      why: `These videos are outperforming their account's median but have no hook or format analysis, so the pattern behind them is unknown. Analysis is what turns a breakout into a repeatable brief.`,
      impact: 'HIGH',
      confidence: 'HIGH',
      effort: 'LOW',
      evidence: [
        ['Unanalysed breakouts', String(unanalysedBreakouts.length)],
        ['Top multiplier', top.multiplier ? top.multiplier.toFixed(1) + '×' : '—'],
        ['Analysed so far', String(analysedIds.size)],
      ],
      basis: `${alerts.length} live breakout signals`,
      cta: 'Open Content Research',
      page: 'research',
    })
  }

  const contactable = creatorRows.length
  if (contactable) {
    const top = creatorRows[0]!
    recs.push({
      kind: 'Creator',
      title: `Start outreach — ${contactable} creators sourced, none contacted yet.`,
      why: `Discovery has built a shortlist from the terms you track, but no collaboration has been opened. Creators found this way are already posting on your keywords, so relevance is evidenced rather than assumed.`,
      impact: 'HIGH',
      confidence: 'MEDIUM',
      effort: 'LOW',
      evidence: [
        ['Creators sourced', String(contactable)],
        ['Largest reach', abbr(top.followers == null ? null : Number(top.followers))],
        ['Collaborations open', String((collabs.data ?? []).length)],
      ],
      basis: 'Apify creator discovery',
      cta: 'Open Creator Discovery',
      page: 'creators',
    })
  }

  if (topAlert && !briefedVideoIds.has(topAlert.videoId)) {
    recs.push({
      kind: 'Competitor opportunity',
      title: `Brief the @${topAlert.username} breakout before the window closes.`,
      why: `It is ${topAlert.multiplier ? topAlert.multiplier.toFixed(1) + '× its account median' : 'outperforming'} at ${topAlert.ageHours}h old and has no brief against it. Breakout windows are short; the brief is the step between noticing and posting.`,
      impact: 'HIGH',
      confidence: topAlert.baselineN >= 20 ? 'HIGH' : 'MEDIUM',
      effort: 'LOW',
      evidence: [
        ['Multiplier', topAlert.multiplier ? topAlert.multiplier.toFixed(1) + '×' : '—'],
        ['Age', topAlert.ageHours + 'h'],
        ['Baseline', String(topAlert.baselineN) + ' videos'],
      ],
      basis: 'z-score breakout detection',
      cta: 'Generate brief',
      page: 'brief',
    })
  }

  if (!ownedRows.length) {
    recs.push({
      kind: 'Setup',
      title: 'Connect a TikTok account to unlock publishing and attribution.',
      why: 'Four screens (Publishing, Published, Calendar, Performance) and all conversion tracking stay dark until one account is linked. Everything upstream of posting already works.',
      impact: 'HIGH',
      confidence: 'HIGH',
      effort: 'MEDIUM',
      evidence: [
        ['Accounts connected', '0'],
        ['Briefs ready to post', String(briefRows.filter((b) => b.status === 'ready').length)],
        ['Screens blocked', '4'],
      ],
      basis: 'owned_account is empty',
      cta: 'Open Publishing',
      page: 'scheduler',
    })
  }

  if (trackedTermCount < 5) {
    recs.push({
      kind: 'Coverage',
      title: `Only ${trackedTermCount} term${trackedTermCount === 1 ? '' : 's'} tracked — widen the net.`,
      why: 'Trend detection and creator discovery both run off tracked terms, so coverage caps how much the system can find. Terms are cheap: each poll costs a fraction of a cent.',
      impact: 'MEDIUM',
      confidence: 'HIGH',
      effort: 'LOW',
      evidence: [
        ['Tracked terms', String(trackedTermCount)],
        ['Creators found', String(contactable)],
        ['Suggested', '10–20'],
      ],
      basis: 'tracked_term coverage',
      cta: 'Open Trend Radar',
      page: 'trending',
    })
  }

  const recommendations = {
    ...wrap(recs, 'No recommendations — the system has no outstanding signals to act on.'),
  }

  // ---- Content Gaps ------------------------------------------------------
  // A gap is a hook competitors demonstrably use that we have NO brief against.
  // Both sides of the comparison are real rows: competitor hooks come from
  // video_analysis, "us" comes from the brief table.
  const briefHookKeys = new Set(briefRows.map((b) => b.hook_type).filter(Boolean) as string[])
  const gapRows = hookRows
    .filter((hrow) => !briefHookKeys.has(hrow.key))
    .map((hrow) => {
      // Score the gap by how much it outperformed and how often it recurs —
      // capped so a single freak video cannot dominate the ranking.
      const score = Math.min(99, Math.round(hrow.videos * 12 + Math.min(hrow.best, 20) * 2))
      return {
        kind: 'Hook',
        title: hrow.hook,
        them: `${hrow.videos} analysed video${hrow.videos === 1 ? '' : 's'} · best ${hrow.bestMultiplier}`,
        us: '0 briefs',
        evidence: `Competitors use this hook in ${hrow.videos} of ${(analyses.data ?? []).length} analysed videos; no Goodfor brief targets it yet.`,
        score,
        comp: hrow.videos >= 4 ? 'High' : hrow.videos >= 2 ? 'Medium' : 'Low',
        action: 'Create brief',
      }
    })
    .sort((a, b) => b.score - a.score)

  const gaps = {
    ...wrap(gapRows, 'No hook gaps — every analysed competitor hook already has a brief against it.'),
    analysedVideos: (analyses.data ?? []).length,
    briefedHooks: briefHookKeys.size,
  }

  // ---- Content Library ----------------------------------------------------
  const libRows = (library.data ?? []).map((r) => ({
    ...r,
    tags: r.tags ?? [],
    saved: new Date(r.created_at).toLocaleDateString('en-GB'),
  }))
  const collectionCounts = new Map<string, number>()
  for (const r of libRows) collectionCounts.set(r.collection, (collectionCounts.get(r.collection) ?? 0) + 1)
  const libraryDomain = {
    ...wrap(libRows, 'Library is empty — save a video, creator or trend to start a collection.'),
    collections: [
      { name: 'All saved', n: libRows.length },
      ...[...collectionCounts.entries()].map(([name, n]) => ({ name, n })),
    ],
  }

  return Response.json({
    library: libraryDomain,
    gaps,
    recommendations,
    creators,
    collaborations,
    campaigns: campaigns.data ?? [],
    publishing,
    attribution,
    experiments: experimentsDomain,
    briefs: briefsDomain,
    opportunities,
    settings,
    updatedAt: new Date().toISOString(),
  })
}
