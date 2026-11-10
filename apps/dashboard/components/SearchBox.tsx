'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

const searchIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ width: 15, height: 15, flex: '0 0 auto' }}
  >
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

/**
 * Global search input. Wears the existing `.search` chrome (the class supplies
 * border / surface / padding / gap); the <input> inside is transparent so it
 * blends in. Navigates to /search?q=… on Enter, on submit, or after a short
 * debounce while typing.
 */
export default function SearchBox() {
  const router = useRouter()
  const params = useSearchParams()
  const [value, setValue] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep the box in sync with the active query (e.g. arriving on /search, or
  // navigating back/forward).
  useEffect(() => {
    setValue(params.get('q') ?? '')
  }, [params])

  // Clear any pending debounce on unmount.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const go = (q: string) => {
    const t = q.trim()
    router.push(t ? `/search?q=${encodeURIComponent(t)}` : '/search')
  }

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value
    setValue(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => go(next), 350)
  }

  const submit = () => {
    if (timer.current) clearTimeout(timer.current)
    go(value)
  }

  return (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {searchIcon}
      <input
        type="search"
        name="q"
        value={value}
        onChange={onChange}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Search competitors, videos, creators…"
        aria-label="Search competitors, videos and creators"
        autoComplete="off"
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: 'var(--text)',
          font: 'inherit',
          fontSize: 13,
          padding: 0,
          margin: 0,
        }}
      />
    </form>
  )
}
