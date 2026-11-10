'use client'

import { useState, useTransition } from 'react'
import { refreshData } from '@/lib/actions'

/**
 * Primary "+ New scan" control. Calls the refreshData server action inside a
 * transition so the button reflects pending state while every dashboard page
 * revalidates, then flashes a brief confirmation.
 *
 * Note: this refreshes rendered data — the vendor poll and analysis run as
 * separate worker processes, not inline here (plane isolation).
 */
export default function ScanButton() {
  const [pending, startTransition] = useTransition()
  const [done, setDone] = useState(false)

  const onClick = () => {
    if (pending) return
    setDone(false)
    startTransition(async () => {
      await refreshData()
      setDone(true)
      // Revert the confirmation label after a beat.
      setTimeout(() => setDone(false), 2000)
    })
  }

  const label = pending ? 'Refreshing…' : done ? 'Refreshed' : '+ New scan'

  return (
    <button
      type="button"
      className="btn primary"
      onClick={onClick}
      disabled={pending}
      aria-busy={pending}
      aria-live="polite"
      title="Refresh dashboard data"
      style={{ cursor: pending ? 'default' : 'pointer', opacity: pending ? 0.72 : 1 }}
    >
      {label}
    </button>
  )
}
