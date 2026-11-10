/**
 * Brief generation — the artefact that crosses the read → write plane boundary.
 *
 * WHAT A BRIEF IS (Phase 3 §3, §7.1):
 * A brief is a STRUCTURED FINDING, never an asset. It carries a format label,
 * a hook type, a sound *reference* (an id, not audio), and a *link* to the
 * inspiration (the `competitor_inspiration_id` FK — an id, never the file).
 * It must NEVER carry the competitor's video file, audio, verbatim script, or
 * verbatim on-screen text. Those are the cleanest substantial-similarity
 * evidence and the read plane must never hand them across the boundary.
 * `buildBrief` therefore *rejects* any input field that looks like an asset or
 * verbatim transcript (see `isForbiddenFieldKey`) — defence in depth, since the
 * row is also constructed field-by-field and never spread from the raw input.
 *
 * THE SOUND GATE IS APPLIED HERE, AT BUILD TIME (Phase 3 §7.3):
 * Business accounts may only publish music from TikTok's Commercial Music
 * Library (CML). A trend that depends on a non-CML sound is *unbuildable* on a
 * business account and must be flagged BEFORE anyone shoots the video — not
 * discovered at publish time. `owned_account.account_type` gates
 * `scheduled_post.sound_is_cml`; the migration comment on `owned_account`
 * (lines 191-194) states this verbatim. Using no music at all (original
 * voiceover) is allowed on a business account — the gate only fires for a
 * *selected* non-CML sound.
 *
 * PURITY: no DB, no network, no clock, no env. `buildBrief` takes a plain input
 * and returns the row for the app to persist plus an `errors` list. A brief
 * with any error stays `draft` and never reaches `ready`. There are NO external
 * API boundaries in this package, so there are no `// UNVERIFIED` shapes here;
 * the returned row is matched field-for-field against the *applied* `brief`
 * table in supabase/migrations/20260815000006_writeplane_publishing.sql.
 *
 * This package imports ONLY @goodfor/contracts (for the HookType enum), never
 * another write-plane package. Competitor-claim *substantiation* is enforced
 * downstream by @goodfor/compliance (`reviewCompetitorClaims`) and the DB gate,
 * NOT here — briefs carry claims through unchanged so a human queue can verify
 * them. See Phase 3 §7.5 / task 8.
 */

import { HOOK_TYPES, type HookType } from '@goodfor/contracts'

// ---------------------------------------------------------------------------
// Domain enums (mirror the applied migration's CHECK constraints)
// ---------------------------------------------------------------------------

