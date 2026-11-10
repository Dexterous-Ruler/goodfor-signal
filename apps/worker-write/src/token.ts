/**
 * Token vault refresh cron (Phase 3 §Week-11 task 4, §14 refresh-token race).
 *
 * Run as `token.ts --refresh`. For every account nearing its access-token expiry
 * (T-6h), it rotates the OAuth token pair under a per-account lock and RETAINS
 * the previous generation so a failed rotation is recoverable.
 *
 * Four load-bearing rules, none re-litigated:
 *   - LOCK: the rotation runs inside `deps.withAccountLock(id, …)` — a Postgres
 *     advisory lock keyed on `owned_account.id`. Losing this race loses the
 *     account permanently.
 *   - GENERATION GUARD (belt over the lock): the final UPDATE is a compare-and-
 *     swap on `token_generation` (`.eq('token_generation', gen)`). If a
 *     concurrent refresher already rotated, our update matches zero rows and we
 *     abort without clobbering the newer tokens. This is what makes the race
 *     safe even if the advisory lock is unavailable (PgBouncer, etc.).
 *   - RETAIN ONE GENERATION: `prev_access_token`/`prev_refresh_token` receive the
 *     tokens being replaced, and `token_generation` is bumped by 1.
 *   - RE-AUTH FROM INITIAL ISSUANCE: the re-auth prompt deadline is
 *     `original_granted_at + 365d`, NOT `now + refresh_expires_in`. Refresh
 *     tokens expire 365 days from INITIAL issuance; refreshing does not extend
 *     that window. `original_granted_at` is never touched on rotation.
 *
 * Secrets: the CLIENT SECRET (via TikTokOAuthClient) and TOKEN_ENCRYPTION_KEY
 * live only in this write-plane process, never in the dashboard.
 */

import { db } from '@goodfor/db'
import { openToken, sealToken, type TikTokTokens } from '@goodfor/publishing'

import {
  boot,
  bufferToPgBytea,
  makeWriteDeps,
  pgByteaToBuffer,
  type OwnedAccountRow,
  type WriteDeps,
} from './deps.js'

/** Refresh when the access token expires within this window. */
export const REFRESH_LEAD_MS = 6 * 60 * 60 * 1000
/** The refresh-token lifetime that runs from INITIAL issuance. */
export const REAUTH_WINDOW_MS = 365 * 24 * 60 * 60 * 1000
/** Warn the operator to re-authorise when the 365-day window is within this. */
export const REAUTH_WARN_MS = 30 * 24 * 60 * 60 * 1000

export type RotateDisposition = 'rotated' | 'stale' | 'no_refresh_token' | 'error'

export interface RotateResult {
  accountId: number
  disposition: RotateDisposition
  /** When re-authorisation is due (original_granted_at + 365d), if known. */
  reauthDueAt: Date | null
  reauthSoon: boolean
}

/**
 * Rotate one account's tokens. Re-reads the row INSIDE the lock so the
 * generation guard compares against the freshest value. Pure of any global
 * state; everything comes through `deps`.
 */
