/**
 * The `Publisher` abstraction and its ≥2 implementations (the §8.2 mandate):
 *
 *   - `InboxPublisher`  — path A, the REAL draft/inbox flow. Uploads land in
 *     the account owner's TikTok inbox where a HUMAN taps publish. This uses
 *     `POST /v2/post/publish/inbox/video/init/` + scope `video.upload`. It
 *     NEVER calls Direct Post (`video.publish`); there is no such method here.
 *   - `VendorPublisher` — path B stub. Contract only; every method throws
 *     'not implemented'. It exists so the state machine and the app are written
 *     against the interface, not a concrete client, before any vendor contract.
 *
 * Every method returns a `PublisherResult` carrying the TikTok error-code
 * STRING; callers (the state machine) branch on that string, never on the HTTP
 * status. All request/response SHAPES are written from docs and flagged
 * `// UNVERIFIED` — validate against a live/sandbox response before trusting.
 */

import { envelopeErrorCode, type TikTokEnvelope } from './http.js'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface PublisherAccount {
  /** DECRYPTED access token (openToken'd by the caller — packages never hit the DB). */
  accessToken: string
  openId?: string
}

/** Uniform result envelope. `errorCode` is the TikTok STRING ('ok' on success). */
export interface PublisherResult<T> {
  ok: boolean
  httpStatus: number
  errorCode: string
  data: T | null
  raw: unknown
}

export interface CreatorInfo {
  privacyLevelOptions: string[]
  commentDisabled: boolean
  duetDisabled: boolean
  stitchDisabled: boolean
  /** Can be BELOW the 10-min API ceiling for a given account — honour it. */
  maxVideoPostDurationSec: number
}

export interface InitInboxRequest {
  sourceInfo: {
    source: 'FILE_UPLOAD' | 'PULL_FROM_URL'
    /** FILE_UPLOAD */
    videoSize?: number
    chunkSize?: number
    totalChunkCount?: number
    /** PULL_FROM_URL — needs domain verification or you get url_ownership_unverified. */
    videoUrl?: string
  }
}

export interface InitResult {
  publishId: string | null
  /** Present for FILE_UPLOAD; null for PULL_FROM_URL. */
  uploadUrl: string | null
}

export interface ChunkRange {
  start: number
  end: number
  total: number
  mimeType?: string
}

export interface UploadOptions {
  chunkSize?: number
  mimeType?: string
}

export interface UploadResult {
  bytesUploaded: number
}

export interface PublishStatus {
  /** e.g. PROCESSING_UPLOAD | SEND_TO_USER_INBOX | PUBLISH_COMPLETE | FAILED. */
  status: string | null
  /** TikTok's verbatim misspelling `publicaly_available_post_id`, first entry. */
  publicPostId: string | null
  failReason: string | null
}

export interface Publisher {
  readonly name: string
  getCreatorInfo(account: PublisherAccount): Promise<PublisherResult<CreatorInfo>>
  initInboxUpload(
    account: PublisherAccount,
    req: InitInboxRequest
  ): Promise<PublisherResult<InitResult>>
  uploadChunk(
    uploadUrl: string,
    chunk: Uint8Array,
    range: ChunkRange
  ): Promise<PublisherResult<UploadResult>>
  uploadFile(
    uploadUrl: string,
    bytes: Uint8Array,
    opts?: UploadOptions
  ): Promise<PublisherResult<UploadResult>>
  fetchStatus(account: PublisherAccount, publishId: string): Promise<PublisherResult<PublishStatus>>
}

// ---------------------------------------------------------------------------
// Chunk planning (pure) — init and upload MUST agree on the split
// ---------------------------------------------------------------------------

// UNVERIFIED numbers — TikTok documents 5MB..64MB chunks, ≤1000 chunks, the
// final chunk absorbing the remainder. Confirm before live use.
export const MIN_CHUNK_SIZE = 5 * 1024 * 1024
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024
export const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024

export interface ChunkPlan {
  chunkSize: number
  totalChunkCount: number
  ranges: { index: number; start: number; end: number }[]
}

/**
 * Split `sizeBytes` into the chunk plan `init` reports and `uploadFile` sends.
 * A file at or under one chunk is a single chunk whose declared `chunk_size`
 * equals the whole video size (TikTok's rule). Otherwise equal chunks with the
 * LAST one carrying the remainder.
 */
