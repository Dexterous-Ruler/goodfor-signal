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

import { createTickRunner } from './tick.js'
import { makeWriteDeps, bufferToPgBytea, type ScheduledPostRow, type OwnedAccountRow } from './deps.js'
import { mockDb, opsFor, quietLogger, type Router } from './testutil.js'

const KEY = Buffer.alloc(32, 7)

function ok<T>(data: T): PublisherResult<T> {
  return { ok: true, httpStatus: 200, errorCode: 'ok', data, raw: {} }
}

/** A publisher that walks the happy path to PUBLISH_COMPLETE with a public id. */
function fakePublisher(status?: PublisherResult<PublishStatus>): Publisher {
  return {
    name: 'fake-inbox',
    async getCreatorInfo(): Promise<PublisherResult<CreatorInfo>> {
      return ok({
        privacyLevelOptions: ['PUBLIC_TO_EVERYONE'],
        commentDisabled: false,
        duetDisabled: false,
        stitchDisabled: false,
        maxVideoPostDurationSec: 600,
      })
    },
    async initInboxUpload(): Promise<PublisherResult<InitResult>> {
      return ok({ publishId: 'pub_1', uploadUrl: 'https://upload.example/put' })
    },
    async uploadChunk(): Promise<PublisherResult<UploadResult>> {
      return ok({ bytesUploaded: 3 })
    },
    async uploadFile(): Promise<PublisherResult<UploadResult>> {
      return ok({ bytesUploaded: 3 })
    },
    async fetchStatus(): Promise<PublisherResult<PublishStatus>> {
      return status ?? ok({ status: 'PUBLISH_COMPLETE', publicPostId: '99', failReason: null })
    },
  }
}

function account(overrides: Partial<OwnedAccountRow> = {}): OwnedAccountRow {
  return {
    id: 10,
    app_slug: 'goodfor',
    tiktok_open_id: 'open_10',
    username: 'goodfor_app',
    account_type: 'business',
    access_token: bufferToPgBytea(sealToken('ACCESS-TOKEN', KEY)),
    access_expires_at: '2026-08-17T00:00:00Z',
    refresh_token: bufferToPgBytea(sealToken('REFRESH-TOKEN', KEY)),
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
    ...overrides,
  } as OwnedAccountRow
}

function post(overrides: Partial<ScheduledPostRow> = {}): ScheduledPostRow {
  return {
    id: 1,
    owned_account_id: 10,
    scheduled_for: '2026-08-16T11:00:00Z',
    status: 'queued',
    video_asset_url: 'https://cdn.example/v.mp4',
    caption: 'day 1 #buildinpublic',
    privacy_level: 'PUBLIC_TO_EVERYONE',
    disclosure_type: 'none',
    disclosure_verified: false,
    sound_id: null,
    sound_is_cml: null,
    publish_id: null,
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

const NOW = new Date('2026-08-16T12:00:00Z')

/** Router covering the happy-path DB reads/writes for one post. */
const happyRouter: Router = (op) => {
  if (op.table === 'owned_account' && op.kind === 'select') return { data: account() }
  if (op.table === 'scheduled_post' && op.kind === 'update' && op.select === 'id') {
    return { data: [{ id: 1 }] } // claim succeeds
  }
  return { data: null }
}

function deps(client: any, publisher: Publisher) {
  return makeWriteDeps({
    client,
    publisher,
    tokenKey: KEY,
    now: () => NOW,
    logger: quietLogger,
    loadVideo: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4' }),
  })
}

describe('tick.processPost — drives a queued post through the state machine', () => {
  it('logs every transition to publish_attempt and marks the post published', async () => {
    const { client, calls } = mockDb(happyRouter)
    const runner = createTickRunner(deps(client, fakePublisher()))

    const outcome = await runner.processPost(post())

    expect(outcome?.status).toBe('published')
    expect(outcome?.publicPostId).toBe('99')

    // Every state-machine step is logged to publish_attempt.
    const attempts = opsFor(calls, 'publish_attempt', 'insert')
    const steps = attempts.map((o) => o.payload.step)
    expect(steps).toEqual(expect.arrayContaining(['creator_info', 'init', 'upload', 'status_poll']))
    // Attribution is correct on every row.
    for (const a of attempts) {
      expect(a.payload.scheduled_post_id).toBe(1)
      expect(a.payload.owned_account_id).toBe(10)
    }

    // The post is finalised to published with the resolved public id + appeal SLA.
    const finish = opsFor(calls, 'scheduled_post', 'update').find((o) => o.select !== 'id')
    expect(finish?.payload.status).toBe('published')
    expect(finish?.payload.publicaly_available_post_id).toBe('99')
    expect(finish?.payload.appeal_deadline_at).toBe(new Date(NOW.getTime() + 24 * 3600_000).toISOString())

    // A published post counts against the 24h governor cap.
    const acctUpdate = opsFor(calls, 'owned_account', 'update').find(
      (o) => o.payload && 'posts_last_24h' in o.payload
    )
    expect(acctUpdate?.payload.posts_last_24h).toBe(1)
  })

  it('leaves an inbox delivery (SEND_TO_USER_INBOX) pending, not failed, and does not count a post', async () => {
    const { client, calls } = mockDb(happyRouter)
    const inbox = ok<PublishStatus>({ status: 'SEND_TO_USER_INBOX', publicPostId: null, failReason: null })
    const runner = createTickRunner(deps(client, fakePublisher(inbox)))

    const outcome = await runner.processPost(post())

    expect(outcome?.status).toBe('pending')
    const finish = opsFor(calls, 'scheduled_post', 'update').find((o) => o.select !== 'id')
    expect(finish?.payload.status).toBe('pending')
    // Inbox delivery is not yet a public post — the 24h count stays at 0.
    const acctUpdate = opsFor(calls, 'owned_account', 'update').find(
      (o) => o.payload && 'posts_last_24h' in o.payload
    )
    expect(acctUpdate?.payload.posts_last_24h).toBe(0)
  })

  it('never advances a promotional post that has not cleared the disclosure gate', async () => {
    const { client, calls } = mockDb(happyRouter)
    const runner = createTickRunner(deps(client, fakePublisher()))

    const outcome = await runner.processPost(
      post({ disclosure_type: 'branded_content', disclosure_verified: false, disclosure_region: null })
    )

    expect(outcome).toBeNull()
    // No claim, no attempt, no publish — the gate stopped it before any I/O.
    expect(opsFor(calls, 'publish_attempt', 'insert')).toHaveLength(0)
    expect(opsFor(calls, 'scheduled_post', 'update')).toHaveLength(0)
  })
})
