/**
 * OAuth callback listener (Phase 3 §Week-11 task 3).
 *
 * A small `node:http` server implementing the TikTok Login-Kit redirect INSIDE
 * the write plane, so the CLIENT SECRET and the token exchange live here and
 * NEVER in the read-plane dashboard process. Two routes:
 *
 *   GET /auth/tiktok/start?app_slug=…&account_type=business|creator
 *        -> 302 to TikTokOAuthClient.authorizeUrl(state). `state` is an opaque,
 *           CSRF nonce that also carries app_slug + account_type across the round
 *           trip. The nonce is held in memory and single-use.
 *   GET  <redirect_uri path>?code=…&state=…
 *        -> exchangeCode -> sealToken(access)/sealToken(refresh) -> upsert
 *           owned_account (bytea tokens, access/refresh expiries,
 *           original_granted_at = now(), token_generation 0).
 *
 * The requested scope set is `video.upload` (draft/inbox) only — the OAuth
 * client itself refuses `video.publish`. This listener adds no scopes.
 *
 * // UNVERIFIED — the user-info fetch shape and the redirect-URI path parsing are
 * written from docs, not validated against a live response.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'

import { db } from '@goodfor/db'
import { sealToken, type TikTokOAuthClient, type TikTokTokens } from '@goodfor/publishing'

import { boot, bufferToPgBytea, makeWriteDeps, type WriteDeps } from './deps.js'

type AccountType = 'business' | 'creator'

interface PendingAuth {
  appSlug: string
  accountType: AccountType
  createdAt: number
}

export interface OAuthServerConfig {
  deps: WriteDeps
  /** Path of TIKTOK_REDIRECT_URI (e.g. /api/auth/tiktok/callback). */
  callbackPath?: string
  /** Injected so tests can drive user-info without the network. */
  fetchUserInfo?: (accessToken: string) => Promise<{ username: string; openId: string } | null>
  /** Clock for nonce expiry; defaults to deps.now. */
  now?: () => Date
}

const DEFAULT_CALLBACK_PATH = '/api/auth/tiktok/callback'
const NONCE_TTL_MS = 10 * 60 * 1000

/** Result of a handled callback — returned for tests and for the HTTP layer. */
export interface CallbackResult {
  ok: boolean
  status: number
  body: string
  ownedAccountId?: number
}

/**
 * The stateful callback handler, decoupled from the HTTP server so tests can
 * call `handleCallback`/`beginAuth` directly. The pending-nonce map is the CSRF
 * store; a nonce is consumed on use.
 */
export class OAuthHandler {
  private readonly deps: WriteDeps
  private readonly oauth: TikTokOAuthClient
  private readonly pending = new Map<string, PendingAuth>()
  private readonly fetchUserInfo: (accessToken: string) => Promise<{ username: string; openId: string } | null>
  private readonly now: () => Date

  constructor(cfg: OAuthServerConfig) {
    this.deps = cfg.deps
    this.oauth = cfg.deps.oauth
    this.now = cfg.now ?? cfg.deps.now
    this.fetchUserInfo = cfg.fetchUserInfo ?? defaultFetchUserInfo
  }

  /** Mint a single-use state nonce and return the consent URL to redirect to. */
  beginAuth(appSlug: string, accountType: AccountType): string {
    if (!appSlug) throw new Error('app_slug is required to begin authorisation')
    if (accountType !== 'business' && accountType !== 'creator') {
      throw new Error(`account_type must be 'business' or 'creator', got '${accountType}'`)
    }
    this.sweep()
    const nonce = randomUUID()
    this.pending.set(nonce, { appSlug, accountType, createdAt: this.now().getTime() })
    return this.oauth.authorizeUrl(nonce)
  }

  /** Handle the redirect callback: verify state, exchange, seal, upsert. */
  async handleCallback(params: URLSearchParams): Promise<CallbackResult> {
    const err = params.get('error')
    if (err) {
      return { ok: false, status: 400, body: `authorization declined: ${err}` }
    }
    const code = params.get('code')
    const state = params.get('state')
    if (!code || !state) {
      return { ok: false, status: 400, body: 'missing code or state' }
    }
    const ctx = this.pending.get(state)
    if (!ctx) {
      // Unknown/reused nonce — CSRF protection. Never proceed.
      return { ok: false, status: 403, body: 'invalid or expired state' }
    }
    this.pending.delete(state) // single-use

    let tokens: TikTokTokens
    try {
      tokens = await this.oauth.exchangeCode(code)
    } catch (e) {
      this.deps.logger.error(`[oauth] code exchange failed — ${errMsg(e)}`)
      return { ok: false, status: 502, body: 'token exchange failed' }
    }

    // open_id comes back on the token response; username is a nicety via user.info.
    let openId = tokens.openId
    let username = openId || 'unknown'
    try {
      const info = await this.fetchUserInfo(tokens.accessToken)
      if (info) {
        openId = info.openId || openId
        username = info.username || username
      }
    } catch (e) {
      this.deps.logger.warn(`[oauth] user.info fetch failed (non-fatal) — ${errMsg(e)}`)
    }

    if (!openId) {
      return { ok: false, status: 502, body: 'token response carried no open_id' }
    }

    const ownedAccountId = await this.upsertAccount({
      appSlug: ctx.appSlug,
      accountType: ctx.accountType,
      openId,
      username,
      tokens,
    })
    this.deps.logger.log(`[oauth] linked @${username} (${ctx.accountType}) as owned_account ${ownedAccountId}`)
    return { ok: true, status: 200, body: `linked @${username}. You can close this window.`, ownedAccountId }
  }