export function planChunks(sizeBytes: number, chunkSize: number = DEFAULT_CHUNK_SIZE): ChunkPlan {
  if (sizeBytes <= 0) {
    return { chunkSize: 0, totalChunkCount: 0, ranges: [] }
  }
  if (sizeBytes <= chunkSize) {
    return {
      chunkSize: sizeBytes,
      totalChunkCount: 1,
      ranges: [{ index: 0, start: 0, end: sizeBytes - 1 }],
    }
  }
  const totalChunkCount = Math.floor(sizeBytes / chunkSize)
  const ranges: { index: number; start: number; end: number }[] = []
  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize
    const end = i === totalChunkCount - 1 ? sizeBytes - 1 : (i + 1) * chunkSize - 1
    ranges.push({ index: i, start, end })
  }
  return { chunkSize, totalChunkCount, ranges }
}

// ---------------------------------------------------------------------------
// InboxPublisher — path A (real)
// ---------------------------------------------------------------------------

export interface InboxPublisherConfig {
  fetchImpl?: typeof fetch
  /** Test seam; defaults to the open API host. */
  baseUrl?: string
}

// UNVERIFIED endpoint paths.
const CREATOR_INFO_PATH = '/v2/post/publish/creator_info/query/'
const INBOX_INIT_PATH = '/v2/post/publish/inbox/video/init/'
const STATUS_FETCH_PATH = '/v2/post/publish/status/fetch/'
const API_BASE = 'https://open.tiktokapis.com'

interface RawCreatorInfo {
  privacy_level_options?: string[]
  comment_disabled?: boolean
  duet_disabled?: boolean
  stitch_disabled?: boolean
  max_video_post_duration_sec?: number
}
interface RawInit {
  publish_id?: string
  upload_url?: string
}
interface RawStatus {
  status?: string
  fail_reason?: string
  publicaly_available_post_id?: string[] // TikTok's verbatim misspelling
}

export class InboxPublisher implements Publisher {
  readonly name = 'tiktok-inbox'
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(cfg: InboxPublisherConfig = {}) {
    this.fetchImpl = cfg.fetchImpl ?? fetch
    this.baseUrl = cfg.baseUrl ?? API_BASE
  }

