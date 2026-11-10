import { describe, it, expect } from 'vitest'
import {
  validateDisclosure,
  checkSoundVsAccountType,
  reviewCompetitorClaims,
  checkAigcRealism,
  type DisclosablePost,
  type CompetitorClaim,
} from './index.js'

// The single compliant artefact (§7.6): "Ad" first frame + spoken + leading "#ad".
const compliant: DisclosablePost = {
  disclosureType: 'branded_content',
  caption: '#ad this actually changed how I edit — link in bio',
  firstFrameDisclosure: 'Ad',
  spokenDisclosure: true,
}

describe('validateDisclosure', () => {
  it('passes the single compliant artefact in every regime', () => {
    for (const region of ['US', 'UK', 'EU', 'ZZ'] as const) {
      const r = validateDisclosure(compliant, region)
      expect(r.ok, `region=${region} reasons=${r.reasons.join(' | ')}`).toBe(true)
      expect(r.reasons).toEqual([])
    }
  })

  it('treats organic content (disclosure_type none) as always ok', () => {
    const r = validateDisclosure(
      { disclosureType: 'none', caption: 'no ad here, just vibes' },
      // even with no region, organic content has no duty
      null
    )
    expect(r.ok).toBe(true)
    expect(r.reasons).toEqual([])
  })

  it('"Sponsored" passes the FTC but FAILS the ASA — the region pivot', () => {
    const post: DisclosablePost = {
      disclosureType: 'branded_content',
      caption: 'check it out', // no #ad tag — isolate the label
      firstFrameDisclosure: 'Sponsored',
      spokenDisclosure: true,
    }
    const us = validateDisclosure(post, 'US')
    expect(us.ok).toBe(true)

    const uk = validateDisclosure(post, 'UK')
    expect(uk.ok).toBe(false)
    expect(uk.reasons.join(' ')).toMatch(/not an acceptable ASA/i)
    // Names the CMA/turnover stake.
    expect(uk.reasons.join(' ')).toMatch(/turnover/i)
  })

  it('fails a trailing hashtag — hidden behind "See more" — in both US and UK', () => {
    const post: DisclosablePost = {
      disclosureType: 'branded_content',
      caption: 'this app is unreal, you have to try it #fyp #ad',
      firstFrameDisclosure: null,
      spokenDisclosure: true,
    }
    const uk = validateDisclosure(post, 'UK')
    expect(uk.ok).toBe(false)
    expect(uk.reasons.join(' ')).toMatch(/see more/i)

    const us = validateDisclosure(post, 'US')
    expect(us.ok).toBe(false)
    expect(us.reasons.join(' ')).toMatch(/conspicuous|see more/i)
  })

  it('a leading #ad alone clears the ASA even without a first-frame label', () => {
    const post: DisclosablePost = {
      disclosureType: 'your_brand',
      caption: '#ad our own app, honest opinion',
      firstFrameDisclosure: null,
      spokenDisclosure: false,
    }
    expect(validateDisclosure(post, 'UK').ok).toBe(true)
  })

  it('STRICT regime (EU / unknown) demands the whole artefact', () => {
    // Missing spoken + no first-frame "Ad" → several reasons.
    const post: DisclosablePost = {
      disclosureType: 'branded_content',
      caption: '#ad great stuff',
      firstFrameDisclosure: null,
      spokenDisclosure: false,
    }
    const eu = validateDisclosure(post, 'EU')
    expect(eu.ok).toBe(false)
    expect(eu.reasons.some((x) => /first frame/i.test(x))).toBe(true)
    expect(eu.reasons.some((x) => /spoken/i.test(x))).toBe(true)
  })

  it('flags a missing region on a promotional post (mirrors the DB gate)', () => {
    const post: DisclosablePost = {
      disclosureType: 'branded_content',
      caption: 'check it out',
      firstFrameDisclosure: null,
      spokenDisclosure: false,
    }
    const r = validateDisclosure(post, null)
    expect(r.ok).toBe(false)
    expect(r.reasons.some((x) => /disclosure_region is required/i.test(x))).toBe(true)
  })
})

describe('checkSoundVsAccountType', () => {
  it('business account MUST use a CML sound', () => {
    expect(checkSoundVsAccountType('business', true).ok).toBe(true)
  })

  it('business + non-CML is unbuildable, flagged before shooting', () => {
    const r = checkSoundVsAccountType('business', false)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/unbuildable/i)
  })

  it('business + unknown provenance (null) is unbuildable — only explicit true clears it', () => {
    expect(checkSoundVsAccountType('business', null).ok).toBe(false)
    expect(checkSoundVsAccountType('business', undefined).ok).toBe(false)
  })

  it('creator may use trending sounds but the reason notes it cannot publish via API', () => {
    const r = checkSoundVsAccountType('creator', false)
    expect(r.ok).toBe(true)
    expect(r.reason).toMatch(/cannot publish via API/i)
  })
})

