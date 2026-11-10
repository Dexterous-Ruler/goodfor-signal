import { describe, it, expect } from 'vitest'
import {
  buildBrief,
  isForbiddenFieldKey,
  SOUND_GATE_ERROR,
  ACCOUNT_TYPES,
  BRIEF_STATUSES,
  type BuildBriefInput,
} from './index.js'

/** A valid, buildable base input. Individual tests override one field. */
function base(overrides: Partial<BuildBriefInput> = {}): BuildBriefInput {
  return {
    appSlug: 'goodfor',
    competitorInspirationId: 4242,
    formatClusterId: 7,
    hookType: 'question',
    targetAccount: { accountType: 'creator' },
    sound: { soundId: 'sound_123', soundIsCml: false },
    ...overrides,
  }
}

describe('sound gate at build time (§7.3)', () => {
  it('business + non-CML sound => error and status stays draft', () => {
    const { brief, errors } = buildBrief(
      base({ targetAccount: { accountType: 'business' }, sound: { soundId: 's1', soundIsCml: false } })
    )
    expect(errors).toContain(SOUND_GATE_ERROR)
    expect(brief.status).toBe('draft')
    // The sound is still carried into the row so the human sees WHY it's unbuildable.
    expect(brief.sound_id).toBe('s1')
    expect(brief.sound_is_cml).toBe(false)
    expect(brief.target_account_type).toBe('business')
  })

  it('business + CML sound => ok (ready, no errors)', () => {
    const { brief, errors } = buildBrief(
      base({ targetAccount: { accountType: 'business' }, sound: { soundId: 's1', soundIsCml: true } })
    )
    expect(errors).toEqual([])
    expect(brief.status).toBe('ready')
    expect(brief.sound_is_cml).toBe(true)
  })

  it('creator + trending (non-CML) sound => ok (ready)', () => {
    const { brief, errors } = buildBrief(
      base({ targetAccount: { accountType: 'creator' }, sound: { soundId: 'trend_9', soundIsCml: false } })
    )
    expect(errors).toEqual([])
    expect(brief.status).toBe('ready')
  })

  it('business + NO sound (original voiceover) => ok — the gate only fires for a selected non-CML sound', () => {
    const { brief, errors } = buildBrief(
      base({ targetAccount: { accountType: 'business' }, sound: { soundId: null, soundIsCml: false } })
    )
    expect(errors).toEqual([])
    expect(brief.status).toBe('ready')
    expect(brief.sound_id).toBeNull()
  })
})

describe('competitor claims are carried through (substantiation is compliance\'s job)', () => {
  it('a populated claim is mapped into the jsonb row shape', () => {
    const { brief, errors } = buildBrief(
      base({
        competitorClaims: [
          { claim: 'we index 3x more sounds', figure: '3x vs 1x', asOfDate: '2026-08-16', verifiedBy: 'karim' },
        ],
      })
    )
    expect(errors).toEqual([])
    expect(brief.competitor_claims).toEqual([
      { claim: 'we index 3x more sounds', figure: '3x vs 1x', as_of_date: '2026-08-16', verified_by: 'karim' },
    ])
  })

  it('an unsubstantiated claim is still carried through — briefs do NOT gate on substantiation', () => {
    // "never 'cheaper'" enforcement lives in @goodfor/compliance, not here.
    const { brief, errors } = buildBrief(base({ competitorClaims: [{ claim: 'cheaper' }] }))
    expect(errors).toEqual([])
    expect(brief.status).toBe('ready')
    expect(brief.competitor_claims).toEqual([
      { claim: 'cheaper', figure: null, as_of_date: null, verified_by: null },
    ])
  })

  it('defaults competitor_claims to [] when absent', () => {
    const { brief } = buildBrief(base({ competitorClaims: undefined }))
    expect(brief.competitor_claims).toEqual([])
  })

  it('rejects a claim with no label', () => {
    const { errors, brief } = buildBrief(base({ competitorClaims: [{ claim: '  ' }] }))
    expect(errors.some((e) => e.includes('non-empty "claim"'))).toBe(true)
    expect(brief.status).toBe('draft')
  })
})

