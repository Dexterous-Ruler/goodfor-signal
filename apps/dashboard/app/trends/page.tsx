import { getTrends } from '@/lib/queries'

export const dynamic = 'force-dynamic'

const n = (v: number | null) => (v === null ? '—' : Math.round(v).toLocaleString('en-GB'))

export default async function TrendsPage() {
  const trends = await getTrends()

  const rising = trends.filter((t) => t.state === 'rising').length
  const peaked = trends.filter((t) => t.state === 'peaked').length
  const topBurst = trends.reduce((m, t) => Math.max(m, t.burstWeight ?? 0), 0)

  return (
    <main>
      <h1>Keyword &amp; hashtag trends</h1>
      <p className="sub">
        Terms classified by the sign pair of velocity and acceleration. Rising means still
        accelerating &mdash; worth acting on. Peaked means past the inflection point, only worth it
        if you can ship within hours.
      </p>

      <div className="stats">
        <div className="stat"><div className="n">{n(trends.length)}</div><div className="l">terms tracked</div></div>
        <div className="stat"><div className="n">{n(rising)}</div><div className="l">rising now</div></div>
        <div className="stat"><div className="n">{n(peaked)}</div><div className="l">peaked</div></div>
        <div className="stat"><div className="n">{topBurst > 0 ? topBurst.toFixed(2) : '—'}</div><div className="l">top burst</div></div>
      </div>

      <div className="card">
        <div className="card-head">Tracked terms <span className="ch-r">latest observation</span></div>
        {trends.length === 0 ? (
          <div className="empty">
            No terms tracked yet.
            <br />
            <br />
            <code>npm run trends -- --add hashtag:fyp</code>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Term</th>
                <th>Type</th>
                <th>State</th>
                <th className="num">Burst</th>
                <th className="num">Posts</th>
                <th className="num">Views</th>
              </tr>
            </thead>
            <tbody>
              {trends.map((t) => (
                <tr key={`${t.termType}:${t.term}`}>
                  <td>{t.termType === 'hashtag' ? `#${t.term}` : t.term}</td>
                  <td>
                    <span className="handle">{t.termType}</span>
                  </td>
                  <td>
                    {t.state ? (
                      <span className={`pill ${t.state === 'rising' ? 'rising' : ''}`}>
                        {t.state}
                      </span>
                    ) : (
                      <span className="pill">building history</span>
                    )}
                  </td>
                  <td className="num">{t.burstWeight === null ? '—' : t.burstWeight.toFixed(2)}</td>
                  <td className="num">{n(t.postCount)}</td>
                  <td className="num">{n(t.viewCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="note">
        Burst is the recent rate over the baseline rate for that term. A minimum volume floor keeps
        a term going from 2 to 120 posts from outranking one going from 40,000 to 900,000 &mdash;
        percentage growth alone would put the noise on top.
      </p>
    </main>
  )
}
