/**
 * TikTok OAuth 2.0 client (Login Kit v2) for the write plane.
 *
 * LOAD-BEARING CONSTRAINT (do not re-litigate): the requested scope set is
 * `video.upload` (draft/inbox, NOT audit-gated) — NEVER `video.publish`
 * (Direct Post, audit-gated, and the exact prohibited-app shape). `authorizeUrl`
 * refuses to emit a consent URL that requests `video.publish`, as a
 * defense-in-depth belt over the .env scope list.
 *
 * All request/response SHAPES here are written from TikTok's published docs and
 * have NOT been validated against a live response — same posture as the read
 * plane's `mapEnsembleVideo`. Every such boundary is flagged `// UNVERIFIED`.
 *
 * Injectable: every network call goes through `fetchImpl` (defaults to global
 * `fetch`); secrets are read from env with a constructor override and throw at
 * CALL time if missing, never at import.
 */

import { formEncode, PublishingError } from './http.js'

// UNVERIFIED endpoints — confirm against developers.tiktok.com before live use.
const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/'
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/'

const FORBIDDEN_SCOPE = 'video.publish'
const UPLOAD_SCOPE = 'video.upload'
const DEFAULT_SCOPES = 'user.info.basic,video.list,video.upload'

export interface TikTokOAuthConfig {
  clientKey?: string
  clientSecret?: string
  redirectUri?: string
  /** Comma string or array. Defaults to `TIKTOK_SCOPES` then the phase-3 set. */
  scopes?: string | string[]
  fetchImpl?: typeof fetch
  /** Test seams — default to the real hosts. */
  authorizeBaseUrl?: string
  tokenBaseUrl?: string
}

export interface TikTokTokens {
  accessToken: string
  refreshToken: string
  openId: string
  scope: string
  tokenType: string
  accessExpiresAt: Date
  /**
   * Reported from `refresh_expires_in`. NOTE: the operational re-auth deadline
   * is computed from `owned_account.original_granted_at + 365d`, NOT from this —
   * refresh tokens expire 365 days from INITIAL issuance and refreshing does
   * not extend that window. This field is the raw API value only.
   */
  refreshExpiresAt: Date
  raw: unknown
}