  private async upsertAccount(input: {
    appSlug: string
    accountType: AccountType
    openId: string
    username: string
    tokens: TikTokTokens
  }): Promise<number> {
    const sealedAccess = sealToken(input.tokens.accessToken, this.deps.tokenKey)
    const sealedRefresh = sealToken(input.tokens.refreshToken, this.deps.tokenKey)
    const nowIso = this.now().toISOString()

    const row = {
      app_slug: input.appSlug,
      tiktok_open_id: input.openId,
      username: input.username,
      account_type: input.accountType,
      access_token: bufferToPgBytea(sealedAccess),
      refresh_token: bufferToPgBytea(sealedRefresh),
      access_expires_at: input.tokens.accessExpiresAt.toISOString(),
      refresh_expires_at: input.tokens.refreshExpiresAt.toISOString(),
      // The 365-day re-auth window is measured from HERE and never moved on refresh.
      original_granted_at: nowIso,
      token_generation: 0,
    }

    const { data, error } = await this.deps.client
      .from('owned_account')
      .upsert(row, { onConflict: 'tiktok_open_id' })
      .select('id')
      .maybeSingle()
    if (error) throw error
    return (data as { id: number } | null)?.id ?? -1
  }

  private sweep(): void {
    const cutoff = this.now().getTime() - NONCE_TTL_MS
    for (const [k, v] of this.pending) if (v.createdAt < cutoff) this.pending.delete(k)
  }
}

/** // UNVERIFIED — TikTok user.info endpoint + field names. */
async function defaultFetchUserInfo(
  accessToken: string
): Promise<{ username: string; openId: string } | null> {
  const url = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,username'
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return null
  const raw = (await res.json().catch(() => null)) as { data?: { user?: { open_id?: string; username?: string } } } | null
  const user = raw?.data?.user
  if (!user) return null
  return { username: user.username ?? '', openId: user.open_id ?? '' }
}

/** Build (but do not listen on) the HTTP server. */
export function createOAuthServer(cfg: OAuthServerConfig): { server: Server; handler: OAuthHandler } {
  const handler = new OAuthHandler(cfg)
  const callbackPath = cfg.callbackPath ?? callbackPathFromEnv() ?? DEFAULT_CALLBACK_PATH

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, handler, callbackPath, cfg.deps)
  })
  return { server, handler }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handler: OAuthHandler,
  callbackPath: string,
  deps: WriteDeps
): Promise<void> {
  const reqUrl = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (reqUrl.pathname === '/auth/tiktok/start') {
      const appSlug = reqUrl.searchParams.get('app_slug') ?? ''
      const accountType = (reqUrl.searchParams.get('account_type') ?? '') as AccountType
      const redirectTo = handler.beginAuth(appSlug, accountType)
      res.writeHead(302, { Location: redirectTo })
      res.end()
      return
    }
    if (reqUrl.pathname === callbackPath) {
      const result = await handler.handleCallback(reqUrl.searchParams)
      res.writeHead(result.status, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(result.body)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  } catch (e) {
    deps.logger.error(`[oauth] request error — ${errMsg(e)}`)
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('bad request')
  }
}

function callbackPathFromEnv(): string | null {
  const uri = process.env.TIKTOK_REDIRECT_URI
  if (!uri) return null
  try {
    return new URL(uri).pathname
  } catch {
    return null
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  boot()
  const deps = makeWriteDeps({ client: db() })
  const port = Number(process.env.OAUTH_PORT ?? 3100)
  const { server } = createOAuthServer({ deps })
  server.listen(port, () => {
    console.log(`[oauth] write-plane callback listener on :${port}`)
    console.log(`[oauth] begin a link at /auth/tiktok/start?app_slug=<slug>&account_type=business`)
  })
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-write[\\/]src[\\/]oauth\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