describe('reviewCompetitorClaims', () => {
  it('accepts a dated, numeric, human-verified figure', () => {
    const claims: CompetitorClaim[] = [
      {
        claim: 'Goodfor is cheaper than Rival',
        figure: '£5/mo vs £8/mo as at 2026-08-16',
        asOfDate: '2026-08-16',
        verifiedBy: 'legal@goodfor',
      },
    ]
    const r = reviewCompetitorClaims(claims)
    expect(r.ok).toBe(true)
    expect(r.unsubstantiated).toEqual([])
  })

  it('rejects a bare comparative with no figure', () => {
    const r = reviewCompetitorClaims([{ claim: 'We are cheaper than Rival' }])
    expect(r.ok).toBe(false)
    expect(r.unsubstantiated).toHaveLength(1)
    expect(r.unsubstantiated[0]!.reason).toMatch(/cheaper/i)
  })

  it('rejects an undated figure', () => {
    const r = reviewCompetitorClaims([
      { claim: 'Goodfor is cheaper than Rival', figure: '£5 vs £8', verifiedBy: 'legal@goodfor' },
    ])
    expect(r.ok).toBe(false)
    expect(r.unsubstantiated[0]!.reason).toMatch(/undated/i)
  })

  it('rejects a figure with no numeric quantity', () => {
    const r = reviewCompetitorClaims([
      { claim: 'Rival costs more', figure: 'a lot more as at 2026-08-16', verifiedBy: 'x' },
    ])
    expect(r.ok).toBe(false)
    expect(r.unsubstantiated[0]!.reason).toMatch(/numeric/i)
  })

  it('rejects a dated figure that was never human-verified', () => {
    const r = reviewCompetitorClaims([
      { claim: 'Goodfor is cheaper', figure: '£5 vs £8 as at 2026-08-16' },
    ])
    expect(r.ok).toBe(false)
    expect(r.unsubstantiated[0]!.reason).toMatch(/verified_by/i)
  })

  it('accepts the as_of_date field carrying the date instead of the figure text', () => {
    const r = reviewCompetitorClaims([
      { claim: 'Rival is 20% pricier', figure: '£10 vs £8', asOfDate: '2026-08-16', verifiedBy: 'legal' },
    ])
    expect(r.ok).toBe(true)
  })

  it('an empty claim list is trivially ok', () => {
    expect(reviewCompetitorClaims([]).ok).toBe(true)
  })
})

describe('checkAigcRealism', () => {
  it('labels a realistic AI-generated scene', () => {
    const r = checkAigcRealism({ aiGenerated: true, depictsRealisticSceneOrPerson: true })
    expect(r.mustLabel).toBe(true)
    expect(r.reason).toMatch(/AI-generated/i)
  })

  it('labels a significantly edited realistic person even without the AI flag', () => {
    const r = checkAigcRealism({ significantlyEdited: true, depictsRealisticSceneOrPerson: true })
    expect(r.mustLabel).toBe(true)
  })

  it('does NOT label non-realistic content — the trigger is realism, not AI', () => {
    // Fully AI-made anime → no label (artistic style + not realistic).
    const r = checkAigcRealism({
      aiGenerated: true,
      depictsRealisticSceneOrPerson: false,
      safeHarbour: 'artistic_style',
    })
    expect(r.mustLabel).toBe(false)
    expect(r.reason).toMatch(/realism/i)
  })

  it('does NOT label a safe-harbour edit on realistic footage (colour correction)', () => {
    const r = checkAigcRealism({
      significantlyEdited: false,
      depictsRealisticSceneOrPerson: true,
      safeHarbour: 'color_correction',
    })
    expect(r.mustLabel).toBe(false)
    expect(r.reason).toMatch(/safe-harbour/i)
  })

  it('does NOT label genuine unedited footage of a real person', () => {
    const r = checkAigcRealism({ depictsRealisticSceneOrPerson: true })
    expect(r.mustLabel).toBe(false)
    expect(r.reason).toMatch(/genuine/i)
  })

  it('adds the EU AI Act Art. 50 marking duty for EU targets', () => {
    const r = checkAigcRealism({
      aiGenerated: true,
      depictsRealisticSceneOrPerson: true,
      targetRegion: 'EU',
    })
    expect(r.mustLabel).toBe(true)
    expect(r.reason).toMatch(/Art\. 50/i)
    expect(r.reason).toMatch(/never strip watermarks/i)
  })
})
