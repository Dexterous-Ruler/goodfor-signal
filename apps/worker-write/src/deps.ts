/**
 * Shared write-plane plumbing: the `WriteDeps` bag every entrypoint composes,
 * plus `boot()` (loadEnv + the plane guard) and the bytea<->Buffer helpers the
 * app needs to read/write the encrypted `owned_account` token columns.
 *
 * COMPOSITION RULE (repo convention): packages are pure and injectable; the APP
 * is the only layer that touches `@goodfor/db` and wires real providers. Every
 * external side effect on `WriteDeps` is overridable so the tests can mock ALL
 * I/O — no live TikTok creds, no real network, no real DB.
 *
 * This app composes @goodfor/db + @goodfor/publishing + @goodfor/compliance +
 * @goodfor/briefs and imports NOTHING from the read plane (no
 * @goodfor/tiktok-source, no ENSEMBLEDATA_/SCRAPECREATORS_ credential).
 */

import { resolve } from 'node:path'

import { db, loadEnv, type Database, type Db } from '@goodfor/db'
import {
  Governor,
  InboxPublisher,
  TikTokOAuthClient,
  type Publisher,
} from '@goodfor/publishing'

import { assertWritePlane } from './guard.js'

export type OwnedAccountRow = Database['public']['Tables']['owned_account']['Row']
export type OwnedAccountUpdate = Database['public']['Tables']['owned_account']['Update']
export type ScheduledPostRow = Database['public']['Tables']['scheduled_post']['Row']
export type ScheduledPostUpdate = Database['public']['Tables']['scheduled_post']['Update']
export type PublishAttemptInsert = Database['public']['Tables']['publish_attempt']['Insert']
export type AccountHealthInsert = Database['public']['Tables']['account_health']['Insert']

export type Logger = Pick<Console, 'log' | 'warn' | 'error'>

/**
 * How the tick sources the bytes/URL for a scheduled post. Either FILE_UPLOAD
 * bytes (chunked PUT) or a PULL_FROM_URL reference. The default returns a
 * PULL_FROM_URL from `video_asset_url` — note PULL_FROM_URL needs domain
 * verification or the init returns `url_ownership_unverified` (branch on that
 * error-code STRING, never the HTTP status). Tests inject bytes instead.
 */
export type LoadedVideo = { bytes: Uint8Array; mimeType?: string } | { pullUrl: string }

/** // UNVERIFIED — TikTok API-for-Business insight shape (health.ts). */
export interface BusinessInsight {
  /** 90-day rolling strikes keyed by policy area. */
  strikeCountByArea: Record<string, number>
  /** For-You-feed traffic share, 0..1. */
  fyfTrafficShare: number | null
  /** Search traffic share, 0..1 — persisted so the suppression detector is possible. */
  searchTrafficShare: number | null
  /** Account Check originality status for the account's recent posts. */
  originalityStatus: string | null
  /** Non-FYF, non-search share held for the suppression comparison (0..1). */
  otherTrafficShare?: number | null
}

export interface WriteDeps {
  client: Db
  /** The real draft/inbox publisher (path A). Never Direct Post. */
  publisher: Publisher
  governor: Governor
  oauth: TikTokOAuthClient
  /**
   * AES-256-GCM key override for seal/openToken. `undefined` in prod → the token
   * module reads `TOKEN_ENCRYPTION_KEY` from env. Tests pass an explicit key.
   */
  tokenKey?: string | Buffer
  now: () => Date
  logger: Logger
  loadVideo: (post: ScheduledPostRow) => Promise<LoadedVideo>
  /** // UNVERIFIED business-API call; default throws until wired to a real client. */
  businessInsights: (account: OwnedAccountRow) => Promise<BusinessInsight | null>
  /**
   * Serialise per-account critical sections (token refresh). Default acquires a
   * Postgres advisory lock; tests inject a pass-through.
   */
  withAccountLock: <T>(accountId: number, fn: () => Promise<T>) => Promise<T>
}

