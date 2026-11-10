import {
  getScheduledPosts,
  getBriefs,
  getOwnedAccounts,
  getPublishStats,
} from '@/lib/write-queries'

export const dynamic = 'force-dynamic'

const n = (v: number) => v.toLocaleString('en-GB')
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

const STATUS: Record<string, { cls: string; label: string }> = {
  draft: { cls: 'cool', label: 'Draft' },
  queued: { cls: 'warn', label: 'Queued' },
  uploading: { cls: 'warn', label: 'Uploading' },
  pending: { cls: 'warn', label: 'Pending' },
  published: { cls: 'ok', label: 'Published' },
  failed: { cls: 'bad', label: 'Failed' },
  cancelled: { cls: 'cool', label: 'Cancelled' },
}

export default async function PublishingPage() {
  const [posts, briefs, accounts, stats] = await Promise.all([
    getScheduledPosts(),
    getBriefs(),
    getOwnedAccounts(),
    getPublishStats(),
  ])

  return (
    <main>
      <h1>Publishing</h1>
      <p className="sub">
        The write plane. Detected outperformers become briefs, briefs clear a non-bypassable
        compliance gate, and posts are sent to your accounts&rsquo; TikTok inbox for a human to tap
        publish &mdash; never auto-posted (that category is prohibited).
      </p>

      <div className="stats">
        <div className="stat"><div className="n">{n(stats.accounts)}</div><div className="l">accounts</div></div>
        <div className="stat"><div className="n">{n(stats.drafts)}</div><div className="l">drafts</div></div>
        <div className="stat"><div className="n">{n(stats.pending)}</div><div className="l">in inbox</div></div>
        <div className="stat"><div className="n">{n(stats.published)}</div><div className="l">published</div></div>
      </div>

      <div className="card" style={{ marginBottom: 8 }}>
        <div className="card-head">Post queue <span className="ch-r">human-approved</span></div>
        {posts.length === 0 ? (
          <div className="empty">
            No scheduled posts yet. Connect an account, then the publisher takes over.
            <br /><br />
            <code>npm run publish:oauth</code>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Caption</th>
                <th>Status</th>
                <th>Compliance gate</th>
                <th>Scheduled</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => {
                const s = STATUS[p.status] ?? { cls: 'cool', label: p.status }
                const promo = p.disclosureType !== 'none'
                return (
                  <tr key={p.id}>
                    <td>
                      <span className="handle">@{p.username}</span>{' '}
                      <span className="pill">{p.accountType}</span>
                    </td>
                    <td><span className="desc">{p.caption ?? '—'}</span></td>
                    <td><span className={`dot ${s.cls}`} />{s.label}</td>
                    <td>
                      {!promo ? (
                        <span className="pill">no disclosure needed</span>
                      ) : p.disclosureVerified && p.disclosureRegion ? (
                        <span className="pill ok">disclosed · {p.disclosureRegion}</span>
                      ) : (
                        <span className="pill bad">gate: unverified</span>
                      )}
                      {p.soundIsCml === false && p.accountType === 'business' && (
                        <span className="pill bad" style={{ marginLeft: 6 }}>non-CML sound</span>
                      )}
                    </td>
                    <td className="handle">{when(p.scheduledFor)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="note">
        The disclosure gate is enforced in the database itself (a trigger on <code>scheduled_post</code>),
        not just here &mdash; a promotional post cannot leave <em>draft</em> without a verified,
        region-stamped disclosure. FTC exposure is $53,088/violation; UK CMA up to 10% of turnover.
      </p>

      <div className="card" style={{ marginBottom: 32 }}>
        <div className="card-head">Briefs <span className="ch-r">alert &rarr; format</span></div>
        {briefs.length === 0 ? (
          <div className="empty">No briefs yet. A brief is generated when an alert clears and a proven format is picked &mdash; the write worker turns it into a compliance-gated draft.</div>
        ) : (
          <table>
            <thead>
              <tr><th>App</th><th>Hook</th><th>Target</th><th>Sound</th><th>Status</th></tr>
            </thead>
            <tbody>
              {briefs.map((b) => (
                <tr key={b.id}>
                  <td><strong>{b.appSlug}</strong></td>
                  <td>{b.hookType ?? '—'}</td>
                  <td><span className="pill">{b.targetAccountType}</span></td>
                  <td>{b.soundIsCml === null ? '—' : b.soundIsCml ? <span className="pill ok">CML</span> : <span className="pill">trending</span>}</td>
                  <td>{b.status === 'ready' ? <span className="pill ok">ready</span> : <span className="pill">{b.status}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">Account health <span className="ch-r">rate limits</span></div>
        {accounts.length === 0 ? (
          <div className="empty">
            No owned accounts connected yet.
            <br />
            <br />
            <code>npm run publish:oauth</code>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Account</th><th>Type</th>
                <th className="num">Posts / 24h</th>
                <th className="num">Uploads in flight</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const quarantined = a.quarantinedUntil && new Date(a.quarantinedUntil) > new Date()
                return (
                  <tr key={a.id}>
                    <td className="handle">@{a.username}</td>
                    <td><span className="pill">{a.accountType}</span></td>
                    <td className="num">{a.postsLast24h} <span className="handle">/ 12</span></td>
                    <td className="num">{a.uploadsInFlight} <span className="handle">/ 4</span></td>
                    <td>{quarantined ? <span className="pill bad">quarantined</span> : <span className="pill ok">healthy</span>}</td>
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
