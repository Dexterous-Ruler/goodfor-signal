/**
 * The compliance gate — PURE-FUNCTION layer.
 *
 * This is the app-side validator for the non-bypassable disclosure gate. The
 * DB-level enforcement (the `enforce_disclosure_gate()` trigger on
 * `scheduled_post`) lives in the migration and is the ACTUAL guarantee — app
 * bugs cannot route around it. These functions are the earlier, friendlier
 * layer: they let briefs/production/console surface a failure BEFORE a row ever
 * tries to leave `draft`, and they encode the exact legal rules the trigger
 * only approximates.
 *
 * Grounding: docs/phases/PHASE-3-act-publishing.md §Week-12 (tasks 5–9) and
 * completion.md §7 (Replication engine and legal guardrails).
 *
 * FOUR checks, matching the four gate concerns (Phase-3 task 5):
 *   (a) validateDisclosure        — the region-aware disclosure artefact (§7.6)
 *   (b) checkSoundVsAccountType   — sound licensing vs account_type       (§7.3)
 *   (c) reviewCompetitorClaims    — dated substantiation for named rivals (§7.5)
 *   (d) checkAigcRealism          — AIGC labelling; trigger is REALISM    (§7.4)
 *
 * PURITY: no I/O, no DB, no network, no clock reads. Everything a check needs
 * is passed in. That is what makes the gate testable without live creds and
 * what lets the DB trigger, not this code, be the load-bearing control.
 *
 * VERIFICATION POSTURE: TikTok's [VERIFIED] rules (the realism trigger, the
 * ASA acceptable-label list, the CML) are encoded as-is. Figures and windows
 * that completion.md marks [SINGLE-SOURCE] or [VENDOR] (the CMA/DMCCA turnover
 * cap, the EU AI Act Art. 50 penalties, the 24h appeal window) are flagged
 * `// UNVERIFIED` at the point of use — same posture as the read plane's
 * mapEnsembleVideo(). None of these numbers gate the logic; they only populate
 * the human-readable `reasons`.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Matches `owned_account.account_type` (CHECK 'business' | 'creator'). */
export type AccountType = 'business' | 'creator'

/** Matches `scheduled_post.disclosure_type` (CHECK 'none' | 'your_brand' | 'branded_content'). */
export type DisclosureType = 'none' | 'your_brand' | 'branded_content'

/**
 * The disclosure regime is chosen from the target region. Known regions map to
 * a named regulator; anything else (including a missing region) falls to the
 * strictest posture — "UK-standard creative by default" (§7.6).
 */
export type DisclosureRegion = 'US' | 'USA' | 'UK' | 'GB' | 'EU' | 'EEA' | (string & {})

type Regime = 'FTC' | 'ASA' | 'STRICT'

// ---------------------------------------------------------------------------
// Statutory stakes (populated into `reasons` only — never gate the logic)
// ---------------------------------------------------------------------------

/** 16 CFR Part 465 max civil penalty, PER VIOLATION (== per post). [VERIFIED figure] */
export const FTC_MAX_PENALTY_USD = 53_088
/** DMCCA 2024 — CMA can fine directly, up to this share of GLOBAL turnover. */
// UNVERIFIED (completion.md §7.6 marks the DMCCA/CMA cap [SINGLE-SOURCE]).
export const CMA_MAX_TURNOVER_PCT = 10
/** DMCCA 2024 cash alternative to the turnover cap (whichever is higher). */
// UNVERIFIED (§7.6 [SINGLE-SOURCE]).
export const CMA_MAX_PENALTY_GBP = 300_000
/** EU AI Act Art. 50 deployer marking-duty penalty ceiling. */
// UNVERIFIED (completion.md §7.4 marks Art. 50 penalties [SINGLE-SOURCE]).
export const EU_AI_ACT_MAX_TURNOVER_PCT = 3

