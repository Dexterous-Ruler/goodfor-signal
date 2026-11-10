import { describe, it, expect } from 'vitest'
import {
  InboxPublisher,
  VendorPublisher,
  planChunks,
  DEFAULT_CHUNK_SIZE,
  type PublisherAccount,
} from './index.js'

const account: PublisherAccount = { accessToken: 'act_token', openId: 'open1' }

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('planChunks', () => {
  it('makes a single chunk whose declared size equals the whole file', () => {
    const plan = planChunks(1234, DEFAULT_CHUNK_SIZE)
    expect(plan.totalChunkCount).toBe(1)
    expect(plan.chunkSize).toBe(1234)
    expect(plan.ranges).toEqual([{ index: 0, start: 0, end: 1233 }])
  })

  it('splits into equal chunks with the last absorbing the remainder', () => {
    const chunk = 10
    const plan = planChunks(25, chunk) // 25 / 10 => 2 chunks, last is 10..24
    expect(plan.totalChunkCount).toBe(2)
    expect(plan.ranges).toEqual([
      { index: 0, start: 0, end: 9 },
      { index: 1, start: 10, end: 24 },
    ])
  })
})

describe('InboxPublisher.getCreatorInfo', () => {
  it('maps the creator_info envelope and reports errorCode ok', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        data: {
          privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
          comment_disabled: false,
          duet_disabled: true,
          stitch_disabled: true,
          max_video_post_duration_sec: 180,
        },
        error: { code: 'ok', message: '', log_id: 'l1' },
      })) as unknown as typeof fetch

    const pub = new InboxPublisher({ fetchImpl })
    const r = await pub.getCreatorInfo(account)
    expect(r.ok).toBe(true)
    expect(r.errorCode).toBe('ok')
    expect(r.data?.privacyLevelOptions).toContain('SELF_ONLY')
    expect(r.data?.maxVideoPostDurationSec).toBe(180)
    expect(r.data?.duetDisabled).toBe(true)
  })
})

describe('InboxPublisher.initInboxUpload', () => {
  it('returns publishId + uploadUrl for FILE_UPLOAD', async () => {
    let sentBody: unknown = null
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      sentBody = JSON.parse(String((init as RequestInit).body))
      return jsonResponse({
        data: { publish_id: 'pub_123', upload_url: 'https://upload.tiktok/xyz' },
        error: { code: 'ok' },
      })
    }) as unknown as typeof fetch

    const pub = new InboxPublisher({ fetchImpl })
    const r = await pub.initInboxUpload(account, {
      sourceInfo: { source: 'FILE_UPLOAD', videoSize: 1234, chunkSize: 1234, totalChunkCount: 1 },
    })
    expect(r.errorCode).toBe('ok')
    expect(r.data?.publishId).toBe('pub_123')
    expect(r.data?.uploadUrl).toBe('https://upload.tiktok/xyz')
    // Inbox init carries ONLY source_info (no post_info / privacy / title).
    expect(sentBody).toEqual({
      source_info: { source: 'FILE_UPLOAD', video_size: 1234, chunk_size: 1234, total_chunk_count: 1 },
    })
  })

  it('passes the TikTok error-code STRING straight through', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { error: { code: 'url_ownership_unverified', message: 'verify your domain' } },
        403
      )) as unknown as typeof fetch
    const pub = new InboxPublisher({ fetchImpl })
    const r = await pub.initInboxUpload(account, {
      sourceInfo: { source: 'PULL_FROM_URL', videoUrl: 'https://cdn.goodfor.app/v.mp4' },
    })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('url_ownership_unverified')
    expect(r.httpStatus).toBe(403)
  })
})

describe('InboxPublisher.uploadFile', () => {
  it('PUTs each chunk with a Content-Range header', async () => {
    const calls: { url: string; headers: Record<string, string>; len: number }[] = []
    const fetchImpl = (async (url: unknown, init: unknown) => {
      const ri = init as RequestInit
      calls.push({
        url: String(url),
        headers: ri.headers as Record<string, string>,
        len: (ri.body as Uint8Array).byteLength,
      })
      return { ok: true, status: 201, json: async () => ({}) } as unknown as Response
    }) as unknown as typeof fetch

    const pub = new InboxPublisher({ fetchImpl })
    const bytes = new Uint8Array(25)
    const r = await pub.uploadFile('https://upload.tiktok/xyz', bytes, { chunkSize: 10 })

    expect(r.errorCode).toBe('ok')
    expect(calls.length).toBe(2)
    expect(calls[0]!.headers['Content-Range']).toBe('bytes 0-9/25')
    expect(calls[1]!.headers['Content-Range']).toBe('bytes 10-24/25')
    expect(calls[0]!.headers['Content-Type']).toBe('video/mp4')
  })

  it('stops at the first failing chunk and surfaces a synthesized code', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n += 1
      const status = n === 1 ? 201 : 500
      return { ok: status < 300, status, json: async () => ({}) } as unknown as Response
    }) as unknown as typeof fetch
    const pub = new InboxPublisher({ fetchImpl })
    const r = await pub.uploadFile('https://u', new Uint8Array(25), { chunkSize: 10 })
    expect(r.errorCode).toBe('upload_http_500')
    expect(n).toBe(2) // stopped; did not attempt a third
  })
})

describe('InboxPublisher.fetchStatus', () => {
  it("reads the verbatim-misspelled publicaly_available_post_id array", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['70123456789'] },
        error: { code: 'ok' },
      })) as unknown as typeof fetch
    const pub = new InboxPublisher({ fetchImpl })
    const r = await pub.fetchStatus(account, 'pub_123')
    expect(r.data?.status).toBe('PUBLISH_COMPLETE')
    expect(r.data?.publicPostId).toBe('70123456789')
  })
})

describe('VendorPublisher (path B stub)', () => {
  it('throws not-implemented on every method', async () => {
    const v = new VendorPublisher()
    await expect(v.getCreatorInfo()).rejects.toThrow(/not implemented/)
    await expect(v.initInboxUpload()).rejects.toThrow(/not implemented/)
    await expect(v.uploadChunk()).rejects.toThrow(/not implemented/)
    await expect(v.uploadFile()).rejects.toThrow(/not implemented/)
    await expect(v.fetchStatus()).rejects.toThrow(/not implemented/)
  })
})
