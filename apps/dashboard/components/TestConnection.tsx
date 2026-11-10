'use client'

import { useState, useTransition } from 'react'
import { testConnection, type TestResult } from '@/lib/conn-actions'

export default function TestConnection({ id }: { id: string }) {
  const [res, setRes] = useState<TestResult | null>(null)
  const [pending, start] = useTransition()

  const color = res ? (res.ok ? 'var(--pos)' : res.detail.startsWith('configured') ? 'var(--muted)' : 'var(--neg)') : 'var(--muted)'

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <button
        className="btn"
        disabled={pending}
        aria-busy={pending}
        onClick={() => start(async () => setRes(await testConnection(id)))}
      >
        {pending ? 'Testing…' : 'Test'}
      </button>
      {res && (
        <span aria-live="polite" style={{ fontSize: 12.5, color, fontWeight: 500 }}>
          {res.ok ? '✓ ' : res.detail.startsWith('configured') ? '• ' : '✗ '}
          {res.detail}
        </span>
      )}
    </span>
  )
}