export async function rotateAccount(deps: WriteDeps, accountId: number): Promise<RotateResult> {
  return deps.withAccountLock(accountId, async () => {
    const account = await loadAccount(deps, accountId)
    if (!account) return { accountId, disposition: 'error' as const, reauthDueAt: null, reauthSoon: false }

    const reauthDueAt = account.original_granted_at
      ? new Date(new Date(account.original_granted_at).getTime() + REAUTH_WINDOW_MS)
      : null
    const reauthSoon =
      reauthDueAt !== null && reauthDueAt.getTime() - deps.now().getTime() < REAUTH_WARN_MS

    const sealedRefresh = pgByteaToBuffer(account.refresh_token)
    if (!sealedRefresh) {
      deps.logger.warn(`[token] account ${accountId}: no refresh_token — needs full re-authorisation`)
      return { accountId, disposition: 'no_refresh_token', reauthDueAt, reauthSoon }
    }

    if (reauthSoon) {
      deps.logger.warn(
        `[token] account ${accountId}: refresh-token window (original_granted_at + 365d) closes ` +
          `${reauthDueAt?.toISOString()} — schedule a re-authorisation before then`
      )
    }

    // Decrypt -> refresh at TikTok -> re-seal. The plaintext refresh token never
    // leaves this function.
    let refreshPlain: string
    try {
      refreshPlain = openToken(sealedRefresh, deps.tokenKey)
    } catch (err) {
      deps.logger.error(`[token] account ${accountId}: refresh-token open failed — ${errMsg(err)}`)
      return { accountId, disposition: 'error', reauthDueAt, reauthSoon }
    }

    let tokens: TikTokTokens
    try {
      tokens = await deps.oauth.refresh(refreshPlain)
    } catch (err) {
      // A failed rotation is recoverable precisely because we never touched the
      // stored tokens — the old pair is still valid until its own expiry.
      deps.logger.error(`[token] account ${accountId}: refresh grant failed — ${errMsg(err)}`)
      return { accountId, disposition: 'error', reauthDueAt, reauthSoon }
    }

    const newAccess = sealToken(tokens.accessToken, deps.tokenKey)
    const newRefresh = sealToken(tokens.refreshToken || refreshPlain, deps.tokenKey)

    // Compare-and-swap on token_generation. The old ciphertext columns become
    // prev_* (one generation retained); original_granted_at is NOT touched.
    const { data, error } = await deps.client
      .from('owned_account')
      .update({
        prev_access_token: account.access_token, // the ciphertext being replaced
        prev_refresh_token: account.refresh_token,
        access_token: bufferToPgBytea(newAccess),
        refresh_token: bufferToPgBytea(newRefresh),
        access_expires_at: tokens.accessExpiresAt.toISOString(),
        refresh_expires_at: tokens.refreshExpiresAt.toISOString(),
        token_generation: account.token_generation + 1,
      })
      .eq('id', accountId)
      .eq('token_generation', account.token_generation)
      .select('id')
    if (error) throw error

    if (!Array.isArray(data) || data.length === 0) {
      // Someone rotated between our read and write — abort, keep their newer pair.
      deps.logger.warn(`[token] account ${accountId}: generation advanced under us — rotation skipped`)
      return { accountId, disposition: 'stale', reauthDueAt, reauthSoon }
    }

    deps.logger.log(
      `[token] account ${accountId}: rotated to generation ${account.token_generation + 1} ` +
        `(prev retained; access exp ${tokens.accessExpiresAt.toISOString()})`
    )
    return { accountId, disposition: 'rotated', reauthDueAt, reauthSoon }
  })
}

/** Find accounts whose access token expires within T-6h and rotate each. */
export async function refreshDueAccounts(deps: WriteDeps): Promise<RotateResult[]> {
  const cutoff = new Date(deps.now().getTime() + REFRESH_LEAD_MS).toISOString()
  const { data, error } = await deps.client
    .from('owned_account')
    .select('id')
    .lte('access_expires_at', cutoff)
    .not('refresh_token', 'is', null)
  if (error) throw error

  const ids = ((data as { id: number }[] | null) ?? []).map((r) => r.id)
  const results: RotateResult[] = []
  for (const id of ids) {
    try {
      results.push(await rotateAccount(deps, id))
    } catch (err) {
      deps.logger.error(`[token] account ${id} threw: ${errMsg(err)}`)
      results.push({ accountId: id, disposition: 'error', reauthDueAt: null, reauthSoon: false })
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function loadAccount(deps: WriteDeps, id: number): Promise<OwnedAccountRow | null> {
  const { data, error } = await deps.client.from('owned_account').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data as OwnedAccountRow | null) ?? null
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  boot()
  if (!process.argv.includes('--refresh')) {
    console.log('[token] usage: token.ts --refresh   (rotates access tokens expiring within T-6h)')
    return
  }
  const deps = makeWriteDeps({ client: db() })
  const results = await refreshDueAccounts(deps)
  const rotated = results.filter((r) => r.disposition === 'rotated').length
  const stale = results.filter((r) => r.disposition === 'stale').length
  const soon = results.filter((r) => r.reauthSoon).length
  console.log(
    `[token] refresh: ${results.length} due, ${rotated} rotated, ${stale} skipped-stale, ` +
      `${soon} nearing the 365-day re-auth deadline`
  )
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-write[\\/]src[\\/]token\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