const FTC_STAKE = `FTC 16 CFR Part 465 exposure is up to $${FTC_MAX_PENALTY_USD.toLocaleString('en-US')} per violation, counted per post`
const ASA_STAKE = `the ASA cannot fine, but the CMA can directly (DMCCA 2024) up to ${CMA_MAX_TURNOVER_PCT}% of global turnover or £${CMA_MAX_PENALTY_GBP.toLocaleString('en-GB')}, whichever is higher`

// ---------------------------------------------------------------------------
// (a) Disclosure artefact — validateDisclosure
// ---------------------------------------------------------------------------

/**
 * What the gate needs to see about a post to judge its disclosure. Deliberately
 * NOT the whole `scheduled_post` row — just the three axes of the single
 * compliant artefact plus the promotional flag.
 */
export interface DisclosablePost {
  /**
   * Which TikTok in-app toggle applies. 'none' == organic content with no
   * disclosure duty; 'your_brand' == Goodfor promoting Goodfor; 'branded_content'
   * == a paid creator. Anything other than 'none' is promotional and must clear
   * the artefact.
   */
  disclosureType: DisclosureType
  /** The caption exactly as it will be posted (leading vs trailing #ad matters). */
  caption: string
  /**
   * Text burned into the FIRST frame of the video, if any (e.g. "Ad"). null when
   * nothing is burned in. NOTE: the render pipeline may burn in a disclosure
   * label but must NEVER superimpose a CTA / link / other promotional text (§7.6).
   */
  firstFrameDisclosure?: string | null
  /** True when an audible spoken disclosure is present in the first frames. */
  spokenDisclosure?: boolean
}

export interface DisclosureResult {
  ok: boolean
  /** Human-readable failure reasons, each naming the relevant statutory stake. */
  reasons: string[]
}

// The ONLY acceptable ASA/CAP labels (§7.6) — normalised, lower-cased.
const ASA_LABELS = new Set(['ad', 'advert', 'advertising', 'ad feature', 'advertisement feature'])
// Explicitly inadequate under the ASA — the classic trap is "Sponsored" (§7.6).
const ASA_INADEQUATE = new Set(['sponsored', 'gifted', 'in association with', 'aff', 'sp'])
// FTC is broader: it accepts "Sponsored"/"Paid partnership" as clear labels.
const FTC_EXTRA_LABELS = new Set(['sponsored', 'paid partnership', 'paid promotion', 'paid ad'])

// Hashtag equivalents (no spaces, no '#').
const ASA_AD_TAGS = new Set(['ad', 'advert', 'advertising', 'adfeature', 'advertisementfeature'])
const FTC_EXTRA_TAGS = new Set(['sponsored', 'paidpartnership', 'paidpromotion'])

const HASHTAG_RE = /#([\p{L}\p{N}_]+)/gu
const LEADING_HASHTAG_RE = /^\s*#([\p{L}\p{N}_]+)/u

function normaliseLabel(s: string | null | undefined): string | null {
  if (s == null) return null
  const t = String(s).replace(/\s+/g, ' ').trim().toLowerCase()
  return t.length ? t : null
}

function captionTags(caption: string): { tags: string[]; leadTag: string | null } {
  const tags = [...caption.matchAll(HASHTAG_RE)].map((m) => (m[1] ?? '').toLowerCase())
  const lead = LEADING_HASHTAG_RE.exec(caption)
  const leadTag = lead ? (lead[1] ?? '').toLowerCase() : null
  return { tags, leadTag }
}

function regimeForRegion(region: DisclosureRegion | null | undefined): Regime {
  const r = String(region ?? '').trim().toUpperCase()
  if (r === 'US' || r === 'USA') return 'FTC'
  if (r === 'UK' || r === 'GB') return 'ASA'
  // EU/EEA and every unknown/missing region default to the strictest posture:
  // require the full single compliant artefact (§7.6, "UK-standard by default").
  return 'STRICT'
}

