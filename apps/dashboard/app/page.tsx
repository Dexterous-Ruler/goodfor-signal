import StackedBarChart from '@/components/StackedBarChart'
import ArcGauge from '@/components/ArcGauge'
import Donut from '@/components/Donut'
import ScanButton from '@/components/ScanButton'
import {
  getAlerts, getStats, getMetricTotals, getMetricSeries, getTopAccounts, getAnalysisProgress,
} from '@/lib/queries'

export const dynamic = 'force-dynamic'

const fmt = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : String(Math.round(v))
const n = (v: number) => Math.round(v).toLocaleString('en-GB')

export default async function OverviewPage() {
  const [alerts, stats, totals, series, topAccounts, progress] = await Promise.all([
    getAlerts(), getStats(), getMetricTotals(), getMetricSeries(), getTopAccounts(), getAnalysisProgress(),
  ])

  const alertRate = stats.videos > 0 ? Math.round((alerts.length / stats.videos) * 100) : 0
  const coverage = progress.videos > 0 ? Math.round((progress.analysed / progress.videos) * 100) : 0
  const window = series.length > 1 ? `${series[0]!.label} – ${series[series.length - 1]!.label}` : '—'

  const kpis = [
    { l: 'Views', v: totals.views, c: 'var(--c-line)' },
    { l: 'Likes', v: totals.likes, c: 'var(--c-gold)' },
    { l: 'Comments', v: totals.comments, c: 'var(--c-teal)' },
    { l: 'Shares', v: totals.shares, c: 'var(--c-purple)' },
    { l: 'Live alerts', v: alerts.length, c: 'var(--accent)' },
  ]
  const donut = [
    { label: 'Likes', value: totals.likes, color: 'var(--c-gold)' },
    { label: 'Comments', value: totals.comments, color: 'var(--c-teal)' },
    { label: 'Shares', value: totals.shares, color: 'var(--c-purple)' },
  ]

  return (
    <main>
      <div className="toolbar">
        <div>
          <div className="hi" style={{ color: 'var(--muted)', fontSize: 14 }}>Welcome back, Karim</div>
          <h1 style={{ marginTop: 2 }}>Signal overview</h1>
        </div>
        <div className="controls">
          <span className="btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /></svg> Aug 07 – 15</span>
          <ScanButton />
        </div>
      </div>

      <div className="fuse">
        {/* LEFT rail */}
        <div className="fcol">
          <div className="card">
            <div className="card-head">Outperformance <span className="ch-r">rate</span></div>
            <ArcGauge value={alertRate} label="alert rate" color="var(--accent)" />
            <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12.5, padding: '0 0 16px' }}>
              {n(alerts.length)} of {n(stats.videos)} videos firing
            </div>
          </div>

          <div className="card">
            <div className="card-head">Engagement split <span className="ch-r">lifetime</span></div>
            <div className="donut-wrap">
              <Donut segments={donut} centerValue={totals.engagement > 0 ? fmt(totals.engagement) : '—'} centerLabel="engagement" />
            </div>
            <div className="legend">
              {donut.map((s) => (
                <div className="lrow" key={s.label}><span className="ld" style={{ background: s.color }} />{s.label}<span className="lv">{n(s.value)}</span></div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">Corpus</div>
            <div className="mini">
              <div className="mit"><div className="mk">Accounts</div><div className="mn">{n(stats.accounts)}</div></div>
              <div className="mit"><div className="mk">Videos</div><div className="mn">{n(stats.videos)}</div></div>
              <div className="mit"><div className="mk">Snapshots</div><div className="mn">{n(stats.snapshots)}</div></div>
              <div className="mit"><div className="mk">Analysed</div><div className="mn">{n(progress.analysed)}</div></div>
            </div>
          </div>
        </div>

        {/* CENTER */}
        <div className="fcol">
          <div className="kpistrip">
            {kpis.map((k) => (
              <div className="m" key={k.l} style={{ ['--mc' as string]: k.c }}>
                <div className="ml">{k.l}</div>
                <div className="mv">{fmt(k.v)}</div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-head">Engagement over time <span className="ch-r">{window}</span></div>
            <div className="chart-pad"><StackedBarChart data={series} /></div>
            <div className="hlegend">
              <span><span className="d" style={{ background: 'var(--c-gold)' }} /> Likes</span>
              <span><span className="d" style={{ background: 'var(--c-purple)' }} /> Comments</span>
              <span><span className="d" style={{ background: 'var(--c-teal)' }} /> Shares</span>
              <span><span className="d" style={{ background: 'var(--c-line)' }} /> Views (line)</span>
            </div>
          </div>
        </div>

        {/* RIGHT rail */}
        <div className="fcol">
          <div className="card">
            <div className="card-head">Details</div>
            <div className="kvrow"><span className="k">Window</span><span className="v">{window}</span></div>
            <div className="kvrow"><span className="k">Videos tracked</span><span className="v">{n(stats.videos)}</span></div>
            <div className="kvrow"><span className="k">Snapshots</span><span className="v">{n(stats.snapshots)}</span></div>
            <div className="kvrow"><span className="k">Data source</span><span className="v">EnsembleData · live</span></div>
          </div>

          <div className="card">
            <div className="card-head">Analysis coverage <span className="ch-r">phase 2</span></div>
            <div className="exec">
              <div className="big">{coverage}%<span className="chg">{n(progress.pending)} queued</span></div>
              <div className="segbar">
                {Array.from({ length: 14 }).map((_, i) => (
                  <i key={i} className={i < Math.round((coverage / 100) * 14) ? 'on' : undefined} />
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">Top competitors <span className="ch-r">by views</span></div>
            <div style={{ padding: '0 0 8px' }}>
              {topAccounts.length === 0 ? (
                <div className="col-empty" style={{ padding: '14px 18px' }}>No accounts yet</div>
              ) : (
                topAccounts.map((a, i) => (
                  <div className="entity" key={a.username}>
                    <span className="ec">{i + 1}</span>
                    <div>
                      <div style={{ fontWeight: 600 }}>@{a.username}</div>
                      <div className="handle">{n(a.videos)} videos</div>
                    </div>
                    <span className="ev">{fmt(a.views)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <p className="note">
        Engagement over time buckets every metric snapshot across its full capture window; the views line
        is on its own scale. Outperformance rate is alert-firing videos over the tracked corpus.
      </p>
    </main>
  )
}
