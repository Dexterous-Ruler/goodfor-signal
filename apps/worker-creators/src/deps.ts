/**
 * Write-plane Creator-CRM plumbing: the `CreatorDeps` bag every entrypoint
 * composes, plus `boot()` (loadEnv + the plane guard).
 *
 * COMPOSITION RULE (repo convention): packages are pure and injectable; the APP
 * is the only layer that touches `@goodfor/db` and wires real providers. Every
 * external side effect on `CreatorDeps` is overridable so the tests can mock ALL
 * I/O — no live Modash/HypeAuditor/TikTok creds, no real network, no real DB.
 *
 * This app composes @goodfor/db + @goodfor/creator-crm (+ @goodfor/contracts)
 * and imports NOTHING from the read plane (no @goodfor/tiktok-source, no
 * ENSEMBLEDATA_/SCRAPECREATORS_ credential).
 */

import { resolve } from 'node:path'

import { db, loadEnv, type Database, type Db } from '@goodfor/db'
import {
  ModashClient,
  createModashClient,
  HypeAuditorClient,
  createHypeAuditorClient,
} from '@goodfor/creator-crm'

import { assertWritePlane } from './guard.js'

// ---------------------------------------------------------------------------
// Table row/insert aliases for the 11 Creator-CRM tables the worker writes.
// ---------------------------------------------------------------------------
export type CreatorIdentityRow = Database['public']['Tables']['creator_identity']['Row']
export type CreatorIdentityInsert = Database['public']['Tables']['creator_identity']['Insert']
export type CreatorAccountRow = Database['public']['Tables']['creator_account']['Row']
export type CreatorAccountInsert = Database['public']['Tables']['creator_account']['Insert']
export type CreatorMetricSnapshotInsert = Database['public']['Tables']['creator_metric_snapshot']['Insert']
export type CreatorAudienceRow = Database['public']['Tables']['creator_audience']['Row']
export type CreatorAudienceInsert = Database['public']['Tables']['creator_audience']['Insert']
export type CampaignRow = Database['public']['Tables']['campaign']['Row']
export type CollaborationRow = Database['public']['Tables']['collaboration']['Row']
export type CollaborationInsert = Database['public']['Tables']['collaboration']['Insert']
export type CollaborationUpdate = Database['public']['Tables']['collaboration']['Update']
export type DeliverableRow = Database['public']['Tables']['deliverable']['Row']
export type DeliverableUpdate = Database['public']['Tables']['deliverable']['Update']
export type RightsGrantRow = Database['public']['Tables']['rights_grant']['Row']
export type PerformanceFactInsert = Database['public']['Tables']['performance_fact']['Insert']

export type Logger = Pick<Console, 'log' | 'warn' | 'error'>

// ---------------------------------------------------------------------------
// Outreach sender — DM (one-shot) + email cadence. Injectable; the default
// reads provider creds from env and throws at call time if unconfigured.
// // UNVERIFIED — TikTok DM + email-provider wire shapes are from docs.
// ---------------------------------------------------------------------------
export interface DmParams {
  platform: string
  platformUserId: string
  message: string
}
export interface EmailParams {
  to: string
  subject: string
  body: string
}
export interface SendResult {
  delivered: boolean
  providerId: string | null
}

export interface OutreachSender {
  /** TikTok delivers EXACTLY ONE DM to a non-follower then blocks — never retry. */
  sendDm(p: DmParams): Promise<SendResult>
  sendEmail(p: EmailParams): Promise<SendResult>
}

/**
 * Thrown when a DM/email was NEVER dispatched to the provider — the sender is
 * unconfigured or unimplemented. The outreach runner MUST treat this differently
 * from a genuine send failure: a one-shot TikTok DM is only "spent" once we have
 * actually hit the API, so a missing token must fail loudly (fix the config)
 * instead of silently burning every creator's single first-touch.
 */
export class OutreachNotDispatchedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutreachNotDispatchedError'
  }
}

/**
 * Default env-driven outreach sender. Both methods throw a clear Error at call
 * time until real provider creds are wired — the worker never sends silently.
 * // UNVERIFIED.
 */