/**
 * Validate a post's disclosure against a region's regime.
 *
 * The single compliant artefact (§7.6) is: burned-in **"Ad"** in the first
 * frame + a spoken disclosure + **"#ad" LEADING** the caption. That artefact
 * clears every regime. The region only changes which weaker forms slip through
 * and which statute is named in the reasons:
 *
 *   - FTC (US): a clear, conspicuous label is enough. "Sponsored" burned into
 *     the first frame PASSES. A hashtag sitting only at the END of the caption
 *     is not conspicuous and FAILS.
 *   - ASA (UK): only "Ad"/"Advert"/"Advertising"/"Ad Feature"/"Advertisement
 *     Feature", visible BEFORE engagement. "Sponsored" FAILS; a trailing #ad
 *     (behind "See more") FAILS.
 *   - STRICT (EU / unknown / missing region): require the whole artefact.
 *
 * A `disclosureType` of 'none' is organic content — no duty, always ok.
 */
export function validateDisclosure(
  post: DisclosablePost,
  region: DisclosureRegion | null | undefined
): DisclosureResult {
  const disclosureType = post.disclosureType ?? 'none'
  // Organic content carries no disclosure duty.
  if (disclosureType === 'none') return { ok: true, reasons: [] }

  const reasons: string[] = []
  const regime = regimeForRegion(region)

  // The DB gate rejects a promotional post with a null region; mirror that here
  // so the failure surfaces at brief/console time, not at the trigger.
  if (!String(region ?? '').trim()) {
    reasons.push(
      'disclosure_region is required on a promotional post — the non-bypassable DB gate ' +
        'rejects a null region, so defaulting to the strictest (UK-standard) regime.'
    )
  }

  const label = normaliseLabel(post.firstFrameDisclosure)
  const { tags, leadTag } = captionTags(post.caption ?? '')

  const firstFrameAsaLabel = label !== null && ASA_LABELS.has(label)
  const firstFrameFtcLabel = label !== null && (ASA_LABELS.has(label) || FTC_EXTRA_LABELS.has(label))
  const firstFrameInadequate = label !== null && ASA_INADEQUATE.has(label)

  const leadingAsaAdTag = leadTag !== null && ASA_AD_TAGS.has(leadTag)
  const anyAsaAdTag = tags.some((t) => ASA_AD_TAGS.has(t))
  const leadingFtcAdTag =
    leadTag !== null && (ASA_AD_TAGS.has(leadTag) || FTC_EXTRA_TAGS.has(leadTag))
  const anyFtcAdTag = tags.some((t) => ASA_AD_TAGS.has(t) || FTC_EXTRA_TAGS.has(t))

  const spoken = post.spokenDisclosure === true

  if (regime === 'FTC') {
    const conspicuous = firstFrameFtcLabel || leadingFtcAdTag
    if (!conspicuous) {
      if (anyFtcAdTag) {
        // Present, but only at the tail of the caption — hidden behind "See more".
        reasons.push(
          `disclosure is not clear and conspicuous: the ad label sits at the end of the caption behind "See more". ${FTC_STAKE}.`
        )
      } else {
        reasons.push(
          `no clear and conspicuous disclosure (need "Ad" in the first frame or a leading "#ad"). ${FTC_STAKE}.`
        )
      }
    }
  } else if (regime === 'ASA') {
    const acceptable = firstFrameAsaLabel || leadingAsaAdTag
    if (!acceptable) {
      if (firstFrameInadequate) {
        // The canonical trap: "Sponsored" clears the FTC but is not an
        // acceptable ASA/CAP label.
        reasons.push(
          `"${label}" is not an acceptable ASA/CAP label — only "Ad", "Advert", "Advertising", "Ad Feature", "Advertisement Feature" qualify; ${ASA_STAKE}.` // UNVERIFIED (CMA cap [SINGLE-SOURCE])
        )
      } else if (anyAsaAdTag) {
        // #ad exists but not leading → behind "See more" → invisible before engagement.
        reasons.push(
          `the "#ad" hashtag is not leading the caption — it sits behind "See more" and is invisible before engagement, which fails the ASA; ${ASA_STAKE}.` // UNVERIFIED (CMA cap [SINGLE-SOURCE])
        )
      } else {
        reasons.push(
          `no acceptable ASA disclosure (need "Ad" burned into the first frame or leading the caption); ${ASA_STAKE}.` // UNVERIFIED (CMA cap [SINGLE-SOURCE])
        )
      }
    }
  } else {
    // STRICT — demand the entire single compliant artefact (§7.6).
    if (!firstFrameAsaLabel) {
      if (firstFrameInadequate) {
        reasons.push(
          `first-frame label "${label}" is not an acceptable disclosure — burn in "Ad" (not "${label}") in the first frame; ${ASA_STAKE}.` // UNVERIFIED (CMA cap [SINGLE-SOURCE])
        )
      } else {
        reasons.push(
          `no burned-in "Ad" in the first frame — the single compliant artefact requires it; ${FTC_STAKE}; ${ASA_STAKE}.` // UNVERIFIED (CMA cap [SINGLE-SOURCE])
        )
      }
    }
    if (!spoken) {
      reasons.push('no spoken disclosure — the single compliant artefact requires an audible disclosure.')
    }
    if (!leadingAsaAdTag) {
      if (anyAsaAdTag) {
        reasons.push(
          `"#ad" is present but not leading the caption — it must lead, or it sits behind "See more"; ${ASA_STAKE}.` // UNVERIFIED (CMA cap [SINGLE-SOURCE])
        )
      } else {
        reasons.push('the caption does not lead with "#ad" — the single compliant artefact requires it.')
      }
    }
  }

  return { ok: reasons.length === 0, reasons }
}

