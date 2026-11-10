import { describe, it, expect } from 'vitest'
import { openToken, sealToken, type TikTokOAuthClient, type TikTokTokens } from '@goodfor/publishing'

import { rotateAccount } from './token.js'
import { makeWriteDeps, bufferToPgBytea, type OwnedAccountRow } from './deps.js'
import { mockDb, opsFor, quietLogger, type Router } from './testutil.js'

const KEY = Buffer.alloc(32, 7)
const NOW = new Date('2026-08-16T12:00:00Z')

function acct(overrides: Partial<OwnedAccountRow> = {}): OwnedAccountRow {
  return {
    id: 5,
    app_slug: 'goodfor',
    tiktok_open_id: 'open_5',
    username: 'goodfor_app',
    account_type: 'business',
    access_token: bufferToPgBytea(sealToken('OLD-ACCESS', KEY)),
    access_expires_at: '2026-08-16T14:00:00Z',
    refresh_token: bufferToPgBytea(sealToken('OLD-REFRESH', KEY)),
    refresh_expires_at: '2027-08-16T00:00:00Z',
    original_granted_at: '2026-01-01T00:00:00Z',
    posts_last_24h: 0,
    uploads_in_flight: 0,
    quarantined_until: null,
    prev_access_token: null,
    prev_refresh_token: null,
    token_generation: 2,
    quarantine_reason: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as OwnedAccountRow
}

/** A fake OAuth client that records the refresh-token it was handed. */
function fakeOAuth(seen: { refreshArg?: string }): TikTokOAuthClient {
  return {
    async refresh(refreshToken: string): Promise<TikTokTokens> {
      seen.refreshArg = refreshToken
      return {
        accessToken: 'NEW-ACCESS',
        refreshToken: 'NEW-REFRESH',
        openId: 'open_5',
        scope: 'video.upload',
        tokenType: 'Bearer',
        accessExpiresAt: new Date(NOW.getTime() + 86_400_000),
        refreshExpiresAt: new Date(NOW.getTime() + 365 * 86_400_000),
        raw: {},
      }
    },
  } as unknown as TikTokOAuthClient
}

function deps(client: any, oauth: TikTokOAuthClient) {
  return makeWriteDeps({
    client,
    oauth,
    tokenKey: KEY,
    now: () => NOW,
    logger: quietLogger,
    // Pass-through lock — the advisory lock is exercised elsewhere; the
    // generation compare-and-swap is what this test verifies.
    withAccountLock: (_id, fn) => fn(),
  })
}

describe('token.rotateAccount — retains the previous generation', () => {
  it('copies the replaced tokens into prev_*, bumps the generation, keeps original_granted_at', async () => {
    const current = acct()
    const casRows = { rows: [{ id: 5 }] as { id: number }[] }
    const router: Router = (op) => {
      if (op.table === 'owned_account' && op.kind === 'select' && op.terminal === 'maybeSingle') {
        return { data: current }
      }
      if (op.table === 'owned_account' && op.kind === 'update') return { data: casRows.rows }
      return { data: null }
    }
    const { client, calls } = mockDb(router)
    const seen: { refreshArg?: string } = {}

    const result = await rotateAccount(deps(client, fakeOAuth(seen)), 5)

    expect(result.disposition).toBe('rotated')
    // The plaintext OLD refresh token was decrypted and handed to the grant.
    expect(seen.refreshArg).toBe('OLD-REFRESH')

    const update = opsFor(calls, 'owned_account', 'update')[0]!
    // Previous generation retained verbatim (the exact ciphertext being replaced).
    expect(update.payload.prev_access_token).toBe(current.access_token)
    expect(update.payload.prev_refresh_token).toBe(current.refresh_token)
    // New ciphertext written, and it decrypts to the fresh tokens.
    expect(update.payload.access_token).not.toBe(current.access_token)
    expect(openToken(Buffer.from(String(update.payload.access_token).slice(2), 'hex'), KEY)).toBe('NEW-ACCESS')
    expect(openToken(Buffer.from(String(update.payload.refresh_token).slice(2), 'hex'), KEY)).toBe('NEW-REFRESH')
    // Generation bumped by exactly one.
    expect(update.payload.token_generation).toBe(3)
    // original_granted_at is NEVER moved on refresh (365-day window from issuance).
    expect(update.payload).not.toHaveProperty('original_granted_at')
    // The write is a compare-and-swap guarded on the generation we read.
    expect(update.filters).toEqual(
      expect.arrayContaining([['eq', 'token_generation', 2] as [string, string, unknown]])
    )
  })

  it('aborts as stale (no clobber) when the generation advanced under it', async () => {
    const router: Router = (op) => {
      if (op.table === 'owned_account' && op.kind === 'select') return { data: acct() }
      if (op.table === 'owned_account' && op.kind === 'update') return { data: [] } // CAS matched 0 rows
      return { data: null }
    }
    const { client } = mockDb(router)
    const result = await rotateAccount(deps(client, fakeOAuth({})), 5)
    expect(result.disposition).toBe('stale')
  })

  it('computes the re-auth deadline from original_granted_at + 365d, not from the refresh', async () => {
    const router: Router = (op) => {
      if (op.table === 'owned_account' && op.kind === 'select') return { data: acct() }
      if (op.table === 'owned_account' && op.kind === 'update') return { data: [{ id: 5 }] }
      return { data: null }
    }
    const { client } = mockDb(router)
    const result = await rotateAccount(deps(client, fakeOAuth({})), 5)
    // 2026-01-01 + 365 days.
    expect(result.reauthDueAt?.toISOString()).toBe(new Date('2027-01-01T00:00:00Z').toISOString())
  })
})
