import { getCreatorPipeline, getCreatorStats, getRightsAlerts } from '@/lib/write-queries'

export const dynamic = 'force-dynamic'

const n = (v: number) => v.toLocaleString('en-GB')
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const followers = (v: number | null) =>
  v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(v)
const rate = (cents: number | null, cur: string | null) =>
  cents === null ? '' : `${cur === 'USD' || !cur ? '$' : ''}${Math.round(cents / 100)}`
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'

export default async function CreatorsPage() {
  const [pipeline, stats, rights] = await Promise.all([
    getCreatorPipeline(),
    getCreatorStats(),
    getRightsAlerts(),
  ])
  const totalInPipeline = pipeline.reduce((s, c) => s + c.count, 0)

  return (
    <main>
      <h1>Creators</h1>
      <p className="sub">
        The UGC creator CRM. The <em>collaboration</em> moves through the pipeline &mdash; not the
        creator &mdash; because one creator sits at different stages for different Goodfor apps at
        once. Rights are tracked so no paid ad ever runs on an expired licence.
      </p>

      <div className="stats">
        <div className="stat"><div className="n">{n(stats.creators)}</div><div className="l">creators sourced</div></div>
        <div className="stat"><div className="n">{n(totalInPipeline)}</div><div className="l">in pipeline</div></div>
        <div className="stat"><div className="n">{n(stats.live)}</div><div className="l">live</div></div>
        <div className="stat"><div className="n">{n(stats.rightsTracked)}</div><div className="l">rights tracked</div></div>
      </div>

      <h2 className="sec">Pipeline</h2>
      {totalInPipeline === 0 ? (
        <div className="card">
          <div className="empty">
            No collaborations yet. Discovery sources creators from Modash (capturing credibility at
            search time), then outreach begins &mdash; one DM, then email.
            <br /><br />
            <code>npm run creators:discovery</code>
          </div>
        </div>
      ) : (
        <div className="board">
          {pipeline.map((col) => (
            <div className="col" key={col.stage}>
              <div className="col-head">
                <span>{cap(col.stage)}</span>
                <span className="cnt">{col.count}</span>
              </div>
              {col.cards.length === 0 ? (
                <div className="col-empty">—</div>
              ) : (
                col.cards.map((c) => (
                  <div className="deal" key={c.id}>
                    <div className="who">@{c.username}</div>
                    <div className="meta">
                      <span>{followers(c.followers)} · {c.platform}</span>
                      <span>{rate(c.rateCents, c.currency)}</span>
                    </div>
                    {c.appSlug && <div className="meta"><span>{c.appSlug}</span></div>}
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-head">Rights &amp; licences <span className="ch-r">expiry watch</span></div>
        {rights.length === 0 ? (
          <div className="empty">
            No rights grants yet. Every collaboration ships a <code>rights_grant</code> once it reaches
            contracted &mdash; a live paid ad on an expired licence is the top routine legal exposure.
            Start the pipeline and grants follow.
            <br />
            <br />
            <code>npm run creators:discovery</code>
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>Creator</th><th>Usage scope</th><th>Stage</th><th>Licence ends</th><th>State</th></tr>
            </thead>
            <tbody>
              {rights.map((r) => {
                const expired = r.expiresAt !== null && new Date(r.expiresAt) < new Date()
                const soon =
                  r.expiresAt !== null &&
                  !expired &&
                  new Date(r.expiresAt).getTime() - Date.now() < 14 * 864e5
                const liveExpired = expired && r.stage === 'live'
                return (
                  <tr key={r.id}>
                    <td className="handle">{r.username ? `@${r.username}` : '—'}</td>
                    <td><span className="pill">{r.usageScope.replace(/_/g, ' ')}</span></td>
                    <td>{r.stage ?? '—'}</td>
                    <td className="handle">{day(r.expiresAt)}</td>
                    <td>
                      {liveExpired ? (
                        <span className="pill bad">expired &amp; live</span>
                      ) : expired ? (
                        <span className="pill warn">expired</span>
                      ) : soon ? (
                        <span className="pill warn">expiring</span>
                      ) : (
                        <span className="pill ok">active</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </main>
  )
}
