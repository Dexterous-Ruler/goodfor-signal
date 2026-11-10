import { getAccounts, getAccountViews } from '@/lib/queries'

export const dynamic = 'force-dynamic'

const n = (v: number | null) => (v === null ? '—' : Math.round(v).toLocaleString('en-GB'))
const fmt = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : String(Math.round(v))

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const m = (Date.now() - new Date(iso).getTime()) / 60_000
  if (m < 60) return `${Math.round(m)}m ago`
  if (m < 2880) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / 1440)}d ago`
}

export default async function AccountsPage() {
  const [accounts, views] = await Promise.all([getAccounts(), getAccountViews()])

  const totalVideos = accounts.reduce((s, a) => s + a.videoCount, 0)
  const totalFollowers = accounts.reduce((s, a) => s + (a.followerCount ?? 0), 0)
  const totalViews = accounts.reduce((s, a) => s + (views[a.id] ?? 0), 0)

  return (
    <main>
      <h1>Tracked accounts</h1>
      <p className="sub">
        Competitor accounts under active polling. Metrics are derived from profile listings rather
        than per-video calls &mdash; the listing already carries every video&rsquo;s counts, which
        keeps the data bill roughly 4&times; lower.
      </p>

      <div className="stats">
        <div className="stat"><div className="n">{n(accounts.length)}</div><div className="l">accounts</div></div>
        <div className="stat"><div className="n">{n(totalVideos)}</div><div className="l">videos tracked</div></div>
        <div className="stat"><div className="n">{totalFollowers > 0 ? fmt(totalFollowers) : '—'}</div><div className="l">followers</div></div>
        <div className="stat"><div className="n">{totalViews > 0 ? fmt(totalViews) : '—'}</div><div className="l">views</div></div>
      </div>

      <div className="card">
        <div className="card-head">Accounts <span className="ch-r">active polling</span></div>
        {accounts.length === 0 ? (
          <div className="empty">
            No accounts tracked.
            <br />
            <br />
            <code>npm run seed -- competitor1 competitor2</code>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Name</th>
                <th className="num">Followers</th>
                <th className="num">Videos</th>
                <th className="num">Views</th>
                <th>Last poll</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className="handle">@{a.username}</span>
                  </td>
                  <td>{a.displayName ?? '—'}</td>
                  <td className="num">{n(a.followerCount)}</td>
                  <td className="num">{n(a.videoCount)}</td>
                  <td className="num">{views[a.id] ? fmt(views[a.id]!) : '—'}</td>
                  <td>
                    <span className="handle">{ago(a.lastSynced)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="note">
        The views column sums the latest snapshot of every tracked video per account &mdash; the same
        derivation the overview&rsquo;s top-competitors rail uses, so the two never disagree. Followers
        come straight from the profile listing at last poll.
      </p>
    </main>
  )
}
