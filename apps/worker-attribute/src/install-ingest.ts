/**
 * Install ingest (PHASE-4-attribute.md §Work-breakdown 4).
 *
 * Receives an install callback (from the Goodfor app backend on first launch, or
 * a Kochava owned-media postback), resolves the bio-link rotation that was LIVE
 * at click time, and writes exactly one `attributed_install`.
 *
 * DETERMINISM (§10.1): `is_deterministic = true` ONLY for an Android Play Install
 * Referrer (`source = 'play_referrer'`) — that carries `utm_content=<video_id>`
 * with 100% certainty. Everything iOS (Kochava/HDYHAU/extrapolated) is
 * best-effort and stored `is_deterministic = false`; an iOS per-video number is
 * NEVER presented as deterministic.
 *
 * PRIVACY (§ + system rules): a device id / user id / PII is never placed in a
 * URL. The Android referrer's `utm_content` is validated to be a bare numeric
 * video id (via @goodfor/attribution) before anything is stored.
 */

import { parseInstallReferrer, type InstallReferrer } from '@goodfor/attribution'

import { resolveRotationAtClick } from './bio-link.js'
import type { AttributeDeps, AttributedInstallInsert, BioLinkRotationRow } from './deps.js'

export type InstallSource = 'play_referrer' | 'kochava' | 'hdyhau' | 'ios_extrapolated'

export interface InstallCallback {
  platform: 'android' | 'ios'
  /** Which bio link was clicked (from the short link), if known. */
  bioLinkId?: number | null
  /** Raw Android Play Install Referrer string (android + play_referrer). */
  referrer?: string | null
  /** iOS best-effort video id, when a channel provides one (never guaranteed). */
  utmContent?: string | null
  /** When the user clicked the bio link. Defaults to installedAt. */
  clickedAt?: string | null
  installedAt: string
  firstLaunchAt?: string | null
  /** Opaque pseudo id — NEVER PII, never from a URL. */
  devicePseudoId?: string | null
  /** Attribution source. Inferred from platform when omitted. */
  source?: InstallSource
}

export interface IngestResult {
  installId: number | null
  isDeterministic: boolean
  rotation: BioLinkRotationRow | null
  utmContent: string | null
}

function inferSource(cb: InstallCallback): InstallSource {
  if (cb.source) return cb.source
  return cb.platform === 'android' && cb.referrer ? 'play_referrer' : 'ios_extrapolated'
}

/**
 * Ingest one install callback -> one `attributed_install` row. Returns the new
 * install id plus the resolved rotation / utm_content (for logging and tests).
 */
export async function ingestInstall(deps: AttributeDeps, cb: InstallCallback): Promise<IngestResult> {
  const source = inferSource(cb)
  // Deterministic ONLY for an Android Play Install Referrer.
  const isDeterministic = cb.platform === 'android' && source === 'play_referrer'

  // Parse + validate the Android referrer (rejects PII / non-numeric ids).
  let referrer: InstallReferrer | null = null
  if (cb.platform === 'android' && cb.referrer) {
    referrer = parseInstallReferrer(cb.referrer) // throws on malformed / PII
  }

  const clickAt = cb.clickedAt ?? cb.installedAt

  // Resolve the rotation live at click time (gives featured_post + format).
  let rotation: BioLinkRotationRow | null = null
  if (cb.bioLinkId != null) {
    rotation = await resolveRotationAtClick(deps, cb.bioLinkId, clickAt)
  }

  // utm_content: Android referrer is ground truth; otherwise fall back to the
  // rotation's stamped video (best-effort iOS) or an explicit callback value.
  const utmContent =
    referrer?.videoId ?? cb.utmContent ?? rotation?.utm_content ?? null

  const row: AttributedInstallInsert = {
    platform: cb.platform,
    owned_account_id: null, // resolved from the bio link if/when needed downstream
    featured_post_id: rotation?.featured_post_id ?? null,
    format_cluster_id: rotation?.format_cluster_id ?? null,
    utm_content: utmContent,
    is_deterministic: isDeterministic,
    source,
    installed_at: cb.installedAt,
    first_launch_at: cb.firstLaunchAt ?? null,
    device_pseudo_id: cb.devicePseudoId ?? null,
  }

  const { data, error } = await deps.client
    .from('attributed_install')
    .insert(row)
    .select('id')
    .single()
  if (error) throw error
  const installId = (data as { id: number } | null)?.id ?? null

  deps.logger.log(
    `[install-ingest] ${cb.platform} install via ${source} -> ` +
      `${isDeterministic ? 'DETERMINISTIC' : 'best-effort'} ` +
      `(post=${row.featured_post_id ?? 'none'}, utm_content=${utmContent ?? 'none'})`
  )
  return { installId, isDeterministic, rotation, utmContent }
}
