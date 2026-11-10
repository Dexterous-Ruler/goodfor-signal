import { describe, it, expect } from 'vitest'
import {
  sealToken,
  type CreatorInfo,
  type InitResult,
  type PublishStatus,
  type Publisher,
  type PublisherResult,
  type UploadResult,
} from '@goodfor/publishing'

import { reconcilePost } from './reconcile.js'
import { makeWriteDeps, bufferToPgBytea, type OwnedAccountRow, type ScheduledPostRow } from './deps.js'
import { mockDb, opsFor, quietLogger, type Router } from './testutil.js'

const KEY = Buffer.alloc(32, 7)

function ok<T>(data: T): PublisherResult<T> {
  return { ok: true, httpStatus: 200, errorCode: 'ok', data, raw: {} }
}

function statusPublisher(status: PublisherResult<PublishStatus>): Publisher {
  const unused = <T>(): Promise<PublisherResult<T>> => Promise.reject(new Error('unused in reconcile'))
  return {
    name: 'fake',
    getCreatorInfo: unused as () => Promise<PublisherResult<CreatorInfo>>,
    initInboxUpload: unused as () => Promise<PublisherResult<InitResult>>,
    uploadChunk: unused as () => Promise<PublisherResult<UploadResult>>,
    uploadFile: unused as () => Promise<PublisherResult<UploadResult>>,
    async fetchStatus() {
      return status
    },
  }
}

const acct: OwnedAccountRow = {
  id: 10,
  app_slug: 'goodfor',
  tiktok_open_id: 'open_10',
  username: 'goodfor_app',
  account_type: 'business',
  access_token: bufferToPgBytea(sealToken('ACCESS', KEY)),
  access_expires_at: '2026-08-17T00:00:00Z',
  refresh_token: bufferToPgBytea(sealToken('REFRESH', KEY)),
  refresh_expires_at: '2027-08-16T00:00:00Z',
  original_granted_at: '2026-08-16T00:00:00Z',
  posts_last_24h: 0,
  uploads_in_flight: 0,
  quarantined_until: null,
  prev_access_token: null,
  prev_refresh_token: null,
  token_generation: 0,
  quarantine_reason: null,
  created_at: '2026-08-16T00:00:00Z',
} as OwnedAccountRow

function pendingPost(overrides: Partial<ScheduledPostRow> = {}): ScheduledPostRow {
  return {
    id: 1,
    owned_account_id: 10,
    scheduled_for: '2026-08-16T11:00:00Z',
    status: 'pending',
    video_asset_url: 'https://cdn.example/v.mp4',
    caption: 'x',
    privacy_level: 'PUBLIC_TO_EVERYONE',
    disclosure_type: 'none',
    disclosure_verified: false,
    sound_id: null,
    sound_is_cml: null,
    publish_id: 'pub_1',
    publicaly_available_post_id: null,
    fail_reason: null,
    source_brief_id: null,
    competitor_inspiration_id: null,
    created_at: '2026-08-16T10:00:00Z',
    published_at: null,
    brief_id: null,
    disclosure_region: null,
    tiktok_disclosure_toggle: null,
    appeal_deadline_at: null,
    idempotency_key: 'idem-1',
    spam_risk_code: null,
    ...overrides,
  } as ScheduledPostRow
}

const router: Router = (op) => {
  if (op.table === 'owned_account' && op.kind === 'select') return { data: acct }
  return { data: null }
}

function deps(client: any, publisher: Publisher) {
  return makeWriteDeps({
    client,
    publisher,
    tokenKey: KEY,
    now: () => new Date('2026-08-16T12:00:00Z'),
    logger: quietLogger,
  })
}

describe('reconcile — inbox/private posts stay pending (no zombies)', () => {
  it('leaves an inbox draft (SEND_TO_USER_INBOX) pending and does not touch scheduled_post', async () => {
    const { client, calls } = mockDb(router)
    const publisher = statusPublisher(
      ok({ status: 'SEND_TO_USER_INBOX', publicPostId: null, failReason: null })
    )
    const disposition = await reconcilePost(deps(client, publisher), pendingPost())

    expect(disposition).toBe('pending_inbox')
    // The reconcile step is logged, but the row is NEVER flipped off pending.
    expect(opsFor(calls, 'publish_attempt', 'insert')).toHaveLength(1)
    expect(opsFor(calls, 'scheduled_post', 'update')).toHaveLength(0)
  })

  it('leaves a private (SELF_ONLY) post pending even when still processing', async () => {
    const { client, calls } = mockDb(router)
    const publisher = statusPublisher(ok({ status: 'PROCESSING', publicPostId: null, failReason: null }))
    const disposition = await reconcilePost(
      deps(client, publisher),
      pendingPost({ privacy_level: 'SELF_ONLY' })
    )

    expect(disposition).toBe('pending_inbox')
    expect(opsFor(calls, 'scheduled_post', 'update')).toHaveLength(0)
  })

  it('resolves a public post to published with the public id once moderation clears', async () => {
    const { client, calls } = mockDb(router)
    const publisher = statusPublisher(
      ok({ status: 'PUBLISH_COMPLETE', publicPostId: '7788', failReason: null })
    )
    const disposition = await reconcilePost(deps(client, publisher), pendingPost())

    expect(disposition).toBe('published')
    const update = opsFor(calls, 'scheduled_post', 'update')[0]
    expect(update?.payload.status).toBe('published')
    expect(update?.payload.publicaly_available_post_id).toBe('7788')
  })
})
