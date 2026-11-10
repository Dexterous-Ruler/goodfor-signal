/**
 * Publishing state-machine driver.
 *
 *   creator_info/query → init (inbox) → upload (PUT) → status/fetch poll → reconcile
 *
 * Design rules baked in (Phase 3 §"Publishing state machine"):
 *   - Branch on the ERROR-CODE STRING, never the HTTP status. `url_ownership_
 *     unverified` is documented as 400 on one page and 403 on another, so the
 *     same string MUST produce the same outcome regardless of status.
 *   - A 200 is NOT a publish. Processing is async; the response is `pending`
 *     and a post can fail minutes after acceptance. We only report `published`
 *     when the status is terminal AND a `publicaly_available_post_id` exists.
 *   - Inbox drafts / private posts stay `pending` INDEFINITELY (no webhook)
 *     until a human makes them public — special-cased so they never loop or get
 *     mistaken for failures/zombies.
 *
 * The machine performs NO DB writes. Every step is surfaced through the
 * injected `onTransition(step, { errorCode, httpStatus, raw })` callback so the
 * app can append a `publish_attempt` row; the Publisher is injected too.
 */

import {
  planChunks,
  DEFAULT_CHUNK_SIZE,
  type Publisher,
  type PublisherAccount,
  type PublisherResult,
  type InitInboxRequest,
} from './publisher.js'

export type PublishStep = 'creator_info' | 'init' | 'upload' | 'status_poll' | 'reconcile'

export interface TransitionInfo {
  errorCode: string
  httpStatus: number
  raw: unknown
}

export type OnTransition = (step: PublishStep, info: TransitionInfo) => void | Promise<void>

/** Purely the error-code STRING's class — no HTTP status is consulted. */
export type ErrorClass =
  | 'ok'
  | 'url_ownership_unverified'
  | 'spam_risk'
  | 'rate_limited'
  | 'auth'
  | 'retryable'
  | 'fatal'

export function classifyErrorCode(code: string | null | undefined): ErrorClass {
  if (code === null || code === undefined || code === 'ok') return 'ok'
  if (code === 'url_ownership_unverified') return 'url_ownership_unverified'
  if (code.startsWith('spam_risk')) return 'spam_risk'
  if (code === 'rate_limit_exceeded' || code === 'rate_limited') return 'rate_limited'
  if (code.startsWith('access_token') || code === 'scope_not_authorized' || code === 'unaudited_client')
    return 'auth'
  if (code.startsWith('internal') || code.startsWith('upload_http_5') || code === 'unknown_error')
    return 'retryable'
  return 'fatal'
}

/** Terminal-ness of a status/fetch `status` string. Default (incl. null) = pending. */
export function classifyPublishStatus(status: string | null | undefined): 'pending' | 'published' | 'failed' {
  if (status === 'PUBLISH_COMPLETE') return 'published'
  if (status === 'FAILED') return 'failed'
  return 'pending'
}

/** Inbox/private posts sit here forever with no webhook — stop polling, stay pending. */
export function isInboxTerminal(status: string | null | undefined): boolean {
  return status === 'SEND_TO_USER_INBOX'
}

export interface PublishJob {
  account: PublisherAccount
  /** Explicit init request; if omitted it is derived from `video` (FILE_UPLOAD). */
  init?: InitInboxRequest
  /** FILE_UPLOAD bytes. Omit for a PULL_FROM_URL init. */
  video?: { bytes: Uint8Array; mimeType?: string; chunkSize?: number }
}

export type PublishResultStatus = 'pending' | 'published' | 'failed' | 'quarantined'

export interface PublishOutcome {
  status: PublishResultStatus
  publishId: string | null
  publicPostId: string | null
  /** The error-code STRING that ended the run ('ok' on the happy path). */
  errorCode: string
  /** Where the run ended. */
  step: PublishStep
  /** True only for a url_ownership_unverified init failure — actionable hint. */
  needsUrlVerification: boolean
}

