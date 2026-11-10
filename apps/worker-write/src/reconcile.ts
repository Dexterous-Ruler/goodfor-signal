/**
 * Reconciliation job (Phase 3 §Week-13 task 11).
 *
 * A 200 at publish time is NOT a publish: processing is async and
 * `publicaly_available_post_id` (TikTok's verbatim misspelling) only resolves
 * AFTER a human taps publish and moderation clears. This job polls the
 * `scheduled_post_reconcile_idx` (status='pending', publish_id not null) and
 * resolves `publish_id -> publicaly_available_post_id`.
 *
 * THE ZOMBIE SPECIAL-CASE: inbox drafts and private (SELF_ONLY) posts sit at
 * `SEND_TO_USER_INBOX` / pending INDEFINITELY with no webhook until a human makes
 * them public. Those must stay `pending` — we recognise them and leave them
 * untouched rather than flip them to failed or re-hammer them as if broken.
 *
 * Branches on the error-code STRING via the shared classifiers, never HTTP status.
 */

import { db } from '@goodfor/db'
import {
  classifyErrorCode,
  classifyPublishStatus,
  isInboxTerminal,
  openToken,
  type PublisherAccount,
} from '@goodfor/publishing'

import {
  boot,
  makeWriteDeps,
  pgByteaToBuffer,
  type OwnedAccountRow,
  type PublishAttemptInsert,
  type ScheduledPostRow,
  type WriteDeps,
} from './deps.js'

const RECONCILE_BATCH = 50
const APPEAL_SLA_MS = 24 * 60 * 60 * 1000
/** Privacy levels that legitimately stay pending forever (no webhook). */
const PRIVATE_LEVELS = new Set(['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR'])

export type ReconcileDisposition =
  | 'published'
  | 'failed'
  | 'pending_inbox' // inbox/private — legitimately stays pending, not a zombie
  | 'pending_moderation' // public, still processing/awaiting moderation
  | 'pending_transient' // a transient error; try again next pass
  | 'skipped'

/**
 * Reconcile one pending post. Returns the disposition (for logging/tests). The
 * key invariant: an inbox/private post is NEVER flipped off `pending`.
 */
export async function reconcilePost(deps: WriteDeps, post: ScheduledPostRow): Promise<ReconcileDisposition> {
  if (!post.publish_id) return 'skipped'

  const account = await loadAccount(deps, post.owned_account_id)
  if (!account) {
    deps.logger.error(`[reconcile] post ${post.id}: owned_account ${post.owned_account_id} missing`)
    return 'skipped'
  }

  const sealed = pgByteaToBuffer(account.access_token)
  if (!sealed) {
    deps.logger.error(`[reconcile] post ${post.id}: no access token`)
    return 'skipped'
  }
  let accessToken: string
  try {
    accessToken = openToken(sealed, deps.tokenKey)
  } catch (err) {
    deps.logger.error(`[reconcile] post ${post.id}: token open failed — ${errMsg(err)}`)
    return 'skipped'
  }
  const publisherAccount: PublisherAccount = { accessToken, openId: account.tiktok_open_id }

  const r = await deps.publisher.fetchStatus(publisherAccount, post.publish_id)
  await recordAttempt(deps, post, account, {
    errorCode: r.errorCode,
    httpStatus: r.httpStatus,
    raw: r.raw,
  })

  // Error-code STRING first, never the HTTP status.
  const cls = classifyErrorCode(r.errorCode)
  if (cls !== 'ok') {
    if (cls === 'auth' || cls === 'fatal') {
      await deps.client
        .from('scheduled_post')
        .update({ status: 'failed', fail_reason: r.errorCode })
        .eq('id', post.id)
      return 'failed'
    }
    // spam_risk / rate_limited / retryable — leave pending for a later pass.
    deps.logger.warn(`[reconcile] post ${post.id}: transient '${r.errorCode}', leaving pending`)
    return 'pending_transient'
  }

  const statusStr = r.data?.status ?? null
  const publicPostId = r.data?.publicPostId ?? null
  const ps = classifyPublishStatus(statusStr)

  if (ps === 'published' && publicPostId) {
    const now = deps.now()
    await deps.client
      .from('scheduled_post')
      .update({
        status: 'published',
        publicaly_available_post_id: publicPostId,
        published_at: now.toISOString(),
        appeal_deadline_at: new Date(now.getTime() + APPEAL_SLA_MS).toISOString(),
      })
      .eq('id', post.id)
    return 'published'
  }

  if (ps === 'failed') {
    await deps.client
      .from('scheduled_post')
      .update({ status: 'failed', fail_reason: r.data?.failReason ?? 'failed' })
      .eq('id', post.id)
    return 'failed'
  }

  // Pending. Distinguish a legitimate inbox/private draft (stays pending, not a
  // zombie) from a public post still clearing moderation. Neither is flipped off
  // 'pending' — we only LOG the reason so the queue is explainable.
  const isPrivate = post.privacy_level != null && PRIVATE_LEVELS.has(post.privacy_level)
  if (isInboxTerminal(statusStr) || isPrivate) {
    deps.logger.log(
      `[reconcile] post ${post.id}: inbox/private draft awaiting a human tap ` +
        `(status='${statusStr ?? 'null'}') — staying pending, not a zombie`
    )
    return 'pending_inbox'
  }
  deps.logger.log(`[reconcile] post ${post.id}: still processing (status='${statusStr ?? 'null'}')`)
  return 'pending_moderation'
}

