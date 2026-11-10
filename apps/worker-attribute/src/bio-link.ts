/**
 * Bio-link rotation service (PHASE-4-attribute.md §Work-breakdown 5).
 *
 * Organic TikTok has no per-video link. The ONLY per-video signal for an organic
 * install is "which featured video was live in the account's bio when the user
 * clicked". So every time we change the featured post we APPEND a
 * `bio_link_rotation` row stamping `utm_content = published video id` and
 * `format_cluster_id`, and CLOSE the previous live row by stamping its
 * `rotated_off_at`.
 *
 * APPEND-ONLY invariant (§12): the rotation history is never UPDATEd except for
 * the single permitted mutation of stamping `rotated_off_at` on the row being
 * closed. Nothing else about a historical rotation row is ever changed.
 *
 * PRIVACY invariant: `utm_content` carries a bare numeric video id, never PII.
 */

import type {
  AttributeDeps,
  BioLinkRotationInsert,
  BioLinkRotationRow,
} from './deps.js'

/** Bare-numeric video id — same privacy invariant as the install referrer. */
const VIDEO_ID_RE = /^\d{5,25}$/

export interface RotateBioLinkInput {
  bioLinkId: number
  /** scheduled_post.id of the newly-featured post. */
  featuredPostId: number
  /** The published TikTok video id (utm_content). Numeric, never PII. */
  utmContent: string
  formatClusterId?: number | null
  /** When the rotation takes effect. Default `deps.now()`. */
  rotatedOnAt?: string
}

export interface RotateBioLinkResult {
  closedRotationId: number | null
  newRotationId: number | null
}

/** The currently-live rotation for a bio link (rotated_off_at is null), or null. */
export async function currentLiveRotation(
  deps: AttributeDeps,
  bioLinkId: number
): Promise<BioLinkRotationRow | null> {
  const { data, error } = await deps.client
    .from('bio_link_rotation')
    .select('*')
    .eq('bio_link_id', bioLinkId)
    .is('rotated_off_at', null)
    .order('rotated_on_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as BioLinkRotationRow | null) ?? null
}

/**
 * Rotate the featured post for an account's bio link: close the previous live
 * rotation (stamp `rotated_off_at`) and append a new live rotation row.
 */
export async function rotateBioLink(
  deps: AttributeDeps,
  input: RotateBioLinkInput
): Promise<RotateBioLinkResult> {
  if (!VIDEO_ID_RE.test(input.utmContent)) {
    throw new Error(
      `rotateBioLink: utm_content '${input.utmContent}' is not a bare numeric video id (privacy invariant)`
    )
  }
  const rotatedOnAt = input.rotatedOnAt ?? deps.now().toISOString()

  // Close the previous live rotation — the ONLY permitted UPDATE on the history.
  let closedRotationId: number | null = null
  const live = await currentLiveRotation(deps, input.bioLinkId)
  if (live) {
    const { error } = await deps.client
      .from('bio_link_rotation')
      .update({ rotated_off_at: rotatedOnAt })
      .eq('id', live.id)
      .is('rotated_off_at', null) // guard: never re-close a closed row
    if (error) throw error
    closedRotationId = live.id
  }

  // Append the new live rotation.
  const row: BioLinkRotationInsert = {
    bio_link_id: input.bioLinkId,
    featured_post_id: input.featuredPostId,
    utm_content: input.utmContent,
    format_cluster_id: input.formatClusterId ?? null,
    rotated_on_at: rotatedOnAt,
    rotated_off_at: null,
  }
  const { data, error } = await deps.client
    .from('bio_link_rotation')
    .insert(row)
    .select('id')
    .single()
  if (error) throw error
  const newRotationId = (data as { id: number } | null)?.id ?? null

  deps.logger.log(
    `[bio-link] rotated bio_link ${input.bioLinkId} -> post ${input.featuredPostId} ` +
      `(utm_content=${input.utmContent}); closed rotation ${closedRotationId ?? 'none'}`
  )
  return { closedRotationId, newRotationId }
}

/**
 * Resolve which rotation was LIVE at a given click time: `rotated_on_at <= click`
 * AND (`rotated_off_at` is null OR `click <= rotated_off_at`). This is what pins
 * an organic install back to the video that was featured when the user clicked.
 *
 * We fetch the bio link's rotations and select in JS (rather than a PostgREST OR
 * filter) so the window logic is explicit and testable.
 */
export async function resolveRotationAtClick(
  deps: AttributeDeps,
  bioLinkId: number,
  clickAt: string
): Promise<BioLinkRotationRow | null> {
  const { data, error } = await deps.client
    .from('bio_link_rotation')
    .select('*')
    .eq('bio_link_id', bioLinkId)
    .order('rotated_on_at', { ascending: false })
  if (error) throw error
  const rows = (data as BioLinkRotationRow[] | null) ?? []
  return (
    rows.find(
      (r) => r.rotated_on_at <= clickAt && (r.rotated_off_at == null || clickAt <= r.rotated_off_at)
    ) ?? null
  )
}