/** `owned_account.account_type` / `brief.target_account_type`. */
export const ACCOUNT_TYPES = ['business', 'creator'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

/** `brief.status` CHECK values. A brief is born `draft`; only a clean build reaches `ready`. */
export const BRIEF_STATUSES = ['draft', 'ready', 'in_production', 'scheduled', 'rejected'] as const
export type BriefStatus = (typeof BRIEF_STATUSES)[number]

export const SOUND_GATE_ERROR =
  'sound unbuildable on this business account — needs Commercial Music Library'

// ---------------------------------------------------------------------------
// Input — the TS-facing API (camelCase). Deliberately NARROW: it carries only
// structured references, never the inspiration itself. The read plane extracts
// `competitorInspirationId` from the alert and hands over the id, not the alert
// blob — keeping any competitor asset on the far side of the boundary.
// ---------------------------------------------------------------------------

/**
 * A candidate sound is a *reference*, never the audio. `soundIsCml` is the only
 * fact the build-time gate needs. `soundId === null` means "no music selected"
 * (original voiceover) — permitted on any account type.
 */
export interface CandidateSound {
  soundId: string | null
  soundIsCml: boolean
}

export interface TargetAccount {
  accountType: AccountType
}

/**
 * A competitor claim carried into the brief for the human substantiation queue.
 * Substantiation ("£X vs £Y as at 2026-08-16", never "cheaper") is verified by
 * @goodfor/compliance downstream, NOT here — briefs pass it through verbatim.
 */
export interface CompetitorClaim {
  claim: string
  figure?: string | null
  asOfDate?: string | null
  verifiedBy?: string | null
}

export interface BuildBriefInput {
  appSlug: string
  /** FK to `tracked_video(id)` — the *link* to the inspiration, an id, never the file. */
  competitorInspirationId?: number | null
  /** Phase 2 format taxonomy cluster id. */
  formatClusterId?: number | null
  hookType: HookType
  targetAccount: TargetAccount
  sound: CandidateSound
  competitorClaims?: CompetitorClaim[]
}

// ---------------------------------------------------------------------------
// Output — the `brief` row (snake_case, matching the applied DB columns exactly
// so the app can persist it directly). `id` and `created_at` are DB-generated
// and intentionally omitted.
// ---------------------------------------------------------------------------

/** The jsonb shape stored in `brief.competitor_claims`: [{claim, figure, as_of_date, verified_by}]. */
export interface CompetitorClaimRow {
  claim: string
  figure: string | null
  as_of_date: string | null
  verified_by: string | null
}

export interface BriefRow {
  app_slug: string
  competitor_inspiration_id: number | null
  format_cluster_id: number | null
  hook_type: HookType | null
  target_account_type: AccountType
  sound_id: string | null
  sound_is_cml: boolean | null
  competitor_claims: CompetitorClaimRow[]
  status: BriefStatus
}

export interface BuildBriefResult {
  brief: BriefRow
  /** Empty iff the brief is buildable. Any entry keeps `status` at `draft`. */
  errors: string[]
}

// ---------------------------------------------------------------------------
// Plane-boundary field rejection
// ---------------------------------------------------------------------------

/**
 * Tokens that mark a field as a competitor *asset* or *verbatim* payload — the
 * things a brief must never carry across the boundary (§3, §7.1). Matched as
 * whole tokens after splitting the field name on camelCase and separators, so
 * `sound_id` / `soundIsCml` (references) pass while `videoAsset`, `audioBytes`,
 * `on_screen_text`, `transcript`, and `verbatimScript` are rejected.
 */
export const FORBIDDEN_FIELD_TOKENS: readonly string[] = [
  'transcript',
  'verbatim',
  'script',
  'asset',
  'waveform',
  'frame',
  'frames',
  'keyframe',
  'subtitle',
  'subtitles',
  'srt',
  'vtt',
  'ocr',
  'blob',
  'bytes',
  'mp4',
  'mp3',
  'wav',
  'mov',
  'webm',
  'thumbnail',
  'thumb',
  'spectrogram',
  'screenshot',
  'screengrab',
]

/** Compact multi-word markers checked against the separator-stripped field name. */
export const FORBIDDEN_FIELD_PHRASES: readonly string[] = [
  'onscreen',
  'keyframe', // catches keyframe / keyframes as a single lowercase token

  'videofile',
  'videourl',
  'videopath',
  'videodata',
  'videobytes',
  'videoasset',
  'audiofile',
  'audiourl',
  'audiopath',
  'audiodata',
  'audiobytes',
  'audioasset',
  'rawtext',
  'fulltext',
  'osttext',
  'verbatimtext',
]

function fieldTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .split(/[^a-zA-Z0-9]+/) // split snake_case / kebab / spaces
    .filter(Boolean)
    .map((t) => t.toLowerCase())
}

/**
 * True when a field name looks like a competitor asset or verbatim payload.
 * Token-based so `description`, `subscription`, `sound_id` etc. do not false-
 * positive on the `script` token.
 */
export function isForbiddenFieldKey(key: string): boolean {
  const tokens = fieldTokens(key)
  if (tokens.some((t) => FORBIDDEN_FIELD_TOKENS.includes(t))) return true
  const compact = tokens.join('')
  return FORBIDDEN_FIELD_PHRASES.some((p) => compact.includes(p))
}

/** Walk every object key in the input graph (depth-limited, arrays included). */
function* walkKeys(value: unknown, depth = 0): Generator<string> {
  if (depth > 6 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const el of value) yield* walkKeys(el, depth + 1)
    return
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    yield k
    yield* walkKeys(v, depth + 1)
  }
}

// ---------------------------------------------------------------------------
// buildBrief
// ---------------------------------------------------------------------------

function isValidHookType(v: unknown): v is HookType {
  return typeof v === 'string' && (HOOK_TYPES as readonly string[]).includes(v)
}

