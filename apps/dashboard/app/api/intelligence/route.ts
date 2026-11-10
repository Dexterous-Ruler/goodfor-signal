import { NextResponse } from 'next/server'
import { db } from '@goodfor/db'
import {
  getMetricTotals,
  getStats,
  getTopAccounts,
  getAlerts,
  getTopVideos,
  getMetricSeries,
  getAccountPulse,
  getBriefSeed,
} from '../../../lib/queries'

// Live data feed for the Goodfor TikTok Intelligence UI (public/intelligence.html).
// Everything here is real, read-plane data from Supabase.
export const dynamic = 'force-dynamic'

const fmt = (v: number): string =>
  v >= 1e9
    ? `${(v / 1e9).toFixed(1)}B`
    : v >= 1e6
      ? `${(v / 1e6).toFixed(1)}M`
      : v >= 1e3
        ? `${(v / 1e3).toFixed(1)}K`
        : String(Math.round(v))

export async function GET() {
  const [totals, stats, top, alerts, topVids, series, pulse, briefSeed] = await Promise.all([
    getMetricTotals(),
    getStats(),
    getTopAccounts(),
    getAlerts(12),
    getTopVideos(12),
    getMetricSeries(30),
    getAccountPulse(3),
    getBriefSeed(),
  ])
  const engRate = totals.views > 0 ? (totals.engagement / totals.views) * 100 : 0

  // KPI strip — mapped to the metrics the read plane actually holds.
  const kpis = [
    { label: 'Total views', value: fmt(totals.views), delta: 'live', bench: `${fmt(totals.videos)} videos tracked` },
    { label: 'Engagement rate', value: `${engRate.toFixed(2)}%`, delta: `${fmt(totals.engagement)} total`, bench: `${fmt(totals.likes)} likes` },
    { label: 'Total likes', value: fmt(totals.likes), delta: 'live', bench: `${fmt(totals.comments)} comments` },
    { label: 'Accounts tracked', value: String(stats.accounts), delta: 'live', bench: `${fmt(stats.snapshots)} snapshots` },
    { label: 'Videos tracked', value: fmt(stats.videos), delta: 'live', bench: 'across the watchlist' },
  ]

  // Competitor pulse — real tracked competitors, by views, with follower counts.
  const { data: accts } = await db().from('competitor_account').select('username, follower_count')
  const followers = new Map((accts ?? []).map((a) => [a.username, a.follower_count]))
  const competitors = top.map((a, i) => ({
    name: '@' + a.username,
    display: a.displayName ?? a.username,
    followers: followers.get(a.username) != null ? fmt(Number(followers.get(a.username))) : '—',
    views: fmt(a.views),
    videos: a.videos,
    status: i === 0 ? 'Alerting' : 'Tracking',
  }))

  // PULSE ticker + "What's happening" — from real z-score velocity alerts.
  const zdot = (z: number) => (z >= 20 ? '#FE2C55' : z >= 8 ? '#E0B95E' : '#9CD3AE')
  const multLabel = (m: number | null) => (m ? `${m.toFixed(1)}× median` : 'outperforming')
  const ticker = alerts.slice(0, 7).map((a) => ({
    dot: zdot(a.zScore),
    text: `@${a.username} · ${multLabel(a.multiplier)} · z ${a.zScore.toFixed(0)} · ${a.ageHours}h`,
  }))
  const events = alerts.slice(0, 5).map((a) => ({
    dot: a.zScore >= 20 ? '#C43D3D' : '#1E7F4F',
    title: `@${a.username} video is ${multLabel(a.multiplier)}`,
    why: `z ${a.zScore.toFixed(1)} · ${a.velocityVph ? Math.round(a.velocityVph).toLocaleString('en-US') + ' views/hr' : 'accelerating'} · ${a.baselineN} baseline`,
    action: 'Review',
    page: 'alerts',
  }))

  // Top performing content — real tracked videos by views, with velocity + AI hook.
  const dur = (s: number | null) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`)
  const topVideos = topVids.map((v) => {
    const relDays = Math.max(0, Math.round((Date.now() - new Date(v.postedAt).getTime()) / 864e5))
    const engPct = v.views > 0 ? ((v.likes + v.comments + v.shares) / v.views) * 100 : 0
    return {
      id: 'v' + v.id,
      creator: '@' + v.username,
      caption: v.caption ?? '(no caption)',
      views: fmt(v.views),
      eng: engPct.toFixed(1) + '%',
      growth: v.velocityVph ? '+' + fmt(v.velocityVph) + '/h' : 'live',
      // Prefer the scorer's age-matched multiplier; fall back to the locally
      // derived views-vs-own-median so the column is useful before scores land.
      mult: v.multiplier
        ? v.multiplier.toFixed(1) + '×'
        : v.relToAccountMedian
          ? v.relToAccountMedian.toFixed(1) + '×'
          : '—',
      duration: dur(v.durationS),
      date: relDays + 'd',
      hook: v.hookType ?? null,
    }
  })

  // Performance chart — real time-bucketed metric series (drives the main line per tab).
  const chartSeries =
    series.length > 1
      ? {
          labels: series.map((s) => s.label),
          views: series.map((s) => s.views),
          engagement: series.map((s) => s.likes + s.comments + s.shares),
          shares: series.map((s) => s.shares),
          comments: series.map((s) => s.comments),
        }
      : null

  // Competitor Pulse — top 3 tracked accounts by avg views (reframed: no Goodfor own-account row exists).
  const cbW = (vals: number[]) => {
    const m = Math.max(...vals, 1)
    return vals.map((v) => `${(v / m) * 100}%`)
  }
  const cbRow = (label: string, get: (p: (typeof pulse)[number]) => number, disp: (v: number) => string) => {
    const vals = pulse.map(get)
    const w = cbW(vals)
    return { label, gf: disp(vals[0] ?? 0), a: disp(vals[1] ?? 0), b: disp(vals[2] ?? 0), gfW: w[0] ?? '0%', aW: w[1] ?? '0%', bW: w[2] ?? '0%' }
  }
  const compBars =
    pulse.length >= 2
      ? [
          cbRow('Followers', (p) => p.followers ?? 0, fmt),
          cbRow('Avg views', (p) => p.avgViews, fmt),
          cbRow('Engagement', (p) => p.engRate, (v) => v.toFixed(1) + '%'),
          cbRow('Posts / week', (p) => p.postsPerWeek, (v) => v.toFixed(1)),
        ]
      : null
  const compLegend = {
    a: pulse[0] ? '@' + pulse[0].username : 'Goodfor',
    b: pulse[1] ? '@' + pulse[1].username : 'Bare Bites',
    c: pulse[2] ? '@' + pulse[2].username : 'Nourish Co.',
  }
  const pulseCallout = pulse[0]
    ? `@${pulse[0].username} leads the watchlist with ${fmt(pulse[0].avgViews)} avg views across ${pulse[0].videos} tracked videos.`
    : null

  // Competitor Intelligence screen — real competitor cards (reframed: leader + tracked, no own-account).
  const compAccounts = pulse.map((p, i) => ({
    name: p.displayName || p.username,
    handle: '@' + p.username,
    followers: p.followers != null ? fmt(p.followers) : '—',
    avg: fmt(p.avgViews),
    eng: p.engRate.toFixed(1) + '%',
    ppw: p.postsPerWeek.toFixed(1),
    tag: i === 0 ? 'Leader' : 'Tracked',
  }))

  // Alerts screen — real z-score breakouts as per-video "stories", with real stat counts.
  const zdotAlert = (z: number) => (z >= 20 ? '#C43D3D' : z >= 8 ? '#B8791A' : '#1E7F4F')
  const alertGroups = alerts.map((a) => ({
    dot: zdotAlert(a.zScore),
    title: `@${a.username} video is ${multLabel(a.multiplier)}`,
    summary: `z ${a.zScore.toFixed(1)} · ${a.velocityVph ? Math.round(a.velocityVph).toLocaleString('en-US') + ' views/hr' : 'accelerating'} · ${a.baselineN} baseline · ${a.ageHours}h old.`,
    count: 1,
    time: `${a.ageHours}h ago`,
    rule: 'Competitor > 2× avg',
    page: 'comp',
  }))
  const accountsAlerting = new Set(alerts.map((a) => a.username)).size
  const urgentAlerts = alerts.filter((a) => a.zScore >= 20).length
  const alertStats = [
    { v: String(alerts.length), k: 'signals' },
    { v: String(accountsAlerting), k: 'accounts' },
    { v: String(urgentAlerts), k: 'urgent' },
  ]
  const alertsIntro = alerts.length
    ? `${alerts.length} live breakout signal${alerts.length === 1 ? '' : 's'} across ${accountsAlerting} account${accountsAlerting === 1 ? '' : 's'}.`
    : null

  // Command Center — real breakouts grouped by severity into priority buckets.
  const sevBuckets = [
    { label: 'Urgent', color: '#C43D3D' },
    { label: 'High', color: '#B8791A' },
    { label: 'Watch', color: '#6A6E75' },
  ]
  const bucketOf = (z: number) => (z >= 20 ? 0 : z >= 8 ? 1 : 2)
  const prioItems: { z: number; title: string; why: string; time: string; source: string; owner: string; action: string; video: string }[] = alerts.map((a) => ({
    z: a.zScore,
    title: `@${a.username} video is ${multLabel(a.multiplier)}`,
    why: `${a.velocityVph ? Math.round(a.velocityVph).toLocaleString('en-US') + ' views/hr' : 'Accelerating'} · z ${a.zScore.toFixed(1)} · ${a.baselineN}-video baseline${a.multiplier ? ` · ${a.multiplier.toFixed(1)}× its median` : ''}.`,
    time: `${a.ageHours}h ago`,
    source: 'Competitor watchlist',
    owner: 'Unassigned',
    action: 'Analyze video',
    video: 'v' + a.videoId,
  }))
  const grouped: (typeof prioItems)[] = [[], [], []]
  for (const it of prioItems) grouped[bucketOf(it.z)]!.push(it)
  const priorities = sevBuckets
    .map((s, i) => {
      const items = grouped[i] ?? []
      return {
        label: s.label,
        color: s.color,
        count: `${items.length} item${items.length === 1 ? '' : 's'}`,
        items: items.map(({ z, ...rest }) => rest),
      }
    })
    .filter((g) => g.items.length)
  const cmdIntro = alerts.length
    ? `What needs attention right now: ${alerts.length} breakout${alerts.length === 1 ? '' : 's'} across ${priorities.length} priorit${priorities.length === 1 ? 'y' : 'ies'}.`
    : null

  // Watchlists — one real group of the accounts actually in the intelligence pipeline.
  const alertingSet = new Set(alerts.map((a) => a.username))
  const watchlists = top.length
    ? [
        {
          name: 'Tracked competitors',
          desc: 'Accounts in the intelligence pipeline',
          owner: 'GF',
          ownerTint: '#9CD3AE',
          alerts: 'Viral > 2× median · z-score breakouts',
          members: top.map((a) => {
            const f = followers.get(a.username)
            return {
              name: a.displayName ?? a.username,
              followers: f != null ? fmt(Number(f)) : '—',
              growth: '—',
              status: alertingSet.has(a.username) ? 'Alerting' : 'Tracking',
            }
          }),
        },
      ]
    : null

  // Anomalies — a z-score breakout is a real deviation from the account's median.
  const anomalies = alerts.slice(0, 3).map((a) => {
    const mult = a.multiplier ?? 1
    const pct = Math.round((mult - 1) * 100)
    return {
      title: `@${a.username} video ${mult >= 1 ? mult.toFixed(1) + '×' : 'above'} its median`,
      exp: '1.0× median',
      act: `${mult.toFixed(1)}×`,
      diff: `+${pct.toLocaleString('en-US')}%`,
      color: a.zScore >= 20 ? '#C43D3D' : a.zScore >= 8 ? '#B8791A' : '#1E7F4F',
      expW: `${Math.max(2, Math.min(100, 100 / Math.max(mult, 1)))}%`,
      actW: '100%',
    }
  })

  // AI Brief — the "WHAT" (and "WHY" when analysed) are real; headline/NOW stay templated (need an LLM).
  const brief = briefSeed
    ? {
        // Seed fields so the AI Content Brief screen can create a REAL brief row
        // linked back to the competitor video that inspired it.
        videoId: briefSeed.videoId,
        username: briefSeed.username,
        hookType: briefSeed.hookType,
        durationS: briefSeed.durationS,
        formatSummary: briefSeed.formatSummary,
        views: briefSeed.views,
        multiplier: briefSeed.multiplier,
        // Headline and NOW are DERIVED, not generated. The design shipped
        // hardcoded placeholder prose here naming competitors and creators that
        // do not exist ("Bare Bites", "@fuelwithfern"); in the most prominent
        // slot on the dashboard that reads as fabricated intelligence. These
        // state the measured fact and the next real step instead.
        headline: `@${briefSeed.username}'s video is running ${briefSeed.multiplier ? briefSeed.multiplier.toFixed(1) + '× its account median' : 'well above its account median'}${briefSeed.accelerating ? ' and is still accelerating' : ''}.`,
        now: briefSeed.hookType
          ? `Brief the pattern: ${briefSeed.hookType.replace(/_/g, ' ')} hook${briefSeed.durationS ? ` at ${briefSeed.durationS}s` : ''}. Open the AI Content Brief to draft it.`
          : 'Queue it for analysis to extract the hook and format, then brief the pattern.',
        confidence: briefSeed.baselineN >= 20 ? 'high' : briefSeed.baselineN >= 8 ? 'medium' : 'low',
        sample: `${briefSeed.baselineN} baseline`,
        what: `@${briefSeed.username}'s top video is at ${fmt(briefSeed.views)} views${briefSeed.multiplier ? `, ${briefSeed.multiplier.toFixed(1)}× its median` : ''}${briefSeed.accelerating ? ', still accelerating' : ''}.`,
        why: briefSeed.hookType
          ? `${briefSeed.hookType.replace(/_/g, ' ')} hook${briefSeed.durationS ? `, ${briefSeed.durationS}s runtime` : ''}${briefSeed.formatSummary ? ` — ${briefSeed.formatSummary.slice(0, 90)}` : ''}.`
          : 'Not analysed yet — queue it to break down the hook + format.',
      }
    : null

  return NextResponse.json({
    kpis,
    competitors,
    stats,
    ticker: ticker.length ? ticker : null,
    events: events.length ? events : null,
    topVideos: topVideos.length ? topVideos : null,
    series: chartSeries,
    compBars,
    compLegend: pulse.length ? compLegend : null,
    pulseCallout,
    compAccounts: compAccounts.length ? compAccounts : null,
    alerts: alertGroups.length ? { groups: alertGroups, stats: alertStats, intro: alertsIntro } : null,
    command: priorities.length ? { priorities, anomalies, intro: cmdIntro } : null,
    watchlists,
    brief,
    updatedAt: new Date().toISOString(),
  })
}
