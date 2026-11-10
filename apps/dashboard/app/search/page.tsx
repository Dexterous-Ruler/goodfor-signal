import Link from 'next/link'
import { searchAll } from '@/lib/search'

export const dynamic = 'force-dynamic'

const n = (v: number | null) => (v === null ? '—' : Math.round(v).toLocaleString('en-GB'))

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
    : '—'

const linkStyle: React.CSSProperties = { color: 'var(--accent)', textDecoration: 'none' }

const clamp: React.CSSProperties = {
  display: 'block',
  maxWidth: 560,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const query = (q ?? '').trim()
  const { accounts, videos, creators } = await searchAll(query)
  const total = accounts.length + videos.length + creators.length

  return (
    <main>
      <h1>Search</h1>
      <p className="sub">
        One box across the whole workspace &mdash; competitor accounts and their display names,
        tracked-video descriptions, and sourced creators. Matches are case-insensitive and capped at
        ten per group.
      </p>

      {query === '' ? (
        <div className="card">
          <div className="empty">
            Type a query above to search competitors, videos and creators.
          </div>
        </div>
      ) : total === 0 ? (
        <div className="card">
          <div className="empty">
            No matches for <code>{query}</code>.
          </div>
        </div>
      ) : (
        <>
          {accounts.length > 0 && (
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="card-head">
                Competitor accounts
                <span className="ch-r">{accounts.length}</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Name</th>
                    <th className="num">Followers</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link href="/accounts" className="handle" style={linkStyle}>
                          @{a.username}
                        </Link>
                      </td>
                      <td>{a.displayName ?? '—'}</td>
                      <td className="num">{n(a.followerCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {videos.length > 0 && (
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="card-head">
                Tracked videos
                <span className="ch-r">{videos.length}</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Account</th>
                    <th>Posted</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <a
                          href={`https://www.tiktok.com/@${v.username}/video/${v.platformVideoId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ ...linkStyle, ...clamp }}
                          title={v.description ?? undefined}
                        >
                          {v.description?.trim() || '(no description)'}
                        </a>
                      </td>
                      <td>
                        <span className="handle">@{v.username}</span>
                      </td>
                      <td>
                        <span className="handle">{day(v.postedAt)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {creators.length > 0 && (
            <div className="card">
              <div className="card-head">
                Creators
                <span className="ch-r">{creators.length}</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Creator</th>
                    <th>Platform</th>
                    <th className="num">Followers</th>
                  </tr>
                </thead>
                <tbody>
                  {creators.map((c) => {
                    const label = c.username ? `@${c.username}` : '—'
                    return (
                      <tr key={c.id}>
                        <td>
                          {c.url ? (
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="handle"
                              style={linkStyle}
                            >
                              {label}
                            </a>
                          ) : (
                            <Link href="/creators" className="handle" style={linkStyle}>
                              {label}
                            </Link>
                          )}
                        </td>
                        <td>{c.platform}</td>
                        <td className="num">{n(c.followers)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  )
}