// ---------------------------------------------------------------------------
// (b) Sound vs account type — checkSoundVsAccountType
// ---------------------------------------------------------------------------

export interface SoundCheckResult {
  ok: boolean
  reason: string
}

/**
 * Gate a sound choice against the account's type (§7.3). This is enforced at
 * BRIEF time (in @goodfor/briefs) so a trend that depends on a non-commercial
 * sound is flagged unbuildable on a Business handle before anyone shoots.
 *
 *   - Business account: MUST use a Commercial Music Library sound
 *     (`sound_is_cml === true`). The CML is mandatory for Business accounts; a
 *     non-CML trending sound risks muting/removal/ad rejection/restrictions.
 *   - Creator account: may use trending (non-CML) sounds, BUT cannot publish
 *     via API — the draft/inbox path still applies and a human taps publish.
 *
 * `soundIsCml` is treated strictly: only an explicit `true` clears a Business
 * account. `false`/`null`/`undefined` (unknown provenance) is unbuildable there.
 */
export function checkSoundVsAccountType(
  accountType: AccountType,
  soundIsCml: boolean | null | undefined
): SoundCheckResult {
  if (accountType === 'business') {
    if (soundIsCml === true) {
      return {
        ok: true,
        reason: 'Business account using a Commercial Music Library sound — permitted (§7.3).',
      }
    }
    return {
      ok: false,
      reason:
        'Unbuildable on this account: a Business account may only publish with Commercial Music ' +
        'Library sounds (sound_is_cml must be true). This depends on a non-CML sound and cannot be ' +
        'executed on a Business handle — flagged at brief time, before anyone shoots the video (§7.3).',
    }
  }
  // Creator account — any sound is fine for licensing, but publishing is not via API.
  return {
    ok: true,
    reason:
      'Creator account may use trending (non-CML) sounds, but note it cannot publish via API — ' +
      'API publishing is Business-only, so this still runs through the draft/inbox path (§7.3).',
  }
}

// ---------------------------------------------------------------------------
// (c) Competitor claims — reviewCompetitorClaims
// ---------------------------------------------------------------------------

/** One row of `brief.competitor_claims` jsonb: {claim, figure, as_of_date, verified_by}. */
export interface CompetitorClaim {
  /** The claim text, e.g. "Goodfor is cheaper than Rival". */
  claim: string
  /** The dated substantiation figure, e.g. "£5/mo vs £8/mo as at 2026-08-16". */
  figure?: string | null
  /** ISO date the figure was captured (alternative place to carry the date). */
  asOfDate?: string | null
  /** Who signed off in the human review queue. */
  verifiedBy?: string | null
}

export interface UnsubstantiatedClaim {
  claim: string
  reason: string
}