  private async postJson<T>(
    path: string,
    accessToken: string,
    body: unknown
  ): Promise<{ httpStatus: number; errorCode: string; data: T | null; raw: unknown }> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body),
    })
    let raw: unknown = null
    try {
      raw = await res.json()
    } catch {
      raw = null
    }
    const errorCode = envelopeErrorCode(raw, res.ok)
    const data = (raw as TikTokEnvelope<T> | null)?.data ?? null
    return { httpStatus: res.status, errorCode, data, raw }
  }

  async getCreatorInfo(account: PublisherAccount): Promise<PublisherResult<CreatorInfo>> {
    // creator_info/query FIRST, on every post: allowed privacy levels, the
    // creator's Duet/Stitch/Comment settings, and the account's real
    // max_video_post_duration_sec (may be below the API ceiling). // UNVERIFIED
    const r = await this.postJson<RawCreatorInfo>(CREATOR_INFO_PATH, account.accessToken, {})
    const data: CreatorInfo | null = r.data
      ? {
          privacyLevelOptions: r.data.privacy_level_options ?? [],
          commentDisabled: r.data.comment_disabled ?? false,
          duetDisabled: r.data.duet_disabled ?? false,
          stitchDisabled: r.data.stitch_disabled ?? false,
          maxVideoPostDurationSec: r.data.max_video_post_duration_sec ?? 0,
        }
      : null
    return { ok: r.errorCode === 'ok', httpStatus: r.httpStatus, errorCode: r.errorCode, data, raw: r.raw }
  }

  async initInboxUpload(
    account: PublisherAccount,
    req: InitInboxRequest
  ): Promise<PublisherResult<InitResult>> {
    // Inbox init carries ONLY source_info — no post_info (title/privacy). That
    // is the point of path A: the human sets caption + privacy in-app and taps
    // publish, so this stays outside Direct Post entirely. // UNVERIFIED body
    const body =
      req.sourceInfo.source === 'PULL_FROM_URL'
        ? { source_info: { source: 'PULL_FROM_URL', video_url: req.sourceInfo.videoUrl } }
        : {
            source_info: {
              source: 'FILE_UPLOAD',
              video_size: req.sourceInfo.videoSize,
              chunk_size: req.sourceInfo.chunkSize,
              total_chunk_count: req.sourceInfo.totalChunkCount,
            },
          }
    const r = await this.postJson<RawInit>(INBOX_INIT_PATH, account.accessToken, body)
    const data: InitResult | null = r.data
      ? { publishId: r.data.publish_id ?? null, uploadUrl: r.data.upload_url ?? null }
      : null
    return { ok: r.errorCode === 'ok', httpStatus: r.httpStatus, errorCode: r.errorCode, data, raw: r.raw }
  }

  async uploadChunk(
    uploadUrl: string,
    chunk: Uint8Array,
    range: ChunkRange
  ): Promise<PublisherResult<UploadResult>> {
    // Pre-signed PUT to the upload_url. No TikTok envelope here — success is a
    // 2xx; anything else is a synthesized upload error code. // UNVERIFIED
    const res = await this.fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': range.mimeType ?? 'video/mp4',
        'Content-Length': String(chunk.byteLength),
        'Content-Range': `bytes ${range.start}-${range.end}/${range.total}`,
      },
      body: chunk,
    })
    const ok = res.ok
    return {
      ok,
      httpStatus: res.status,
      errorCode: ok ? 'ok' : `upload_http_${res.status}`,
      data: { bytesUploaded: chunk.byteLength },
      raw: null,
    }
  }

  async uploadFile(
    uploadUrl: string,
    bytes: Uint8Array,
    opts: UploadOptions = {}
  ): Promise<PublisherResult<UploadResult>> {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const total = data.byteLength
    const plan = planChunks(total, opts.chunkSize ?? DEFAULT_CHUNK_SIZE)
    let last: PublisherResult<UploadResult> | null = null
    let sent = 0
    for (const r of plan.ranges) {
      const chunk = data.subarray(r.start, r.end + 1)
      last = await this.uploadChunk(uploadUrl, chunk, {
        start: r.start,
        end: r.end,
        total,
        mimeType: opts.mimeType,
      })
      sent += chunk.byteLength
      // Stop on the first failing chunk — branch on the error-code string.
      if (last.errorCode !== 'ok') return { ...last, data: { bytesUploaded: sent } }
    }
    return (
      last ?? { ok: true, httpStatus: 200, errorCode: 'ok', data: { bytesUploaded: sent }, raw: null }
    )
  }

  async fetchStatus(
    account: PublisherAccount,
    publishId: string
  ): Promise<PublisherResult<PublishStatus>> {
    // A 200 here is NOT a publish — see the state machine. publicaly_available_
    // post_id only resolves AFTER moderation. // UNVERIFIED body + field names
    const r = await this.postJson<RawStatus>(STATUS_FETCH_PATH, account.accessToken, {
      publish_id: publishId,
    })
    const ids = r.data?.publicaly_available_post_id
    const data: PublishStatus | null = r.data
      ? {
          status: r.data.status ?? null,
          publicPostId: Array.isArray(ids) && ids.length > 0 ? (ids[0] ?? null) : null,
          failReason: r.data.fail_reason ?? null,
        }
      : null
    return { ok: r.errorCode === 'ok', httpStatus: r.httpStatus, errorCode: r.errorCode, data, raw: r.raw }
  }
}

// ---------------------------------------------------------------------------
// VendorPublisher — path B stub (contract only)
// ---------------------------------------------------------------------------

/**
 * Path B rests on an INFERENCE, not documented fact (an audited vendor posting
 * on your behalf). It ships as a stub so the interface has ≥2 implementations
 * from day one; wire a real vendor here only after WRITTEN vendor confirmation.
 */
export class VendorPublisher implements Publisher {
  readonly name = 'vendor-stub'
  private fail(method: string): never {
    throw new Error(
      `VendorPublisher.${method}: not implemented — path B is a contract stub pending written vendor confirmation`
    )
  }
  async getCreatorInfo(): Promise<PublisherResult<CreatorInfo>> {
    return this.fail('getCreatorInfo')
  }
  async initInboxUpload(): Promise<PublisherResult<InitResult>> {
    return this.fail('initInboxUpload')
  }
  async uploadChunk(): Promise<PublisherResult<UploadResult>> {
    return this.fail('uploadChunk')
  }
  async uploadFile(): Promise<PublisherResult<UploadResult>> {
    return this.fail('uploadFile')
  }
  async fetchStatus(): Promise<PublisherResult<PublishStatus>> {
    return this.fail('fetchStatus')
  }
}