export interface PublishStateMachineConfig {
  publisher: Publisher
  onTransition?: OnTransition
  /** Max status polls in a single run (reconcile job handles long tails). */
  maxStatusPolls?: number
  pollDelayMs?: number
  sleepImpl?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class PublishStateMachine {
  private readonly publisher: Publisher
  private readonly onTransition?: OnTransition
  private readonly maxStatusPolls: number
  private readonly pollDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(cfg: PublishStateMachineConfig) {
    this.publisher = cfg.publisher
    this.onTransition = cfg.onTransition
    this.maxStatusPolls = cfg.maxStatusPolls ?? 1
    this.pollDelayMs = cfg.pollDelayMs ?? 0
    this.sleep = cfg.sleepImpl ?? defaultSleep
  }

  private async emit(step: PublishStep, r: PublisherResult<unknown>): Promise<void> {
    if (!this.onTransition) return
    await this.onTransition(step, { errorCode: r.errorCode, httpStatus: r.httpStatus, raw: r.raw })
  }

  /** Map a non-'ok' step result to a terminal outcome — keyed on the STRING. */
  private terminal(step: PublishStep, r: PublisherResult<unknown>, publishId: string | null): PublishOutcome {
    const cls = classifyErrorCode(r.errorCode)
    const status: PublishResultStatus = cls === 'spam_risk' ? 'quarantined' : 'failed'
    return {
      status,
      publishId,
      publicPostId: null,
      errorCode: r.errorCode,
      step,
      needsUrlVerification: cls === 'url_ownership_unverified',
    }
  }

  private deriveInit(job: PublishJob): InitInboxRequest {
    if (job.init) return job.init
    if (!job.video) {
      throw new Error('PublishJob needs either `init` or `video`')
    }
    const size = job.video.bytes.byteLength
    const chunkSize = job.video.chunkSize ?? DEFAULT_CHUNK_SIZE
    const plan = planChunks(size, chunkSize)
    return {
      sourceInfo: {
        source: 'FILE_UPLOAD',
        videoSize: size,
        chunkSize: plan.chunkSize,
        totalChunkCount: plan.totalChunkCount,
      },
    }
  }

  /**
   * Drive one post attempt. Returns the outcome; never throws for an API-level
   * error (those become `failed`/`quarantined` outcomes) — it throws only for a
   * programmer error (a job with neither init nor video).
   */
  async run(job: PublishJob): Promise<PublishOutcome> {
    // 1. creator_info — always, on every post.
    const ci = await this.publisher.getCreatorInfo(job.account)
    await this.emit('creator_info', ci)
    if (classifyErrorCode(ci.errorCode) !== 'ok') return this.terminal('creator_info', ci, null)

    // 2. init (inbox)
    const initReq = this.deriveInit(job)
    const init = await this.publisher.initInboxUpload(job.account, initReq)
    await this.emit('init', init)
    if (classifyErrorCode(init.errorCode) !== 'ok') return this.terminal('init', init, null)
    const publishId = init.data?.publishId ?? null

    // 3. upload (FILE_UPLOAD only). PULL_FROM_URL skips straight to polling.
    if (job.video && init.data?.uploadUrl) {
      const up = await this.publisher.uploadFile(init.data.uploadUrl, job.video.bytes, {
        chunkSize: job.video.chunkSize,
        mimeType: job.video.mimeType,
      })
      await this.emit('upload', up)
      if (classifyErrorCode(up.errorCode) !== 'ok') return this.terminal('upload', up, publishId)
    }

    // 4. status poll — a 200 is `pending`, not published.
    let lastStatus: PublisherResult<{ status: string | null; publicPostId: string | null; failReason: string | null }> | null =
      null
    for (let i = 0; ; i++) {
      const st = await this.publisher.fetchStatus(job.account, publishId ?? '')
      await this.emit('status_poll', st)
      if (classifyErrorCode(st.errorCode) !== 'ok') return this.terminal('status_poll', st, publishId)
      lastStatus = st

      const ps = classifyPublishStatus(st.data?.status)
      if (ps !== 'pending') break // terminal: published or failed
      if (isInboxTerminal(st.data?.status)) break // inbox draft — stays pending, stop polling
      if (i + 1 >= this.maxStatusPolls) break
      if (this.pollDelayMs > 0) await this.sleep(this.pollDelayMs)
    }

    const data = lastStatus?.data ?? null
    const ps = classifyPublishStatus(data?.status)
    const publicPostId = data?.publicPostId ?? null

    if (ps === 'published' && publicPostId) {
      // Only a terminal status WITH a resolved public id counts as published.
      return { status: 'published', publishId, publicPostId, errorCode: 'ok', step: 'reconcile', needsUrlVerification: false }
    }
    if (ps === 'failed') {
      return {
        status: 'failed',
        publishId,
        publicPostId: null,
        errorCode: data?.failReason ?? 'failed',
        step: 'status_poll',
        needsUrlVerification: false,
      }
    }
    // Pending — inbox/private/awaiting-moderation. Reconcile resolves it later.
    return { status: 'pending', publishId, publicPostId, errorCode: 'ok', step: 'status_poll', needsUrlVerification: false }
  }

  /**
   * Reconciliation probe (for `worker-write/src/reconcile.ts`): resolve
   * `publish_id → publicaly_available_post_id` only AFTER a human taps publish
   * and moderation clears. Inbox/private stay `pending` here too — the caller
   * must special-case them so they do not accumulate as zombies.
   */
  async reconcile(
    account: PublisherAccount,
    publishId: string
  ): Promise<{ status: PublishResultStatus; publicPostId: string | null; errorCode: string }> {
    const st = await this.publisher.fetchStatus(account, publishId)
    await this.emit('reconcile', st)
    if (classifyErrorCode(st.errorCode) !== 'ok') {
      const cls = classifyErrorCode(st.errorCode)
      return {
        status: cls === 'spam_risk' ? 'quarantined' : 'failed',
        publicPostId: null,
        errorCode: st.errorCode,
      }
    }
    const ps = classifyPublishStatus(st.data?.status)
    const publicPostId = st.data?.publicPostId ?? null
    if (ps === 'published' && publicPostId) {
      return { status: 'published', publicPostId, errorCode: 'ok' }
    }
    if (ps === 'failed') {
      return { status: 'failed', publicPostId: null, errorCode: st.data?.failReason ?? 'failed' }
    }
    return { status: 'pending', publicPostId, errorCode: 'ok' }
  }
}