// ---------------------------------------------------------------------------
// bytea helpers — owned_account.access_token/refresh_token are bytea and hold
// ONLY ciphertext (iv‖authTag‖data from sealToken). PostgREST renders bytea as
// a `\x<hex>` string on read and accepts the same on write.
// ---------------------------------------------------------------------------

export function bufferToPgBytea(buf: Buffer): string {
  return '\\x' + buf.toString('hex')
}

export function pgByteaToBuffer(v: unknown): Buffer | null {
  if (v == null) return null
  if (Buffer.isBuffer(v)) return v
  if (typeof v !== 'string') return null
  if (v.startsWith('\\x')) {
    try {
      return Buffer.from(v.slice(2), 'hex')
    } catch {
      return null
    }
  }
  try {
    return Buffer.from(v, 'base64')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default per-account lock. Wraps the critical section in a Postgres advisory
 * lock keyed on `owned_account.id`.
 *
 * // UNVERIFIED — requires SQL wrappers in the public schema that PostgREST can
 * expose, e.g.:
 *   create function app_advisory_lock(key bigint) returns void
 *     language sql as $$ select pg_advisory_lock(key) $$;
 *   create function app_advisory_unlock(key bigint) returns void
 *     language sql as $$ select pg_advisory_unlock(key) $$;
 * PgBouncer NOTE: session-level advisory locks require a session-pinned
 * connection; in a transaction-pooled prod deploy, fold the whole rotation into
 * a single RPC that takes `pg_advisory_xact_lock(id)` in its own transaction.
 * The token module ALSO guards the write with an optimistic `token_generation`
 * check (compare-and-swap), so a lost lock cannot double-rotate — that CAS is
 * the load-bearing backstop, this lock is the primary serialiser.
 */
type RpcClient = { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ error: unknown }> }

async function pgAdvisoryLock<T>(client: Db, accountId: number, fn: () => Promise<T>): Promise<T> {
  const rpc = client as unknown as RpcClient
  await rpc.rpc('app_advisory_lock', { key: accountId })
  try {
    return await fn()
  } finally {
    await rpc.rpc('app_advisory_unlock', { key: accountId })
  }
}

async function defaultLoadVideo(post: ScheduledPostRow): Promise<LoadedVideo> {
  if (!post.video_asset_url) {
    throw new Error(`scheduled_post ${post.id} has no video_asset_url to publish`)
  }
  return { pullUrl: post.video_asset_url }
}

async function defaultBusinessInsights(): Promise<BusinessInsight | null> {
  // // UNVERIFIED — TikTok API for Business (Accounts API) is gated behind the
  // access form and its response shape is not validated. Wire a real client in
  // prod; until then health.ts records nothing rather than inventing numbers.
  throw new Error(
    'businessInsights is not wired — inject a real TikTok API-for-Business client (health poller)'
  )
}

/**
 * Construct the write-plane deps once. Mirrors worker-analyse `makeDeps`:
 * real providers by default, every seam overridable for tests.
 */
export function makeWriteDeps(overrides: Partial<WriteDeps> = {}): WriteDeps {
  const client = overrides.client ?? db()
  return {
    client,
    publisher: overrides.publisher ?? new InboxPublisher(),
    governor: overrides.governor ?? new Governor(),
    oauth: overrides.oauth ?? new TikTokOAuthClient(),
    tokenKey: overrides.tokenKey,
    now: overrides.now ?? (() => new Date()),
    logger: overrides.logger ?? console,
    loadVideo: overrides.loadVideo ?? defaultLoadVideo,
    businessInsights: overrides.businessInsights ?? defaultBusinessInsights,
    withAccountLock:
      overrides.withAccountLock ?? ((accountId, fn) => pgAdvisoryLock(client, accountId, fn)),
  }
}

/**
 * Boot sequence for every entrypoint: load env (monorepo root first, then the
 * app cwd — matching worker-analyse), then assert plane isolation. Returns
 * nothing; throws if a read-plane credential is present.
 */
export function boot(): void {
  loadEnv(resolve(process.cwd(), '..', '..'))
  loadEnv()
  assertWritePlane()
}
