/**
 * Internal HTTP helpers shared by the OAuth client and the InboxPublisher.
 *
 * Zero new deps: global `fetch` only. Every network boundary in this package
 * flows through an injected `fetchImpl` so tests never touch the wire.
 *
 * TikTok wraps almost every Content-Posting response in a fixed envelope:
 *   { data?: {...}, error: { code, message, log_id } }
 * where `error.code` is a STRING ('ok' on success, or e.g.
 * 'url_ownership_unverified', 'spam_risk_too_many_posts'). The whole package
 * branches on that string, never on the HTTP status — the same error is
 * documented as 400 on one page and 403 on another.
 */

export class PublishingError extends Error {
  constructor(
    message: string,
    readonly code: string = 'error',
    readonly httpStatus?: number,
    readonly raw?: unknown
  ) {
    super(message)
    this.name = 'PublishingError'
  }
}

export interface TikTokEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string; log_id?: string }
}

/**
 * The TikTok error-code STRING for a response. `error.code` is authoritative
 * ('ok' on success); we only fall back to a synthetic code when the body has
 * no envelope at all (e.g. a raw gateway 500 or a bare upload-URL PUT).
 */
export function envelopeErrorCode(body: unknown, httpOk: boolean): string {
  const code = (body as TikTokEnvelope<unknown> | null | undefined)?.error?.code
  if (typeof code === 'string' && code.length > 0) return code
  return httpOk ? 'ok' : 'unknown_error'
}

/** application/x-www-form-urlencoded body; skips undefined values. */
export function formEncode(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) usp.set(k, v)
  }
  return usp.toString()
}