describe('plane-boundary field rejection (§3)', () => {
  it('rejects a verbatim on-screen-text field smuggled into the input', () => {
    const input = { ...base(), on_screen_text: 'BUY NOW BEFORE ITS GONE' } as unknown as BuildBriefInput
    const { errors, brief } = buildBrief(input)
    expect(errors.some((e) => e.includes('on_screen_text') && e.includes('plane boundary'))).toBe(true)
    expect(brief.status).toBe('draft')
  })

  it('rejects a competitor video asset field', () => {
    const input = { ...base(), videoAssetUrl: 'https://cdn/competitor.mp4' } as unknown as BuildBriefInput
    const { errors } = buildBrief(input)
    expect(errors.some((e) => e.includes('videoAssetUrl'))).toBe(true)
  })

  it('rejects a verbatim script nested inside a claim', () => {
    const input = {
      ...base(),
      competitorClaims: [{ claim: 'x', verbatimScript: 'line 1\nline 2' }],
    } as unknown as BuildBriefInput
    const { errors } = buildBrief(input)
    expect(errors.some((e) => e.includes('verbatimScript'))).toBe(true)
  })

  it('does NOT reject legitimate reference fields', () => {
    // sound_id / soundIsCml / competitor_inspiration_id are references, not assets.
    for (const k of ['soundId', 'soundIsCml', 'competitorInspirationId', 'appSlug', 'hookType', 'formatClusterId', 'description', 'subscriptionId']) {
      expect(isForbiddenFieldKey(k)).toBe(false)
    }
  })

  it('flags the obvious asset/verbatim markers', () => {
    for (const k of ['transcript', 'videoUrl', 'audio_bytes', 'onScreenText', 'srtFile', 'keyframes', 'competitorScript']) {
      expect(isForbiddenFieldKey(k)).toBe(true)
    }
  })
})

describe('shape validation', () => {
  it('requires app_slug', () => {
    const { errors, brief } = buildBrief(base({ appSlug: '' }))
    expect(errors).toContain('app_slug is required')
    expect(brief.status).toBe('draft')
  })

  it('rejects an unrecognised hook_type and nulls it in the row', () => {
    const { errors, brief } = buildBrief(base({ hookType: 'made_up' as never }))
    expect(errors.some((e) => e.includes('not a recognised HookType'))).toBe(true)
    expect(brief.hook_type).toBeNull()
    expect(brief.status).toBe('draft')
  })

  it("treats hook_type 'unknown' as uncommitted — must pick a proven hook", () => {
    const { errors, brief } = buildBrief(base({ hookType: 'unknown' }))
    expect(errors.some((e) => e.includes("hook_type is 'unknown'"))).toBe(true)
    expect(brief.status).toBe('draft')
  })

  it('rejects an invalid account_type', () => {
    const { errors } = buildBrief(base({ targetAccount: { accountType: 'brand' as never } }))
    expect(errors.some((e) => e.includes('account_type must be'))).toBe(true)
  })

  it('throws on nullish input (programmer error)', () => {
    expect(() => buildBrief(undefined as never)).toThrow(/input is required/)
  })
})

describe('row shape matches the applied brief table columns', () => {
  it('produces exactly the app-controlled columns, no id/created_at', () => {
    const { brief } = buildBrief(base({ targetAccount: { accountType: 'business' }, sound: { soundId: 's', soundIsCml: true } }))
    expect(Object.keys(brief).sort()).toEqual(
      [
        'app_slug',
        'competitor_claims',
        'competitor_inspiration_id',
        'format_cluster_id',
        'hook_type',
        'sound_id',
        'sound_is_cml',
        'status',
        'target_account_type',
      ].sort()
    )
  })

  it('status is always a valid brief.status CHECK value', () => {
    const { brief } = buildBrief(base())
    expect(BRIEF_STATUSES).toContain(brief.status)
  })

  it('exposes the account-type enum matching the DB CHECK', () => {
    expect([...ACCOUNT_TYPES]).toEqual(['business', 'creator'])
  })
})