function normaliseClaim(c: CompetitorClaim): CompetitorClaimRow {
  return {
    claim: c.claim,
    figure: c.figure ?? null,
    as_of_date: c.asOfDate ?? null,
    verified_by: c.verifiedBy ?? null,
  }
}

/**
 * Build a `brief` row from a structured finding, PURELY.
 *
 * Gates applied here, at build time:
 *  - plane boundary: reject any asset/verbatim-looking input field (§3);
 *  - sound gate: a business account cannot select a non-CML sound (§7.3);
 *  - shape: `app_slug`, `account_type`, and a *committed* `hook_type` are
 *    required (a brief must pick a proven hook, not guess — Phase 2).
 *
 * Any error keeps `status` at `draft`; a clean build reaches `ready`.
 * Throws only on a programmer-error nullish input.
 */
export function buildBrief(input: BuildBriefInput): BuildBriefResult {
  if (input == null || typeof input !== 'object') {
    throw new TypeError('buildBrief: input is required')
  }

  const errors: string[] = []

  // 1. Plane-boundary rejection — loud, even though the row is built field-by-
  //    field and would never persist an unknown key anyway.
  const flagged = new Set<string>()
  for (const key of walkKeys(input)) {
    if (isForbiddenFieldKey(key) && !flagged.has(key)) {
      flagged.add(key)
      errors.push(
        `plane boundary violation: input field "${key}" looks like a competitor asset ` +
          `or verbatim text — a brief carries a format label, hook type, sound reference, ` +
          `and link only, never the competitor's video/audio/script/on-screen text (§3)`
      )
    }
  }

  // 2. Shape validation.
  const appSlug = typeof input.appSlug === 'string' ? input.appSlug.trim() : ''
  if (appSlug === '') errors.push('app_slug is required')

  const accountType = input.targetAccount?.accountType
  const accountTypeValid = (ACCOUNT_TYPES as readonly string[]).includes(accountType as string)
  if (!accountTypeValid) {
    errors.push(`target account_type must be one of ${ACCOUNT_TYPES.join(' | ')}`)
  }

  const hookValid = isValidHookType(input.hookType)
  if (!hookValid) {
    errors.push(`hook_type "${String(input.hookType)}" is not a recognised HookType`)
  } else if (input.hookType === 'unknown') {
    errors.push("hook_type is 'unknown' — a brief must commit to a proven hook, not a guess (Phase 2)")
  }

  const sound = input.sound ?? { soundId: null, soundIsCml: false }
  const soundId = sound.soundId ?? null
  const soundIsCml = sound.soundIsCml === true

  // 3. THE SOUND GATE (§7.3). Only fires for a *selected* non-CML sound on a
  //    business account; no music (soundId === null) is allowed everywhere.
  if (accountType === 'business' && soundId !== null && !soundIsCml) {
    errors.push(SOUND_GATE_ERROR)
  }

  // 4. Carry competitor claims through unchanged (substantiation is compliance's
  //    job). A claim must at minimum have a non-empty label.
  const rawClaims = input.competitorClaims ?? []
  if (!Array.isArray(rawClaims)) {
    errors.push('competitor_claims must be an array')
  }
  const claimRows: CompetitorClaimRow[] = []
  if (Array.isArray(rawClaims)) {
    for (const c of rawClaims) {
      if (c == null || typeof c !== 'object' || typeof c.claim !== 'string' || c.claim.trim() === '') {
        errors.push('each competitor claim requires a non-empty "claim" label')
        continue
      }
      claimRows.push(normaliseClaim(c))
    }
  }

  const status: BriefStatus = errors.length === 0 ? 'ready' : 'draft'

  const brief: BriefRow = {
    app_slug: appSlug,
    competitor_inspiration_id: input.competitorInspirationId ?? null,
    format_cluster_id: input.formatClusterId ?? null,
    hook_type: hookValid ? input.hookType : null,
    // Kept as-provided for debuggability; the DB CHECK is the backstop if invalid.
    target_account_type: accountType as AccountType,
    sound_id: soundId,
    sound_is_cml: sound.soundIsCml ?? null,
    competitor_claims: claimRows,
    status,
  }

  return { brief, errors }
}
