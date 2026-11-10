/**
 * Write-plane tick loop (Phase 3 §Week-13 task 13). 60s `setInterval` + `--once`,
 * mirroring `apps/worker-read/src/tick.ts`.
 *
 * Per pass it drains due `scheduled_post` rows (the `scheduled_post_due_idx`
 * partial index: status in ('draft','queued'), ordered by `scheduled_for`),
 * and for each:
 *   1. enforces the app-side disclosure gate — a post with disclosure_type<>'none'
 *      must have disclosure_verified AND disclosure_region before it can advance.
 *      (The DB trigger `enforce_disclosure_gate` is the NON-bypassable backstop;
 *      this is the friendlier early skip so we never even try to advance it.)
 *   2. asks the Governor (12/24h, 4 in-flight, spam quarantine) — `canPost`;
 *   3. CLAIMS the row with a compare-and-swap status flip (queued/draft ->
 *      uploading) so a redelivery / second worker cannot double-post
 *      (idempotency: the CAS + the unique idempotency_key + the publish_id check);
 *   4. runs the PublishStateMachine over the shared InboxPublisher;
 *   5. logs EVERY transition to `publish_attempt`;
 *   6. folds the outcome back through `Governor.onResult` and persists the post +
 *      account state.
 *
 * The state machine NEVER does DB writes; the app owns all persistence. The
 * machine branches on the TikTok error-code STRING, never the HTTP status.
 */

import { db } from '@goodfor/db'
import {
  PublishStateMachine,
  type OnTransition,
  type PublishJob,
  type PublishOutcome,
  type PublisherAccount,
  openToken,
} from '@goodfor/publishing'

import {
  boot,
  makeWriteDeps,
  pgByteaToBuffer,
  type OwnedAccountRow,
  type OwnedAccountUpdate,
  type PublishAttemptInsert,
  type ScheduledPostRow,
  type ScheduledPostUpdate,
  type WriteDeps,
} from './deps.js'

const TICK_MS = 60_000
const DRAIN_BATCH = 20
const APPEAL_SLA_MS = 24 * 60 * 60 * 1000

/** Active-post context for `onTransition` attribution. Safe because posts are
 * processed strictly sequentially (each `run()` is awaited before the next). */
interface ActiveContext {
  scheduledPostId: number
  ownedAccountId: number
}

/**
 * A tick runner constructed ONCE per process: it owns the single
 * PublishStateMachine (bound to the shared Publisher) and the mutable active
 * context its `onTransition` reads. `runDuePosts` is called every tick.
 */
export interface TickRunner {
  runDuePosts(): Promise<{ processed: number; published: number; pending: number; failed: number }>
  /** Exposed for tests: drive exactly one already-loaded post. */
  processPost(post: ScheduledPostRow): Promise<PublishOutcome | null>
}

