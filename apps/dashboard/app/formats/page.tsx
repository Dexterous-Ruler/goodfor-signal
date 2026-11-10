import { getFormats, getHookPerformance, getAnalysisProgress } from '@/lib/queries'

export const dynamic = 'force-dynamic'

const n = (v: number | null) => (v === null ? '—' : Math.round(v).toLocaleString('en-GB'))

const HOOK_LABELS: Record<string, string> = {
  direct_address: 'Direct address',
  question: 'Question',
  negative_claim: 'Negative claim',
  result_reveal: 'Result reveal',
  before_after: 'Before / after',
  listicle_countdown: 'Listicle countdown',
  pattern_interrupt: 'Pattern interrupt',
  text_only_static: 'Text-only static',
  duet_react: 'Duet / react',
  pov_scenario: 'POV scenario',
  price_reveal: 'Price reveal',
  controversy_bait: 'Controversy bait',
  unknown: 'Unclassified',
}

export default async function FormatsPage() {
  const [formats, hooks, progress] = await Promise.all([
    getFormats(),
    getHookPerformance(),
    getAnalysisProgress(),
  ])

  const pct = progress.videos > 0 ? Math.round((progress.analysed / progress.videos) * 100) : 0

  return (
    <main>
      <h1>Formats &amp; hooks</h1>
      <p className="sub">
        What kind of video actually works in this category &mdash; derived from transcribing and
        analysing competitor content, not from one viral example.
      </p>

      <div className="stats">
        <div className="stat">
          <div className="n">{n(progress.analysed)}</div>
          <div className="l">analysed</div>
        </div>
        <div className="stat">
          <div className="n">{pct}%</div>
          <div className="l">of corpus</div>
        </div>
        <div className="stat">
          <div className="n">{n(progress.pending)}</div>
          <div className="l">queued</div>
        </div>
        <div className="stat">
          <div className="n">${progress.totalCost.toFixed(2)}</div>
          <div className="l">spent</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 32 }}>
        <div className="card-head">Hook performance <span className="ch-r">median z at 6h</span></div>
        {hooks.length === 0 ? (
          <div className="empty">
            No videos analysed yet.
            <br />
            <br />
            <code>npm run analyse:enqueue</code>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Hook type</th>
                <th className="num">Videos</th>
                <th className="num">Median z at 6h</th>
              </tr>
            </thead>
            <tbody>
              {hooks.map((h) => (
                <tr key={h.hookType}>
                  <td>{HOOK_LABELS[h.hookType] ?? h.hookType}</td>
                  <td className="num">{n(h.count)}</td>
                  <td className="num">{h.medianZ === null ? '—' : h.medianZ.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">Format clusters <span className="ch-r">weekly re-fit</span></div>
        {formats.length === 0 ? (
          <div className="empty">
            No clusters yet. Clustering re-fits weekly once enough videos are analysed.
            <br />
            <br />
            <code>npm run analyse:refit</code>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Format</th>
                <th className="num">Members</th>
                <th className="num">Median views</th>
                <th className="num">Median z</th>
              </tr>
            </thead>
            <tbody>
              {formats.map((f) => (
                <tr key={f.id}>
                  <td>
                    {f.id === -1 ? (
                      <span className="pill alert">novel / unclustered</span>
                    ) : (
                      <strong>{f.label}</strong>
                    )}
                    {f.definition && <span className="desc">{f.definition}</span>}
                  </td>
                  <td className="num">{n(f.memberCount)}</td>
                  <td className="num">{n(f.medianViews)}</td>
                  <td className="num">{f.medianZ === null ? '—' : f.medianZ.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="note">
        Cluster &minus;1 is the unassigned bucket &mdash; videos that match no known format. In
        competitor intelligence those are the most valuable rows on this page, not noise: a format
        nobody has a label for yet is the one worth watching.
      </p>
    </main>
  )
}
