import { describe, it, expect } from 'vitest'
import {
  makeCreatorDeps,
  OutreachNotDispatchedError,
  type CreatorDeps,
  type CollaborationRow,
  type OutreachSender,
  type DmParams,
  type EmailParams,
} from './deps.js'
import { runOutreach, planOutreach, type OutreachTarget } from './outreach.js'
import { mockDb, quietLogger } from './testutil.js'

const T0 = new Date('2026-08-16T00:00:00Z')
const DAY_MS = 24 * 3600_000
const at = (days: number) => new Date(T0.getTime() + days * DAY_MS)

function collab(over: Partial<CollaborationRow> = {}): CollaborationRow {
  return {
    id: 1,
    campaign_id: 1,
    creator_account_id: 1,
    stage: 'qualified',
    owner_user_id: null,
    rate_cents: null,
    currency: 'USD',
    first_contacted_at: null,
    replied_at: null,
    contracted_at: null,
    next_action_at: T0.toISOString(),
    source: null,
    created_at: T0.toISOString(),
    ...over,
  }
}

function fakeSender(opts: { dmThrows?: boolean } = {}) {
  const dmCalls: DmParams[] = []
  const emailCalls: EmailParams[] = []
  const sender: OutreachSender = {
    async sendDm(p) {
      dmCalls.push(p)
      if (opts.dmThrows) throw new Error('TikTok DM blocked')
      return { delivered: true, providerId: 'dm_1' }
    },
    async sendEmail(p) {
      emailCalls.push(p)
      return { delivered: true, providerId: 'em_1' }
    },
  }
  return { sender, dmCalls, emailCalls }
}

function makeDeps(nowRef: { d: Date }, sender: OutreachSender): CreatorDeps {
  const { client } = mockDb(() => ({ data: null }))
  return makeCreatorDeps({ client, outreach: sender, now: () => nowRef.d, logger: quietLogger })
}

describe('planOutreach — pure cadence decision', () => {
  it('first touch is a DM; a reply short-circuits the cadence', () => {
    expect(planOutreach(collab(), T0).action).toBe('dm')
    expect(planOutreach(collab({ first_contacted_at: T0.toISOString(), replied_at: at(1).toISOString() }), at(3)).action).toBe('none')
  })

  it('maps elapsed days to the day 2 / 5 / 28 milestones', () => {
    const c = collab({ first_contacted_at: T0.toISOString() })
    expect(planOutreach(c, at(1)).action).toBe('none')
    expect(planOutreach(c, at(2)).action).toBe('email_followup_1')
    expect(planOutreach(c, at(5)).action).toBe('email_followup_2')
    expect(planOutreach(c, at(28)).action).toBe('email_terminal')
  })
})

describe('runOutreach — exactly one DM, then email on day 2 / 5 / 28', () => {
  it('sends one DM then three emails as time advances, tracking next_action_at', async () => {
    const nowRef = { d: T0 }
    const { sender, dmCalls, emailCalls } = fakeSender()
    const deps = makeDeps(nowRef, sender)
    const target: OutreachTarget = {
      collaboration: collab(),
      platform: 'tiktok',
      platformUserId: 'tt_1',
      email: 'creator@example.com',
    }

    // Day 0 — one-shot DM.
    let res = await runOutreach(deps, target)
    expect(res.action).toBe('dm')
    expect(res.dmSent).toBe(true)
    expect(res.update?.first_contacted_at).toBe(T0.toISOString())
    expect(res.update?.stage).toBe('contacted')
    // next_action_at scheduled for day 2.
    expect(res.update?.next_action_at).toBe(at(2).toISOString())
    // Apply the advance to the shared collaboration.
    Object.assign(target.collaboration, res.update)

    // Day 2 — first email.
    nowRef.d = at(2)
    res = await runOutreach(deps, target)
    expect(res.action).toBe('email_followup_1')
    expect(res.update?.next_action_at).toBe(at(5).toISOString())
    Object.assign(target.collaboration, res.update)

    // Day 5 — second email.
    nowRef.d = at(5)
    res = await runOutreach(deps, target)
    expect(res.action).toBe('email_followup_2')
    expect(res.update?.next_action_at).toBe(at(28).toISOString())
    Object.assign(target.collaboration, res.update)

    // Day 28 — terminal email + archive.
    nowRef.d = at(28)
    res = await runOutreach(deps, target)
    expect(res.action).toBe('email_terminal')
    expect(res.update?.next_action_at).toBeNull()
    expect(res.update?.stage).toBe('archived')

    // EXACTLY one DM; three emails (day 2 / 5 / 28).
    expect(dmCalls).toHaveLength(1)
    expect(emailCalls).toHaveLength(3)
  })

  it('never retries the one-shot DM even when the send throws', async () => {
    const nowRef = { d: T0 }
    const { sender, dmCalls } = fakeSender({ dmThrows: true })
    const deps = makeDeps(nowRef, sender)
    const target: OutreachTarget = {
      collaboration: collab(),
      platform: 'tiktok',
      platformUserId: 'tt_1',
      email: 'creator@example.com',
    }

    const res = await runOutreach(deps, target)
    // The shot is spent: dmSent false, but the cadence still advances to email.
    expect(res.action).toBe('dm')
    expect(res.dmSent).toBe(false)
    expect(res.update?.first_contacted_at).toBe(T0.toISOString())
    expect(res.update?.next_action_at).toBe(at(2).toISOString())
    // Attempted exactly once — never retried.
    expect(dmCalls).toHaveLength(1)
  })

  it('does NOT spend the one-shot when the DM was never dispatched (unconfigured sender)', async () => {
    const nowRef = { d: T0 }
    const dmCalls: DmParams[] = []
    const sender: OutreachSender = {
      async sendDm(p) {
        dmCalls.push(p)
        throw new OutreachNotDispatchedError('TIKTOK_DM_ACCESS_TOKEN is not set')
      },
      async sendEmail() {
        return { delivered: true, providerId: 'em_1' }
      },
    }
    const deps = makeDeps(nowRef, sender)
    const target: OutreachTarget = {
      collaboration: collab(),
      platform: 'tiktok',
      platformUserId: 'tt_1',
      email: 'creator@example.com',
    }
    // A never-dispatched DM re-throws — it must NOT silently advance the collaboration.
    await expect(runOutreach(deps, target)).rejects.toBeInstanceOf(OutreachNotDispatchedError)
    // first_contacted_at stays null, so the real DM can still fire once configured.
    expect(target.collaboration.first_contacted_at).toBeNull()
  })
})
