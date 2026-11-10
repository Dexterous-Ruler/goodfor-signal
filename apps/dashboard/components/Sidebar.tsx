'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

const s = (p: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{p}</svg>
)
const I = {
  overview: s(<><rect x="3" y="3" width="7" height="9" rx="1.2" /><rect x="14" y="3" width="7" height="5" rx="1.2" /><rect x="14" y="12" width="7" height="9" rx="1.2" /><rect x="3" y="16" width="7" height="5" rx="1.2" /></>),
  trends: s(<><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></>),
  formats: s(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></>),
  accounts: s(<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /></>),
  publishing: s(<><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>),
  attribution: s(<><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></>),
  creators: s(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 11l-3 3-1.5-1.5" /></>),
  connections: s(<><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>),
  settings: s(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 6.7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.3 14 1.6 1.6 0 0 0 2 12.6H2a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 6.7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>),
}

const GROUPS = [
  { label: 'Intelligence', links: [
    { href: '/', icon: I.overview, label: 'Overview' },
    { href: '/trends', icon: I.trends, label: 'Trends' },
    { href: '/formats', icon: I.formats, label: 'Formats' },
    { href: '/accounts', icon: I.accounts, label: 'Accounts' },
  ]},
  { label: 'Distribution', links: [
    { href: '/publishing', icon: I.publishing, label: 'Publishing' },
    { href: '/attribution', icon: I.attribution, label: 'Attribution' },
    { href: '/creators', icon: I.creators, label: 'Creators' },
  ]},
  { label: 'Setup', links: [
    { href: '/connections', icon: I.connections, label: 'Connections' },
    { href: '/intelligence.html', icon: I.overview, label: 'Intelligence UI ✨' },
  ]},
]

export default function Sidebar() {
  const path = usePathname()
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href))
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="mark">G</span>
        <b>Goodfor<span> · Signal</span></b>
      </div>
      {GROUPS.map((g) => (
        <div className="navgroup" key={g.label}>
          <div className="gl">{g.label}</div>
          {g.links.map((l) => (
            <a key={l.href} href={l.href} className={active(l.href) ? 'on' : undefined}>
              {l.icon}
              <span>{l.label}</span>
            </a>
          ))}
        </div>
      ))}
      <div className="sp" />
      <div className="foot">
        <a href="/connections" className={active('/connections') ? 'on' : undefined}>{I.settings}<span>Settings</span></a>
      </div>
    </aside>
  )
}