/** Resolves + validates the scope set; throws if `video.publish` is present. */
function resolveScopes(input?: string | string[]): string[] {
  const raw = input ?? process.env.TIKTOK_SCOPES ?? DEFAULT_SCOPES
  const list = (Array.isArray(raw) ? raw : raw.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (list.includes(FORBIDDEN_SCOPE)) {
    throw new PublishingError(
      `refusing to request '${FORBIDDEN_SCOPE}': Direct Post is audit-gated and is the prohibited-app shape. ` +
        `The write plane authorizes '${UPLOAD_SCOPE}' (draft/inbox) only.`,
      'forbidden_scope'
    )
  }
  return list
}

export class TikTokOAuthClient {
  private readonly cfg: TikTokOAuthConfig
  private readonly scopes: string[]
  private readonly fetchImpl: typeof fetch
  private readonly authorizeBaseUrl: string
  private readonly tokenBaseUrl: string

  constructor(cfg: TikTokOAuthConfig = {}) {
    this.cfg = cfg
    // Resolved (and the video.publish guard fires) at construction so a bad
    // scope list cannot silently reach a live consent screen.
    this.scopes = resolveScopes(cfg.scopes)
    this.fetchImpl = cfg.fetchImpl ?? fetch
    this.authorizeBaseUrl = cfg.authorizeBaseUrl ?? AUTHORIZE_URL
    this.tokenBaseUrl = cfg.tokenBaseUrl ?? TOKEN_URL
  }

  private need(name: string, value: string | undefined): string {
    if (value === undefined || value === '') {
      throw new PublishingError(`${name} is required for this call but is not set`, 'missing_config')
    }
    return value
  }

  private clientKey(): string {
    return this.need('TIKTOK_CLIENT_KEY', this.cfg.clientKey ?? process.env.TIKTOK_CLIENT_KEY)
  }
  private clientSecret(): string {
    return this.need(
      'TIKTOK_CLIENT_SECRET',
      this.cfg.clientSecret ?? process.env.TIKTOK_CLIENT_SECRET
    )
  }
  private redirectUri(): string {
    return this.need('TIKTOK_REDIRECT_URI', this.cfg.redirectUri ?? process.env.TIKTOK_REDIRECT_URI)
  }

  /** The resolved scope set (already validated free of `video.publish`). */
  get requestedScopes(): readonly string[] {
    return this.scopes
  }

  /**
   * Consent URL for the write-plane callback. `state` is the caller's CSRF
   * nonce (verify it on the way back). Scope is comma-joined per TikTok's v2
   * format and provably excludes `video.publish`.
   */
  authorizeUrl(state: string): string {
    if (!state) throw new PublishingError('authorizeUrl requires a non-empty state', 'missing_state')
    const url = new URL(this.authorizeBaseUrl)
    url.searchParams.set('client_key', this.clientKey())
    url.searchParams.set('scope', this.scopes.join(',')) // UNVERIFIED: comma-separated per v2 docs
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', this.redirectUri())
    url.searchParams.set('state', state)
    return url.toString()
  }

  /** Authorization-code exchange → tokens + expiries + open_id. */
  async exchangeCode(code: string): Promise<TikTokTokens> {
    if (!code) throw new PublishingError('exchangeCode requires an authorization code', 'missing_code')
    const body = formEncode({
      client_key: this.clientKey(),
      client_secret: this.clientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri(),
    })
    return this.tokenRequest(body)
  }

  /** Refresh-token grant → a fresh token pair. */
  async refresh(refreshToken: string): Promise<TikTokTokens> {
    if (!refreshToken) throw new PublishingError('refresh requires a refresh token', 'missing_refresh_token')
    const body = formEncode({
      client_key: this.clientKey(),
      client_secret: this.clientSecret(),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
    return this.tokenRequest(body)
  }

  private async tokenRequest(body: string): Promise<TikTokTokens> {
    const res = await this.fetchImpl(this.tokenBaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body,
    })

    let raw: unknown = null
    try {
      raw = await res.json()
    } catch {
      raw = null
    }

    // UNVERIFIED response shape. The v2 token endpoint returns token fields at
    // the TOP LEVEL ({ access_token, refresh_token, open_id, scope, expires_in,
    // refresh_expires_in, token_type }); some portal responses nest them under
    // `data`. Accept both, and treat an `error`/`error_description` as failure.
    const r = raw as Record<string, unknown> | null
    const payload = (r && (r.access_token ? r : (r.data as Record<string, unknown> | undefined))) ?? r

    if (!res.ok || (r && r.error) || !payload || typeof payload.access_token !== 'string') {
      const msg =
        (r?.error_description as string | undefined) ??
        ((r?.error as { message?: string } | string | undefined) as { message?: string })?.message ??
        (typeof r?.error === 'string' ? r.error : undefined) ??
        `token request failed with status ${res.status}`
      const code = typeof r?.error === 'string' ? r.error : 'token_error'
      throw new PublishingError(String(msg), code, res.status, raw)
    }

    const now = Date.now()
    const num = (v: unknown) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : 0
    }
    return {
      accessToken: payload.access_token as string,
      refreshToken: (payload.refresh_token as string) ?? '',
      openId: (payload.open_id as string) ?? '',
      scope: (payload.scope as string) ?? '',
      tokenType: (payload.token_type as string) ?? 'Bearer',
      accessExpiresAt: new Date(now + num(payload.expires_in) * 1000),
      refreshExpiresAt: new Date(now + num(payload.refresh_expires_in) * 1000),
      raw,
    }
  }
}
