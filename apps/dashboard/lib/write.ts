import { resolve } from 'node:path'
import { db, loadEnv } from '@goodfor/db'

// Monorepo env lives at the repo root and the app dir; load both, root first
// (mirrors lib/queries.ts). Must run before any db() call reads process.env.
loadEnv(resolve(process.cwd(), '..', '..'))
loadEnv()

export { db }

/**
 * Write-plane API helpers for the dashboard.
 *
 * Plane isolation (see completion.md §1.3): this layer only writes DB rows via
 * the service-role client. It NEVER holds a write-plane-only secret
 * (TIKTOK_CLIENT_SECRET / TOKEN_ENCRYPTION_KEY) and NEVER calls TikTok. Actual
 * publishing and OAuth run in the separate `worker-write` deployment, which
 * drains the `scheduled_post` rows this layer inserts.
 */

/** Minimal RFC-4180 CSV serialiser. Columns are taken from the first row. */
export function toCsv(rows: Record<string, unknown>[]): string {
  const first = rows[0]
  if (!first) return ''
  const cols = Object.keys(first)
  const esc = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n')
}

/** Parse a JSON body, tolerating an empty/invalid body by returning {}. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json()
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