export async function reconcileDue(deps: WriteDeps): Promise<Record<ReconcileDisposition, number>> {
  const posts = await loadPendingPosts(deps)
  const tally: Record<ReconcileDisposition, number> = {
    published: 0,
    failed: 0,
    pending_inbox: 0,
    pending_moderation: 0,
    pending_transient: 0,
    skipped: 0,
  }
  for (const post of posts) {
    try {
      tally[await reconcilePost(deps, post)]++
    } catch (err) {
      deps.logger.error(`[reconcile] post ${post.id} threw: ${errMsg(err)}`)
    }
  }
  return tally
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function loadPendingPosts(deps: WriteDeps): Promise<ScheduledPostRow[]> {
  const { data, error } = await deps.client
    .from('scheduled_post')
    .select('*')
    .eq('status', 'pending')
    .not('publish_id', 'is', null)
    .limit(RECONCILE_BATCH)
  if (error) throw error
  return (data as ScheduledPostRow[] | null) ?? []
}

async function loadAccount(deps: WriteDeps, id: number): Promise<OwnedAccountRow | null> {
  const { data, error } = await deps.client.from('owned_account').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data as OwnedAccountRow | null) ?? null
}

async function recordAttempt(
  deps: WriteDeps,
  post: ScheduledPostRow,
  account: OwnedAccountRow,
  info: { errorCode: string; httpStatus: number; raw: unknown }
): Promise<void> {
  const row: PublishAttemptInsert = {
    scheduled_post_id: post.id,
    owned_account_id: account.id,
    step: 'reconcile',
    error_code: info.errorCode,
    http_status: info.httpStatus || null,
    raw_response: (info.raw ?? null) as PublishAttemptInsert['raw_response'],
  }
  const { error } = await deps.client.from('publish_attempt').insert(row)
  if (error) deps.logger.error(`[reconcile] publish_attempt insert failed: ${error.message ?? error}`)
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
  const tally = await reconcileDue(deps)
  console.log(
    `[reconcile] published=${tally.published} failed=${tally.failed} ` +
      `inbox=${tally.pending_inbox} moderation=${tally.pending_moderation} ` +
      `transient=${tally.pending_transient} skipped=${tally.skipped}`
  )
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-write[\\/]src[\\/]reconcile\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