export interface ClaimReviewResult {
  ok: boolean
  unsubstantiated: UnsubstantiatedClaim[]
}

// Bare comparatives that must never stand without a dated figure (§7.5).
const VAGUE_COMPARATIVES = [
  'cheaper',
  'cheapest',
  'better',
  'best',
  'faster',
  'fastest',
  'superior',
  'more affordable',
  'best value',
  'number one',
  '#1',
]

function hasDate(s: string): boolean {
  if (/\d{4}-\d{2}-\d{2}/.test(s)) return true // ISO 2026-08-16
  if (/\b\d{1,2}\s+[a-z]+\s+\d{4}\b/i.test(s)) return true // 6 August 2026
  if (/\bas\s+(at|of)\b/i.test(s) && /\d{4}/.test(s)) return true // "as at ... 2026"
  return false
}

/**
 * Strip date tokens so the numeric-quantity check is not fooled by the digits
 * in a date. "a lot more as at 2026-08-16" has digits but no QUANTITY being
 * compared, and must still fail as unsubstantiated.
 */
function stripDates(s: string): string {
  return s
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ') // ISO 2026-08-16
    .replace(/\b\d{1,2}\s+[a-z]+\s+\d{4}\b/gi, ' ') // 6 August 2026
    .replace(/\bas\s+(?:at|of)\s+\d{4}\b/gi, ' ') // as at 2026
}

function isValidDate(d: string | null | undefined): boolean {
  if (!d || !String(d).trim()) return false
  return !Number.isNaN(Date.parse(String(d)))
}

/** Returns a defect string if the claim is unsubstantiated, else null. */
function claimDefect(c: CompetitorClaim): string | null {
  const text = (c.claim ?? '').trim()
  if (!text) return 'empty claim text.'

  const figure = (c.figure ?? '').trim()
  const vague = VAGUE_COMPARATIVES.find((w) => text.toLowerCase().includes(w))

  if (!figure) {
    return vague
      ? `comparative claim ("${vague}") with no substantiation figure — needs a dated figure like "£X vs £Y as at 2026-08-16", never a bare "${vague}" (§7.5).`
      : 'no substantiation figure — every competitor claim needs a dated figure like "£X vs £Y as at 2026-08-16" (§7.5).'
  }
  if (!/\d/.test(stripDates(figure))) {
    return `substantiation figure "${figure}" carries no numeric quantity (only a date) — needs "£X vs £Y as at <date>" (§7.5).`
  }
  if (!(hasDate(figure) || isValidDate(c.asOfDate))) {
    return `substantiation figure "${figure}" is undated — every competitor claim needs an as-at date (§7.5).`
  }
  if (!((c.verifiedBy ?? '').trim())) {
    return 'claim has a dated figure but no verified_by — a human reviewer must sign off before the brief can reach "ready" (§7.5).'
  }
  return null
}

/**
 * Review a brief's competitor claims (§7.5). Any script that names a competitor
 * routes to a human queue where each claim carries a per-claim dated
 * substantiation figure. A claim clears only when it has a numeric, DATED figure
 * AND a human `verifiedBy` sign-off. No brief with an unsubstantiated competitor
 * claim can reach `ready`.
 */
export function reviewCompetitorClaims(claims: readonly CompetitorClaim[]): ClaimReviewResult {
  const unsubstantiated: UnsubstantiatedClaim[] = []
  for (const c of claims) {
    const reason = claimDefect(c)
    if (reason) unsubstantiated.push({ claim: (c.claim ?? '').trim(), reason })
  }
  return { ok: unsubstantiated.length === 0, unsubstantiated }
}

// ---------------------------------------------------------------------------
// (d) AIGC realism labelling — checkAigcRealism
// ---------------------------------------------------------------------------

/** TikTok's explicit safe-harbour edit kinds — none of these require a label. */
export type AigcSafeHarbour =
  | 'color_correction'
  | 'reframing'
  | 'cropping'
  | 'artistic_style' // e.g. anime — stylised, not realistic
  | 'none'

