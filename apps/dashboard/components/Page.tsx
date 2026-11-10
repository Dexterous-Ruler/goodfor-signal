import type { ReactNode } from 'react'

const filterIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
)
const calIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
)
const dotsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="5" r="0.6" /><circle cx="12" cy="12" r="0.6" /><circle cx="12" cy="19" r="0.6" /></svg>
)

export default function Page({
  title,
  right,
  children,
}: {
  title: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <div className="pagehead">
        <h1>{title}</h1>
        <div className="toolbar">
          <div className="controls">
            <span className="btn">{filterIcon} Filter</span>
            <span className="btn">{calIcon} Last 24 hours</span>
          </div>
          <div className="controls">
            {right ?? <span className="btn">View Events</span>}
            <span className="btn icon">{dotsIcon}</span>
          </div>
        </div>
      </div>
      <div className="content">{children}</div>
    </>
  )
}
