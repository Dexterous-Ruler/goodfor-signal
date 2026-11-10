import { getConnectionStatus, INTEGRATIONS, PLANE_LABEL, type Plane } from '@/lib/connections'
import TestConnection from '@/components/TestConnection'

export const dynamic = 'force-dynamic'

const PLANES: Plane[] = ['read', 'ai', 'write', 'attribution', 'creators']

export default function ConnectionsPage() {
  const status = new Map(getConnectionStatus().map((s) => [s.id, s]))
  const total = INTEGRATIONS.length
  const configured = INTEGRATIONS.filter((it) => status.get(it.id)?.configured).length

  return (
    <main>
      <h1>Connections</h1>
      <p className="sub">
        Add a credential here and its checkpoint unblocks &mdash; the moment a key lands, real data
        replaces the demo numbers across the dashboard. Keys live only in your gitignored{' '}
        <code>.env.local</code>; this page shows status, never the secret itself.
      </p>

      <div className="stats" style={{ maxWidth: 520 }}>
        <div className="stat"><div className="n">{configured}<span style={{ fontSize: 15, color: 'var(--muted)' }}> / {total}</span></div><div className="l">configured</div></div>
        <div className="stat"><div className="n">{INTEGRATIONS.filter((i) => i.plane === 'ai' && status.get(i.id)?.configured).length}<span style={{ fontSize: 15, color: 'var(--muted)' }}> / 3</span></div><div className="l">AI · live</div></div>
        <div className="stat"><div className="n">{status.get('ensembledata')?.configured ? 'on' : 'off'}</div><div className="l">read plane</div></div>
      </div>

      {PLANES.map((plane) => {
        const items = INTEGRATIONS.filter((it) => it.plane === plane)
        const meta = PLANE_LABEL[plane]
        return (
          <section key={plane} style={{ marginBottom: 22 }}>
            <h2 className="sec">{meta.title} <span className="ch-r" style={{ fontWeight: 500 }}>{meta.note}</span></h2>
            <div className="card">
              {items.map((it, i) => {
                const st = status.get(it.id)
                return (
                  <div
                    key={it.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0,1fr) auto',
                      gap: 14,
                      alignItems: 'center',
                      padding: '15px 18px',
                      borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 14 }}>{it.name}</strong>
                        {st?.configured ? (
                          <span className="pill ok">configured</span>
                        ) : (
                          <span className="pill">not set</span>
                        )}
                        <span className="pill" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>unlocks {it.unlocks}</span>
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 5 }}>{it.note}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 6, fontFamily: 'var(--mono)' }}>
                        {st && st.present.length > 0
                          ? st.present.map((p) => `${p.name}=${p.masked}`).join('  ')
                          : it.envVars.join('  ')}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifySelf: 'end' }}>
                      {it.testable && <TestConnection id={it.id} />}
                      <a className="btn" href={it.signupUrl} target="_blank" rel="noopener noreferrer">Get key ↗</a>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}

      <p className="note">
        To add a key: open <code>.env.local</code> in the project root, add the variable (see
        <code> .env.example</code> for the exact names and notes), save, and restart the dev server &mdash;
        or paste it in chat and I&rsquo;ll wire it in. Read-plane and AI keys can be tested live above;
        OAuth / signed-JWT / paid vendors verify on their first real call.
      </p>
    </main>
  )
}