export function createTickRunner(deps: WriteDeps): TickRunner {
  let active: ActiveContext | null = null

  const onTransition: OnTransition = async (step, info) => {
    if (!active) return
    const row: PublishAttemptInsert = {
      scheduled_post_id: active.scheduledPostId,
      owned_account_id: active.ownedAccountId,
      step,
      error_code: info.errorCode,
      http_status: info.httpStatus || null,
      raw_response: (info.raw ?? null) as PublishAttemptInsert['raw_response'],
    }
    const { error } = await deps.client.from('publish_attempt').insert(row)
    if (error) deps.logger.error(`[publish] publish_attempt insert failed: ${error.message ?? error}`)
  }

  // Constructed ONCE (task 13). maxStatusPolls=1: the tick does a single status
  // probe; reconcile.ts owns the long tail (inbox drafts poll indefinitely).
  const sm = new PublishStateMachine({ publisher: deps.publisher, onTransition, maxStatusPolls: 1 })

  async function loadAccount(id: number): Promise<OwnedAccountRow | null> {
    const { data, error } = await deps.client
      .from('owned_account')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    return (data as OwnedAccountRow | null) ?? null
  }

  async function processPost(post: ScheduledPostRow): Promise<PublishOutcome | null> {
    // (1) App-side disclosure gate — never advance a promotional post that has
    // not been verified. The DB trigger would reject it anyway; this avoids the
    // wasted attempt and surfaces the reason in the log.
    if (post.disclosure_type !== 'none' && (!post.disclosure_verified || !post.disclosure_region)) {
      deps.logger.warn(
        `[publish] post ${post.id} blocked: disclosure_type='${post.disclosure_type}' needs ` +
          `disclosure_verified + disclosure_region before it can advance past draft`
      )
      return null
    }

    // A post that already has a publish_id is mid-flight / awaiting moderation —
    // reconcile.ts owns it. Never re-init (that would create a second draft).
    if (post.publish_id) {
      deps.logger.log(`[publish] post ${post.id} already has publish_id — leaving to reconcile`)
      return null
    }

    const account = await loadAccount(post.owned_account_id)
    if (!account) {
      deps.logger.error(`[publish] post ${post.id}: owned_account ${post.owned_account_id} missing`)
      return null
    }

    // (2) Governor.
    const state = {
      postsLast24h: account.posts_last_24h,
      uploadsInFlight: account.uploads_in_flight,
      quarantinedUntil: account.quarantined_until ? new Date(account.quarantined_until) : null,
    }
    const decision = deps.governor.canPost(state, { now: deps.now() })
    if (!decision.ok) {
      deps.logger.log(`[publish] post ${post.id} deferred by governor: ${decision.reason}`)
      return null
    }

    // (3) Claim the row: CAS status <prev> -> 'uploading'. If the update matches
    // zero rows, another worker already took it — bail (no double-post).
    const claimed = await claim(deps, post)
    if (!claimed) {
      deps.logger.log(`[publish] post ${post.id} already claimed by another worker`)
      return null
    }

    // Reserve an in-flight upload slot before the upload starts.
    const reserved = deps.governor.register(state)
    await deps.client
      .from('owned_account')
      .update({ uploads_in_flight: reserved.uploadsInFlight })
      .eq('id', account.id)

    // Decrypt the access token (bytea -> Buffer -> plaintext). The plaintext
    // never leaves this process; the packages receive only the decrypted string.
    const sealed = pgByteaToBuffer(account.access_token)
    if (!sealed) {
      await finishPost(deps, post, account, state, {
        status: 'failed',
        publishId: null,
        publicPostId: null,
        errorCode: 'no_access_token',
        step: 'creator_info',
        needsUrlVerification: false,
      })
      return null
    }
    let accessToken: string
    try {
      accessToken = openToken(sealed, deps.tokenKey)
    } catch (err) {
      deps.logger.error(`[publish] post ${post.id}: token open failed — ${errMsg(err)}`)
      await finishPost(deps, post, account, state, {
        status: 'failed',
        publishId: null,
        publicPostId: null,
        errorCode: 'token_open_failed',
        step: 'creator_info',
        needsUrlVerification: false,
      })
      return null
    }
    const publisherAccount: PublisherAccount = {
      accessToken,
      openId: account.tiktok_open_id,
    }

    // (4) Build the job and run the machine (attribution set for onTransition).
    const loaded = await deps.loadVideo(post)
    const job: PublishJob =
      'bytes' in loaded
        ? { account: publisherAccount, video: { bytes: loaded.bytes, mimeType: loaded.mimeType } }
        : { account: publisherAccount, init: { sourceInfo: { source: 'PULL_FROM_URL', videoUrl: loaded.pullUrl } } }

    active = { scheduledPostId: post.id, ownedAccountId: account.id }
    let outcome: PublishOutcome
    try {
      outcome = await sm.run(job)
    } finally {
      active = null
    }

    // (6) Persist post + account.
    await finishPost(deps, post, account, state, outcome)
    return outcome
  }

  async function runDuePosts() {
    const posts = await loadDuePosts(deps)
    let published = 0
    let pending = 0
    let failed = 0
    for (const post of posts) {
      try {
        const outcome = await processPost(post)
        if (outcome?.status === 'published') published++
        else if (outcome?.status === 'pending') pending++
        else if (outcome?.status === 'failed' || outcome?.status === 'quarantined') failed++
      } catch (err) {
        deps.logger.error(`[publish] post ${post.id} threw: ${errMsg(err)}`)
      }
    }
    return { processed: posts.length, published, pending, failed }
  }

  return { runDuePosts, processPost }
}

// ---------------------------------------------------------------------------
// DB helpers (all persistence lives here, never in the packages)
// ---------------------------------------------------------------------------