/**
 * What the AIGC check needs about a piece of content. The TRIGGER is realism,
 * NOT AI usage: anime made entirely by AI needs no label; a significantly edited
 * realistic scene does, AI or not.
 */
export interface AigcContent {
  /** Were AI tools used to generate/alter the footage? Not sufficient on its own. */
  aiGenerated?: boolean
  /** Edited heavily, beyond the safe harbours below. */
  significantlyEdited?: boolean
  /** THE TRIGGER: does the content show realistic-looking scenes or people? */
  depictsRealisticSceneOrPerson: boolean
  /** If the ONLY manipulation is one safe-harbour kind, no label is due. */
  safeHarbour?: AigcSafeHarbour
  /** Target region; 'EU'/'EEA' pulls in the AI Act Art. 50 marking duty. */
  targetRegion?: DisclosureRegion
}

export interface AigcResult {
  mustLabel: boolean
  reason: string
}

function targetsEu(region: DisclosureRegion | null | undefined): boolean {
  const r = String(region ?? '').trim().toUpperCase()
  return r === 'EU' || r === 'EEA'
}

/**
 * Decide whether content must carry an AIGC label (§7.4).
 *
 * TikTok's rule: label AI-generated or significantly edited content that shows
 * "realistic-looking scenes or people" [VERIFIED]. Safe harbours are explicit:
 * colour correction, reframing, cropping, and artistic styles (anime) need no
 * label. The trigger is REALISM, not AI usage.
 *
 * For EU/EEA targets, a required label also implies the EU AI Act Art. 50
 * INDEPENDENT machine-readable marking duty on the deployer — the TikTok toggle
 * alone may not discharge it, and Art. 50 reaches even "artificially generated
 * product shots".
 *
 * This function NEVER emits, suggests, or depends on any watermark-stripping
 * step — invisible C2PA/TikTok watermarks are readable by TikTok and stripping
 * them is out of the question (§7.4).
 */
export function checkAigcRealism(content: AigcContent): AigcResult {
  const realistic = content.depictsRealisticSceneOrPerson === true
  const aiGenerated = content.aiGenerated === true
  const significantlyEdited = content.significantlyEdited === true
  const harbour = content.safeHarbour && content.safeHarbour !== 'none' ? content.safeHarbour : null

  // Not realistic → no duty, whatever the AI involvement (the trigger is realism).
  if (!realistic) {
    return {
      mustLabel: false,
      reason:
        'No labelling duty: the content does not depict realistic-looking scenes or people. ' +
        'The trigger is realism, not AI usage (§7.4).',
    }
  }

  // Realistic, but the only manipulation is a safe-harbour edit (and not AI
  // generation) → no label. AI generation is never a safe harbour.
  if (harbour && !aiGenerated) {
    return {
      mustLabel: false,
      reason: `No labelling duty: the only manipulation is a safe-harbour edit (${harbour}), which TikTok exempts even on realistic footage (§7.4).`,
    }
  }

  // Realistic AND (AI-generated OR significantly edited) → must label.
  if (aiGenerated || significantlyEdited) {
    const base =
      'Must label: realistic-looking scenes or people that are ' +
      (aiGenerated ? 'AI-generated' : 'significantly edited') +
      ' — set TikTok\'s AIGC toggle (§7.4).'
    if (targetsEu(content.targetRegion)) {
      return {
        mustLabel: true,
        reason:
          base +
          ` EU/EEA target: the EU AI Act Art. 50 imposes an INDEPENDENT machine-readable marking duty on the deployer (the TikTok toggle alone may not discharge it; exposure up to €15m or ${EU_AI_ACT_MAX_TURNOVER_PCT}% of worldwide turnover). Never strip watermarks.`, // UNVERIFIED (Art. 50 penalties [SINGLE-SOURCE])
      }
    }
    return { mustLabel: true, reason: base }
  }

  // Realistic but genuine, unedited footage of real people → not AIGC.
  return {
    mustLabel: false,
    reason:
      'No labelling duty: genuine, unedited footage of a real scene or person is not ' +
      'AI-generated or significantly edited content (§7.4).',
  }
}
