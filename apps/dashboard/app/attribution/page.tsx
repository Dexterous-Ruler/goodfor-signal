import Page from '@/components/Page'
import Funnel from '@/components/Funnel'
import {
  getAttributionFunnel,
  getVideoInstalls,
  getControlTotal,
  getIncrementality,
} from '@/lib/write-queries'

export const dynamic = 'force-dynamic'

const n = (v: number) => v.toLocaleString('en-GB')
const usd = (cents: number | null) => (cents === null ? '—' : `$${(cents / 100).toFixed(2)}`)
const C = { blue: 'var(--accent)', purple: 'var(--s-slate)', teal: 'var(--cool)' }

export default async function AttributionPage() {
  const [funnel, videos, control, tests] = await Promise.all([
    getAttributionFunnel(),
    getVideoInstalls(),
    getControlTotal(),
    getIncrementality(),
  ])

  const cols = [
    { label: 'Installs', value: funnel.installs, color: C.blue },
    { label: 'Signups', value: funnel.signups, color: C.purple },
    { label: 'Subscriptions', value: funnel.subscriptions, color: C.teal },
  ]
  const drift = control.appleAppReferrer - control.attributedTotal

  return (
    <Page title="Attribution" right={<span className="btn">View Events</span>}>
      {/* analytics panel — metric columns + funnel */}
      <div className="analytics">
        <div className="an-tools">
          <span className="tg">$ 123</span>
        </div>
        <div className="an-head">
          {cols.map((c, i) => (
            <div className={`an-cell${i === 0 ? ' on' : ''}`} key={c.label}>
              <div className="an-l"><span className="sq" style={{ background: c.color }} />{c.label}</div>
              <div className="an-n">{n(c.value)}</div>
              {i < cols.length - 1 && <span className="chev">›</span>}
            </div>
          ))}
        </div>
        <div className="an-funnel">
          <div className="divs"><span style={{ left: '33.333%' }} /><span style={{ left: '66.666%' }} /></div>
          <Funnel steps={cols.map((c) => ({ label: c.label, value: c.value, color: c.color }))} />
        </div>
      </div>

      <p className="sec-sub">
        Android is deterministic per video (<code>utm_content=&lt;video_id&gt;</code>); iOS is a
        channel-level control total, never a per-video ledger.
      </p>

      {/* tabbed footer */}
      <div className="cols2" style={{ marginTop: 20 }}>
        <div className="card">
          <div className="tabbar">
            <span className="tab on">By video</span>
            <span className="tab">By UTM</span>
            <span className="tab-r">Installs</span>
          </div>
          {videos.length === 0 ? (
            <div className="empty">
              No installs attributed yet.<br /><br /><code>npm run attribute:once</code>
            </div>
          ) : (
            <table>
              <tbody>
                {videos.slice(0, 7).map((v, i) => {
                  const total = v.androidInstalls + v.iosInstalls
                  return (
                    <tr key={i}>
                      <td>
                        <span className="linkpill">
                          <span className="av" style={{ background: C.blue }} />
                          <span className="lk">{v.utmContent ?? (v.featuredPostId ? `post/${v.featuredPostId}` : 'unattributed')}</span>
                        </span>
                      </td>
                      <td className="num"><strong>{n(total)}</strong></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="tabbar">
            <span className="tab on">Channels</span>
            <span className="tab">Sources</span>
            <span className="tab-r">Installs</span>
          </div>
          <table>
            <tbody>
              <tr>
                <td><span className="linkpill"><span className="av" style={{ background: C.teal }} /><span className="lk">Apple · App referrer</span></span></td>
                <td className="num"><strong>{n(control.appleAppReferrer)}</strong></td>
              </tr>
              <tr>
                <td><span className="linkpill"><span className="av" style={{ background: C.purple }} /><span className="lk">Attributed (all videos)</span></span></td>
                <td className="num"><strong>{n(control.attributedTotal)}</strong></td>
              </tr>
              <tr>
                <td className="handle" style={{ paddingLeft: 18 }}>Reconciliation drift</td>
                <td className="num"><strong style={{ color: Math.abs(drift) > 6 ? 'var(--bad)' : 'var(--ok)' }}>{drift >= 0 ? '+' : ''}{n(drift)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-head">Incrementality &amp; organic CPI <span className="ch-r">pause test</span></div>
        {tests.length === 0 ? (
          <div className="empty">
            No pause test run yet. The organic CPI is <em>computed</em> from a single-channel pause
            test &mdash; there is no published TikTok organic CPI to borrow.
            <br />
            <br />
            <code>npm run attribute:lift</code>
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>Method</th><th>Channel</th><th className="num">Incremental installs</th><th className="num">Organic CPI</th></tr>
            </thead>
            <tbody>
              {tests.map((t) => (
                <tr key={t.id}>
                  <td>{t.method.replace(/_/g, ' ')}</td>
                  <td className="handle">{t.channel}</td>
                  <td className="num">{t.incrementalInstalls === null ? '—' : n(t.incrementalInstalls)}</td>
                  <td className="num"><strong>{usd(t.computedCpiCents)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  )
}
