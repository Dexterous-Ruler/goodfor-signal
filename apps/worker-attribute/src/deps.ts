/**
 * Write-plane attribution plumbing: the `AttributeDeps` bag every entrypoint
 * composes, plus `boot()` (loadEnv + the plane guard).
 *
 * COMPOSITION RULE (repo convention): packages are pure and injectable; the APP
 * is the only layer that touches `@goodfor/db` and wires real providers. Every
 * external side effect on `AttributeDeps` is overridable so the tests can mock
 * ALL I/O — no live Kochava/Apple creds, no real network, no real DB.
 *
 * This app composes @goodfor/db + @goodfor/attribution (+ @goodfor/contracts)
 * and imports NOTHING from the read plane (no @goodfor/tiktok-source, no
 * ENSEMBLEDATA_/SCRAPECREATORS_ credential).
 */

import { resolve } from 'node:path'

import { db, loadEnv, type Database, type Db } from '@goodfor/db'
import { KochavaClient, createKochavaClient } from '@goodfor/attribution'

import { assertWritePlane } from './guard.js'

export type BioLinkRow = Database['public']['Tables']['bio_link']['Row']
export type BioLinkRotationRow = Database['public']['Tables']['bio_link_rotation']['Row']
export type BioLinkRotationInsert = Database['public']['Tables']['bio_link_rotation']['Insert']
export type BioLinkRotationUpdate = Database['public']['Tables']['bio_link_rotation']['Update']
export type AttributedInstallRow = Database['public']['Tables']['attributed_install']['Row']
export type AttributedInstallInsert = Database['public']['Tables']['attributed_install']['Insert']
export type AppleAnalyticsDailyRow = Database['public']['Tables']['apple_analytics_daily']['Row']
export type AppleAnalyticsDailyInsert = Database['public']['Tables']['apple_analytics_daily']['Insert']
export type CustomProductPageRow = Database['public']['Tables']['custom_product_page']['Row']
export type CustomProductPageInsert = Database['public']['Tables']['custom_product_page']['Insert']
export type FormatLiftInsert = Database['public']['Tables']['format_lift']['Insert']

export type Logger = Pick<Console, 'log' | 'warn' | 'error'>

/**
 * Apple App Store Connect credentials for the Analytics Reports API JWT.
 * Read from env; the JWT builder throws at call time if any are missing.
 * // UNVERIFIED — not validated against a live App Store Connect key.
 */
export interface AppleConfig {
  issuerId: string
  keyId: string
  /** The .p8 private key PEM (EC P-256). Store as a secret, never in the repo. */
  privateKeyPem: string
}

export interface AttributeDeps {
  client: Db
  /** Kochava owned-media MMP client (billing-trap guarded). */
  kochava: KochavaClient
  /** Apple ASC credentials, or null when not provisioned (apple-poll throws). */
  appleConfig: AppleConfig | null
  now: () => Date
  logger: Logger
}

/**
 * Read the Apple config from env, or null if not fully provisioned. Env var
 * names follow the existing `.env.example` Attribution section
 * (`APP_STORE_CONNECT_*`). A base64-encoded key (`APP_STORE_CONNECT_PRIVATE_KEY_B64`)
 * is supported for single-line secret stores; otherwise a raw PEM.
 */
export function readAppleConfig(env: Record<string, string | undefined> = process.env): AppleConfig | null {
  const issuerId = env.APP_STORE_CONNECT_ISSUER_ID
  const keyId = env.APP_STORE_CONNECT_KEY_ID
  const privateKeyPem = env.APP_STORE_CONNECT_PRIVATE_KEY_B64
    ? Buffer.from(env.APP_STORE_CONNECT_PRIVATE_KEY_B64, 'base64').toString('utf8')
    : env.APP_STORE_CONNECT_PRIVATE_KEY
  if (!issuerId || !keyId || !privateKeyPem) return null
  return { issuerId, keyId, privateKeyPem }
}

/**
 * Construct the write-plane attribution deps once: real providers by default,
 * every seam overridable for tests.
 */
export function makeAttributeDeps(overrides: Partial<AttributeDeps> = {}): AttributeDeps {
  const client = overrides.client ?? db()
  return {
    client,
    kochava: overrides.kochava ?? createKochavaClient(),
    appleConfig: overrides.appleConfig ?? readAppleConfig(),
    now: overrides.now ?? (() => new Date()),
    logger: overrides.logger ?? console,
  }
}

/**
 * Boot sequence for every entrypoint: load env (monorepo root first, then the
 * app cwd — matching worker-write), then assert plane isolation. Throws if a
 * read-plane credential is present.
 */
export function boot(): void {
  loadEnv(resolve(process.cwd(), '..', '..'))
  loadEnv()
  assertWritePlane()
}
