'use client'

import { useEffect, useState } from 'react'

const sun = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)
const moon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
)

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    const t = (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark'
    setTheme(t)
  }, [])

  const toggle = () => {
    // read the live DOM value so rapid clicks can't desync from stale state
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
    const next: 'dark' | 'light' = cur === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    setTheme(next)
    try { localStorage.setItem('theme', next) } catch {}
  }

  return (
    <button className="iconbtn" onClick={toggle} aria-label="Toggle theme" title="Toggle light / dark">
      {theme === 'dark' ? sun : moon}
    </button>
  )
}