export function createOutreachSender(env: Record<string, string | undefined> = process.env): OutreachSender {
  return {
    async sendDm(_p: DmParams): Promise<SendResult> {
      if (!env.TIKTOK_DM_ACCESS_TOKEN) {
        throw new OutreachNotDispatchedError('TIKTOK_DM_ACCESS_TOKEN is not set — cannot send a DM. Inject an OutreachSender in tests.')
      }
      throw new OutreachNotDispatchedError('TikTok DM sending is not implemented against a live account (// UNVERIFIED).')
    },
    async sendEmail(_p: EmailParams): Promise<SendResult> {
      if (!env.OUTREACH_EMAIL_API_KEY) {
        throw new OutreachNotDispatchedError('OUTREACH_EMAIL_API_KEY is not set — cannot send email. Inject an OutreachSender in tests.')
      }
      throw new OutreachNotDispatchedError('Email sending is not implemented against a live provider (// UNVERIFIED).')
    },
  }
}

// ---------------------------------------------------------------------------
// Spark Ads / Business Center client. Account-level linking (no expiry) is
// primary; per-video codes are the fallback. Codes CANNOT be reactivated — on
// auth_code_expired the worker mints a NEW code. // UNVERIFIED wire shapes.
// ---------------------------------------------------------------------------
export interface SparkPostMetrics {
  /** The organic post id — the permanent join key (§9.3). */
  platformPostId: string
  paidImpressions: number | null
  paidClicks: number | null
  paidConversions: number | null
  spendCents: number | null
}
export interface SparkCode {
  code: string
  expiresAt: string
}
export interface SparkClient {
  /** Business Center account-level linking (preferred — no expiry until unlinked). */
  linkBusinessCenter(params: { businessCenterId: string; advertiserId: string }): Promise<{ linked: boolean }>
  /** Pull paid metrics for a Spark-authorized post, keyed on the organic post id. */
  pullPostMetrics(platformPostId: string): Promise<SparkPostMetrics>
  /** Mint a NEW per-video Spark code (fallback / on auth_code_expired). */
  mintSparkCode(params: { platformPostId: string; durationDays?: number }): Promise<SparkCode>
}

/** Default env-driven Spark client; throws at call time until wired. // UNVERIFIED. */
export function createSparkClient(env: Record<string, string | undefined> = process.env): SparkClient {
  function assertToken(): void {
    if (!env.TIKTOK_BUSINESS_ACCESS_TOKEN) {
      throw new Error(
        'TIKTOK_BUSINESS_ACCESS_TOKEN is not set — cannot call Business Center / Spark. Inject a SparkClient in tests.'
      )
    }
  }
  return {
    async linkBusinessCenter() {
      assertToken()
      throw new Error('Business Center linking is not implemented against a live account (// UNVERIFIED).')
    },
    async pullPostMetrics() {
      assertToken()
      throw new Error('Spark metric pull is not implemented against a live account (// UNVERIFIED).')
    },
    async mintSparkCode() {
      assertToken()
      throw new Error('Spark code minting is not implemented against a live account (// UNVERIFIED).')
    },
  }
}

export interface CreatorDeps {
  client: Db
  modash: ModashClient
  hypeauditor: HypeAuditorClient
  outreach: OutreachSender
  spark: SparkClient
  now: () => Date
  logger: Logger
}

/**
 * Construct the write-plane Creator-CRM deps once: real providers by default,
 * every seam overridable for tests.
 */
export function makeCreatorDeps(overrides: Partial<CreatorDeps> = {}): CreatorDeps {
  const client = overrides.client ?? db()
  return {
    client,
    modash: overrides.modash ?? createModashClient(),
    hypeauditor: overrides.hypeauditor ?? createHypeAuditorClient(),
    outreach: overrides.outreach ?? createOutreachSender(),
    spark: overrides.spark ?? createSparkClient(),
    now: overrides.now ?? (() => new Date()),
    logger: overrides.logger ?? console,
  }
}

/**
 * Boot sequence for every entrypoint: load env (monorepo root first, then the
 * app cwd — matching worker-attribute), then assert plane isolation. Throws if a
 * read-plane credential is present.
 */
export function boot(): void {
  loadEnv(resolve(process.cwd(), '..', '..'))
  loadEnv()
  assertWritePlane()
}
