/**
 * Anti-spam governor (Phase 3 §8.3).
 *
 * Pure decision logic over an account's posting state — NO DB writes. The app
 * loads the `owned_account` row (posts_last_24h, uploads_in_flight,
 * quarantined_until), asks the governor, and persists the returned state.
 *
 *   - 12 posts / account / 24h   (headroom under the ~15 guidance)
 *   - 4 in-flight uploads / account (under the 5-pending ceiling)
 *   - ANY `spam_risk_*` error → 24h quarantine, and DO NOT RETRY. Retrying
 *     escalates toward `spam_risk_user_banned_from_posting`. This is the one
 *     rule that must never be "optimised" into a retry.
 *   - Honour `X-RateLimit-Remaining` / `X-RateLimit-Reset` dynamically.
 *
 * "One posting system per account": the ~15/day cap is shared across API
 * clients, so these caps assume this is the ONLY writer on the account.
 */

export const MAX_POSTS_PER_24H = 12
export const MAX_IN_FLIGHT_UPLOADS = 4
export const QUARANTINE_MS = 24 * 60 * 60 * 1000

export interface AccountPostingState {
  postsLast24h: number
  uploadsInFlight: number
  quarantinedUntil: Date | null
}

/** Parsed `X-RateLimit-*` headers. `remaining <= 0` before `resetAt` blocks. */
export interface RateLimit {
  remaining: number | null
  resetAt: Date | null
}

export type PostRefusalReason = 'quarantined' | 'daily_cap' | 'in_flight_cap' | 'rate_limited'

export type PostDecision = { ok: true } | { ok: false; reason: PostRefusalReason }

export interface ResultInput {
  /** TikTok error-code STRING, or null/'ok' on success. */
  errorCode?: string | null
  /** Did the post/upload attempt succeed (counts against the 24h cap)? */
  success?: boolean
}

export interface ResultOutcome {
  state: AccountPostingState
  /** Whether the caller should retry. ALWAYS false for spam_risk_*. */
  retry: boolean
  /** True when this result triggered a 24h quarantine. */
  quarantined: boolean
}

export interface GovernorOptions {
  maxPosts?: number
  maxInFlight?: number
  quarantineMs?: number
}

const SPAM_RISK_RE = /^spam_risk/
const RETRYABLE = new Set(['rate_limit_exceeded', 'rate_limited', 'internal_error', 'unknown_error'])

export class Governor {
  private readonly maxPosts: number
  private readonly maxInFlight: number
  private readonly quarantineMs: number

  constructor(opts: GovernorOptions = {}) {
    this.maxPosts = opts.maxPosts ?? MAX_POSTS_PER_24H
    this.maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT_UPLOADS
    this.quarantineMs = opts.quarantineMs ?? QUARANTINE_MS
  }

  /**
   * May this account start another post right now? Checks, in order:
   * quarantine → 24h post cap → in-flight cap → dynamic rate-limit headers.
   */
  canPost(
    state: AccountPostingState,
    ctx: { now?: Date; rateLimit?: RateLimit } = {}
  ): PostDecision {
    const now = ctx.now ?? new Date()

    if (state.quarantinedUntil && state.quarantinedUntil.getTime() > now.getTime()) {
      return { ok: false, reason: 'quarantined' }
    }
    if (state.postsLast24h >= this.maxPosts) {
      return { ok: false, reason: 'daily_cap' }
    }
    if (state.uploadsInFlight >= this.maxInFlight) {
      return { ok: false, reason: 'in_flight_cap' }
    }
    const rl = ctx.rateLimit
    if (
      rl &&
      rl.remaining !== null &&
      rl.remaining <= 0 &&
      rl.resetAt &&
      rl.resetAt.getTime() > now.getTime()
    ) {
      return { ok: false, reason: 'rate_limited' }
    }
    return { ok: true }
  }

  /**
   * Reserve an in-flight upload slot (call after `canPost` passes, before the
   * upload starts). Pure — returns the next state, mutates nothing.
   */
  register(state: AccountPostingState): AccountPostingState {
    return { ...state, uploadsInFlight: state.uploadsInFlight + 1 }
  }

  /**
   * Fold an attempt's result back into the account state.
   *   - releases the in-flight slot,
   *   - a `spam_risk_*` code → 24h quarantine, retry:false (never retry),
   *   - a success → increments the 24h post count.
   */
  onResult(
    state: AccountPostingState,
    result: ResultInput,
    ctx: { now?: Date } = {}
  ): ResultOutcome {
    const now = ctx.now ?? new Date()
    const inFlight = Math.max(0, state.uploadsInFlight - 1)
    const code = result.errorCode ?? null

    if (code !== null && SPAM_RISK_RE.test(code)) {
      // The one non-negotiable rule: quarantine 24h, do NOT retry.
      return {
        state: {
          postsLast24h: state.postsLast24h,
          uploadsInFlight: inFlight,
          quarantinedUntil: new Date(now.getTime() + this.quarantineMs),
        },
        retry: false,
        quarantined: true,
      }
    }

    const success = result.success === true || code === 'ok' || code === null
    const retry = !success && code !== null && RETRYABLE.has(code)

    return {
      state: {
        postsLast24h: success ? state.postsLast24h + 1 : state.postsLast24h,
        uploadsInFlight: inFlight,
        quarantinedUntil: state.quarantinedUntil,
      },
      retry,
      quarantined: false,
    }
  }
}
