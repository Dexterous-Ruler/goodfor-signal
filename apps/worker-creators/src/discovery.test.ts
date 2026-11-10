import { describe, it, expect } from 'vitest'
import type { Db } from '@goodfor/db'
import type { ModashClient, ModashCreator, ModashSearchResponse } from '@goodfor/creator-crm'
import { makeCreatorDeps, type CreatorDeps } from './deps.js'
import { persistCreator, runDiscovery } from './discovery.js'
import { mockDb, opsFor, quietLogger, type Router } from './testutil.js'

const NOW = new Date('2026-08-16T12:00:00Z')

function creator(over: Partial<ModashCreator> = {}): ModashCreator {
  return {
    platformUserId: 'tt_1',
    username: 'creator_one',
    url: 'https://tiktok.com/@creator_one',
    followers: 50_000,
    engagementRate: 0.07,
    avgViews: 20_000,
    isVerified: false,
    credibility: 88.5,
    sourceVendor: 'modash',
    vendorLastSyncedAt: NOW.toISOString(),
    ...over,
  }
}

function fakeModash(creators: ModashCreator[]): ModashClient {
  return {
    async search(): Promise<ModashSearchResponse> {
      return { creators, creditsConsumed: creators.length * 0.01 }
    },
  } as unknown as ModashClient
}

function deps(client: Db, creators: ModashCreator[]): CreatorDeps {
  return makeCreatorDeps({ client, modash: fakeModash(creators), now: () => NOW, logger: quietLogger })
}

describe('persistCreator — captures credibility + creates identity on a new platform_user_id', () => {
  it('inserts creator_identity + creator_account and persists credibility_score', async () => {
    const router: Router = (op) => {
      if (op.table === 'creator_account' && op.kind === 'select') return { data: null } // not found
      if (op.table === 'creator_identity' && op.kind === 'insert') return { data: { id: 10 } }
      if (op.table === 'creator_account' && op.kind === 'insert') return { data: { id: 20 } }
      return { data: null }
    }
    const { client, calls } = mockDb(router)
    const res = await persistCreator(deps(client, []), 'tiktok', creator())

    expect(res.created).toBe(true)
    expect(res.creatorAccountId).toBe(20)
    expect(res.credibilityCaptured).toBe(88.5)

    // A new identity + account were written (dedupe key resolution).
    expect(opsFor(calls, 'creator_identity', 'insert')).toHaveLength(1)
    const acct = opsFor(calls, 'creator_account', 'insert')[0]!
    expect(acct.payload.platform_user_id).toBe('tt_1')
    expect(acct.payload.source_vendor).toBe('modash') // provenance stamp
    expect(acct.payload.vendor_last_synced_at).toBe(NOW.toISOString())

    // credibility persisted immediately into creator_audience (§9.1).
    const audience = opsFor(calls, 'creator_audience', 'insert')[0]!
    expect(audience.payload.credibility_score).toBe(88.5)
    expect(audience.payload.creator_account_id).toBe(20)

    // metrics APPENDED, never updated (§9.5).
    const snap = opsFor(calls, 'creator_metric_snapshot', 'insert')[0]!
    expect(snap.payload.followers).toBe(50_000)
    expect(opsFor(calls, 'creator_metric_snapshot', 'update')).toHaveLength(0)
  })
})

describe('persistCreator — dedupes on platform_user_id (never username)', () => {
  it('reuses an existing creator_account and creates NO new identity', async () => {
    const router: Router = (op) => {
      if (op.table === 'creator_account' && op.kind === 'select') return { data: { id: 20 } } // found
      return { data: null }
    }
    const { client, calls } = mockDb(router)
    // Same platform_user_id, but the username has changed — must still dedupe.
    const res = await persistCreator(deps(client, []), 'tiktok', creator({ username: 'renamed_handle' }))

    expect(res.created).toBe(false)
    expect(res.creatorAccountId).toBe(20)
    // No new identity, no new account — resolved on platform_user_id.
    expect(opsFor(calls, 'creator_identity', 'insert')).toHaveLength(0)
    expect(opsFor(calls, 'creator_account', 'insert')).toHaveLength(0)
    // Audience + snapshot still appended for the existing account.
    expect(opsFor(calls, 'creator_audience', 'insert')[0]!.payload.credibility_score).toBe(88.5)
  })
})

describe('runDiscovery — dedupes duplicate hits within a batch', () => {
  it('persists a platform_user_id once even if it appears twice in the results', async () => {
    const router: Router = (op) => {
      if (op.table === 'creator_account' && op.kind === 'select') return { data: null }
      if (op.table === 'creator_identity' && op.kind === 'insert') return { data: { id: 10 } }
      if (op.table === 'creator_account' && op.kind === 'insert') return { data: { id: 20 } }
      return { data: null }
    }
    const { client, calls } = mockDb(router)
    const two = [creator(), creator({ username: 'dup' })] // same platformUserId 'tt_1'
    const res = await runDiscovery(deps(client, two), { platform: 'tiktok' })

    expect(res.found).toBe(2)
    expect(res.created).toBe(1)
    expect(res.deduped).toBe(1)
    // Only one account creation despite two hits.
    expect(opsFor(calls, 'creator_account', 'insert')).toHaveLength(1)
  })
})
