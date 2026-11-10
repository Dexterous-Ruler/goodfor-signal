/**
 * Spark Ads sync (PHASE-5-scale-creators.md §9.3, §Work-breakdown 6).
 *
 * Spark Ads engagement accrues PERMANENTLY to the creator's ORIGINAL organic
 * post, not a separate ad object — so the organic post id
 * (`deliverable.platform_post_id`) is stored as THE JOIN KEY between organic and
 * paid performance. Prefer Business Center ACCOUNT-LEVEL linking (no expiry until
 * unlinked); per-video codes are the fallback.
 *
 * CODES CANNOT BE REACTIVATED. On `auth_code_expired` we mint a BRAND-NEW code
 * (never revive the old one). The client deliberately exposes no "reactivate"
 * method. Other terminal errors (`auth_code_format_error`, `not_public_video`,
 * `story_video_not_supported`) are logged and skipped, not retried.
 *
 * // UNVERIFIED — Business Center / Spark wire shapes are from docs, not a live
 * account.
 */

import type { CreatorDeps, DeliverableRow, DeliverableUpdate, SparkCode, SparkPostMetrics } from './deps.js'

/** Spark authorization error codes (§9.3). */
export const SPARK_ERROR = {
  authCodeExpired: 'auth_code_expired',
  authCodeFormatError: 'auth_code_format_error',
  notPublicVideo: 'not_public_video',
  storyVideoNotSupported: 'story_video_not_supported',
} as const
export type SparkErrorCode = (typeof SPARK_ERROR)[keyof typeof SPARK_ERROR]

/** Code durations 7 / 30 / 60 / 365 days; default 30 (§9.3). */
export const SPARK_CODE_DEFAULT_DURATION_DAYS = 30

function codeExpired(deliverable: DeliverableRow, now: Date): boolean {
  if (!deliverable.spark_ads_expires_at) return false
  return new Date(deliverable.spark_ads_expires_at).getTime() <= now.getTime()
}

/**
 * Mint a NEW Spark code for a deliverable and persist it. Called on
 * `auth_code_expired` or when the stored code has lapsed — NEVER an attempt to
 * reactivate the old code (that is impossible, §9.3).
 */
export async function mintNewSparkCode(
  deps: CreatorDeps,
  deliverable: DeliverableRow,
  opts: { durationDays?: number } = {}
): Promise<SparkCode> {
  if (!deliverable.platform_post_id) {
    throw new Error(
      `[spark-sync] deliverable ${deliverable.id} has no platform_post_id — cannot mint a Spark code without ` +
        `the organic post id (it is the join key, §9.3)`
    )
  }
  const code = await deps.spark.mintSparkCode({
    platformPostId: deliverable.platform_post_id,
    durationDays: opts.durationDays ?? SPARK_CODE_DEFAULT_DURATION_DAYS,
  })
  const update: DeliverableUpdate = {
    is_spark_ads_authorized: true,
    spark_ads_code: code.code,
    spark_ads_expires_at: code.expiresAt,
  }
  const { error } = await deps.client.from('deliverable').update(update).eq('id', deliverable.id)
  if (error) throw error
  deps.logger.log(
    `[spark-sync] minted NEW Spark code for deliverable ${deliverable.id} (post ${deliverable.platform_post_id}); ` +
      `old codes are never reactivated`
  )
  return code
}

/**
 * React to a Spark authorization error. `auth_code_expired` mints a new code;
 * every other terminal error is logged and skipped (not retried).
 */
export async function handleSparkError(
  deps: CreatorDeps,
  deliverable: DeliverableRow,
  errorCode: string
): Promise<SparkCode | null> {
  if (errorCode === SPARK_ERROR.authCodeExpired) {
    return mintNewSparkCode(deps, deliverable)
  }
  deps.logger.warn(
    `[spark-sync] deliverable ${deliverable.id}: terminal Spark error '${errorCode}' — skipping (not retried)`
  )
  return null
}

export interface SparkSyncResult {
  platformPostId: string | null
  metrics: SparkPostMetrics | null
  codeRefreshed: boolean
  newCode: SparkCode | null
}

/**
 * Sync one deliverable: refresh a lapsed per-video code if present, then pull
 * paid metrics keyed on the organic post id (the join key). Business Center
 * account-level linking needs no code, so metric pulls work regardless of the
 * code path.
 */
export async function syncSparkForDeliverable(
  deps: CreatorDeps,
  deliverable: DeliverableRow
): Promise<SparkSyncResult> {
  const now = deps.now()
  let codeRefreshed = false
  let newCode: SparkCode | null = null

  // Per-video fallback path: if a stored code has lapsed, mint a new one.
  if (deliverable.spark_ads_code && codeExpired(deliverable, now)) {
    newCode = await mintNewSparkCode(deps, deliverable)
    codeRefreshed = true
  }

  // Paid metrics join to the organic post via platform_post_id (§9.3).
  let metrics: SparkPostMetrics | null = null
  if (deliverable.platform_post_id) {
    metrics = await deps.spark.pullPostMetrics(deliverable.platform_post_id)
  }

  return { platformPostId: deliverable.platform_post_id, metrics, codeRefreshed, newCode }
}

// ---------------------------------------------------------------------------
// Entrypoint (spark-sync is invoked from the tick loop; standalone runnable too)
// ---------------------------------------------------------------------------
export async function main(): Promise<void> {
  const { boot, makeCreatorDeps } = await import('./deps.js')
  boot()
  const { db } = await import('@goodfor/db')
  const deps = makeCreatorDeps({ client: db() })
  deps.logger.log('[spark-sync] link Business Center account-level, then sync Spark-authorized deliverables.')
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-creators[\\/]src[\\/]spark-sync\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
