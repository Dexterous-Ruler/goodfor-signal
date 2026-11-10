import { Suspense } from 'react'
import ThemeToggle from '@/components/ThemeToggle'
import SearchBox from '@/components/SearchBox'

const ic = (p: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{p}</svg>
)

export default function TopStrip() {
  return (
    <div className="topbar">
      <span className="crumb"><b>Workspace</b> · Goodfor</span>
      <Suspense fallback={<div className="search" aria-hidden="true" />}>
        <SearchBox />
      </Suspense>
      <div className="right">
        <ThemeToggle />
        <span className="iconbtn">{ic(<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>)}</span>
        <span className="userchip">
          <span className="av">KO</span>
          <span className="who"><b>Karim</b><span>Admin</span></span>
        </span>
      </div>
    </div>
  )
}