async function loadDuePosts(deps: WriteDeps): Promise<ScheduledPostRow[]> {
  const { data, error } = await deps.client
    .from('scheduled_post')
    .select('*')
    .in('status', ['draft', 'queued'])
    .lte('scheduled_for', deps.now().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(DRAIN_BATCH)
  if (error) throw error
  return (data as ScheduledPostRow[] | null) ?? []
}

/**
 * Compare-and-swap claim: flip the row to 'uploading' ONLY while its status is
 * still what we read. The `.eq('status', post.status)` filter is the idempotency
 * guard — a redelivered tick or a second worker updates zero rows and backs off.
 */
async function claim(deps: WriteDeps, post: ScheduledPostRow): Promise<boolean> {
  const { data, error } = await deps.client
    .from('scheduled_post')
    .update({ status: 'uploading' })
    .eq('id', post.id)
    .eq('status', post.status)
    .select('id')
  if (error) throw error
  return Array.isArray(data) && data.length > 0
}

/**
 * Fold an outcome into the post + account rows. Governor.onResult decides the
 * next account state (spam_risk_* -> 24h quarantine no-retry; a published post
 * counts against the 24h cap; an inbox-pending delivery does NOT).
 */
async function finishPost(
  deps: WriteDeps,
  post: ScheduledPostRow,
  account: OwnedAccountRow,
  preState: { postsLast24h: number; uploadsInFlight: number; quarantinedUntil: Date | null },
  outcome: PublishOutcome
): Promise<void> {
  const now = deps.now()
  // The state we reserved a slot against (register bumped in-flight by 1).
  const reserved = { ...preState, uploadsInFlight: preState.uploadsInFlight + 1 }

  // Map the outcome to the governor's result vocabulary. A `pending` inbox
  // delivery is neither a success (no public post yet) nor a hard failure — a
  // synthetic non-'ok', non-spam code releases the slot without counting a post.
  const govResult =
    outcome.status === 'published'
      ? { success: true, errorCode: 'ok' }
      : outcome.status === 'pending'
        ? { success: false, errorCode: 'pending_inbox' }
        : { success: false, errorCode: outcome.errorCode }

  const gov = deps.governor.onResult(reserved, govResult, { now })

  // owned_account update.
  const accountUpdate: OwnedAccountUpdate = {
    posts_last_24h: gov.state.postsLast24h,
    uploads_in_flight: gov.state.uploadsInFlight,
    quarantined_until: gov.state.quarantinedUntil ? gov.state.quarantinedUntil.toISOString() : account.quarantined_until,
  }
  if (gov.quarantined) accountUpdate.quarantine_reason = outcome.errorCode
  await deps.client.from('owned_account').update(accountUpdate).eq('id', account.id)

  // scheduled_post update.
  const postUpdate: ScheduledPostUpdate = { publish_id: outcome.publishId }
  if (outcome.status === 'published') {
    const publishedAt = now.toISOString()
    postUpdate.status = 'published'
    postUpdate.publicaly_available_post_id = outcome.publicPostId
    postUpdate.published_at = publishedAt
    postUpdate.appeal_deadline_at = new Date(now.getTime() + APPEAL_SLA_MS).toISOString()
  } else if (outcome.status === 'pending') {
    // Delivered to the inbox / awaiting moderation. Reconcile resolves the
    // public id after a human taps publish; do NOT mark it failed.
    postUpdate.status = 'pending'
  } else if (outcome.status === 'quarantined') {
    postUpdate.status = 'failed'
    postUpdate.fail_reason = outcome.errorCode
    postUpdate.spam_risk_code = outcome.errorCode
  } else {
    postUpdate.status = 'failed'
    postUpdate.fail_reason = outcome.errorCode
  }
  await deps.client.from('scheduled_post').update(postUpdate).eq('id', post.id)
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
  const runner = createTickRunner(deps)

  const res = await runner.runDuePosts()
  console.log(
    `[publish] tick: ${res.processed} due, ${res.published} published, ${res.pending} pending, ${res.failed} failed`
  )
  if (process.argv.includes('--once')) return

  console.log(`[publish] entering loop, every ${TICK_MS / 1000}s. Ctrl-C to stop.`)
  setInterval(() => {
    runner.runDuePosts().catch((e) => console.error('[publish] tick error', e))
  }, TICK_MS)
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-write[\\/]src[\\/]tick\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
