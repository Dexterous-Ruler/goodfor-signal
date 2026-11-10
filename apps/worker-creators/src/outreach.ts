/**
 * Outreach cadence (PHASE-5-scale-creators.md §9.2, §Work-breakdown 5).
 *
 * DM FIRST TOUCH, EMAIL FOR THE CADENCE. TikTok delivers EXACTLY ONE DM to a
 * non-follower's request inbox, then blocks until they accept/reply — so the DM
 * is a ONE-SHOT: we send it once and NEVER retry it (even a failed attempt spends
 * the shot). The follow-up cadence is email: day 2, day 5, terminal at day 28.
 *
 * `next_action_at` drives the schedule; `first_contacted_at` / `replied_at` are
 * stamped as the collaboration moves. A reply short-circuits the cadence (a human
 * takes over). Plan for the LOW end of every response band (§9.2).
 *
 * ⚠️ All response-rate figures in §9.2 are weak-evidence vendor numbers — this
 * module encodes only the CADENCE TIMING, never a predicted response rate.
 */

import { canTransition, type Stage } from '@goodfor/creator-crm'

import { OutreachNotDispatchedError, type CreatorDeps, type CollaborationRow, type CollaborationUpdate } from './deps.js'

const DAY_MS = 24 * 3600_000

/** Follow-up schedule in days from first contact (§9.2). */
export const OUTREACH_CADENCE_DAYS = {
  firstFollowup: 2,
  secondFollowup: 5,
  terminal: 28,
} as const

export type OutreachAction =
  | 'dm'
  | 'email_followup_1'
  | 'email_followup_2'
  | 'email_terminal'
  | 'none'

export interface OutreachPlan {
  action: OutreachAction
  reason: string
}

/**
 * Decide the due outreach action for a collaboration at `now`. Pure. A reply
 * stops the cadence; otherwise the first touch is a DM and the rest are email
 * milestones keyed off `first_contacted_at`.
 */
export function planOutreach(collab: CollaborationRow, now: Date): OutreachPlan {
  if (collab.replied_at) return { action: 'none', reason: 'creator replied — human takes over' }

  if (!collab.first_contacted_at) return { action: 'dm', reason: 'first touch (one-shot DM)' }

  const elapsedDays = (now.getTime() - new Date(collab.first_contacted_at).getTime()) / DAY_MS
  if (elapsedDays >= OUTREACH_CADENCE_DAYS.terminal) {
    return { action: 'email_terminal', reason: `day ${OUTREACH_CADENCE_DAYS.terminal} terminal email` }
  }
  if (elapsedDays >= OUTREACH_CADENCE_DAYS.secondFollowup) {
    return { action: 'email_followup_2', reason: `day ${OUTREACH_CADENCE_DAYS.secondFollowup} email` }
  }
  if (elapsedDays >= OUTREACH_CADENCE_DAYS.firstFollowup) {
    return { action: 'email_followup_1', reason: `day ${OUTREACH_CADENCE_DAYS.firstFollowup} email` }
  }
  return { action: 'none', reason: 'not yet due' }
}

export interface OutreachTarget {
  collaboration: CollaborationRow
  /** Creator platform + id for the DM (never username-keyed). */
  platform: string
  platformUserId: string
  /** Creator email for the cadence; may be null (then email steps are skipped). */
  email: string | null
  dmMessage?: string
  emailSubject?: string
  emailBody?: string
}

export interface OutreachResult {
  action: OutreachAction
  dmSent: boolean
  emailSent: boolean
  update: CollaborationUpdate | null
}

function scheduleAt(base: Date, days: number): string {
  return new Date(base.getTime() + days * DAY_MS).toISOString()
}

/**
 * Execute the due outreach action for one target and persist the collaboration
 * advance. The DM is sent AT MOST ONCE and never retried — if the send throws,
 * the shot is still counted spent and the cadence moves to email.
 */
export async function runOutreach(deps: CreatorDeps, target: OutreachTarget): Promise<OutreachResult> {
  const collab = target.collaboration
  const now = deps.now()
  const plan = planOutreach(collab, now)

  let dmSent = false
  let emailSent = false
  let update: CollaborationUpdate | null = null

  switch (plan.action) {
    case 'dm': {
      // ONE-SHOT. Attempt exactly once; never retry, even on failure.
      try {
        const res = await deps.outreach.sendDm({
          platform: target.platform,
          platformUserId: target.platformUserId,
          message: target.dmMessage ?? 'Hi — we love your content and would like to collaborate.',
        })
        dmSent = res.delivered
      } catch (err) {
        // A DM that was NEVER dispatched (sender unconfigured / unimplemented) must
        // NOT spend the one-shot: re-throw so the config gap surfaces and the
        // collaboration stays untouched for a real send later. Only a genuine
        // dispatch failure (we actually hit TikTok) counts the shot as spent.
        if (err instanceof OutreachNotDispatchedError) throw err
        deps.logger.warn(
          `[outreach] DM send failed for collaboration ${collab.id} — the one-shot is spent, NOT retrying: ` +
            `${err instanceof Error ? err.message : String(err)}`
        )
      }
      const firstContactedAt = now.toISOString()
      update = {
        first_contacted_at: firstContactedAt,
        next_action_at: scheduleAt(now, OUTREACH_CADENCE_DAYS.firstFollowup),
      }
      // Advance stage to 'contacted' if that is a legal move from where we are.
      if (canTransition(collab.stage as Stage, 'contacted')) update.stage = 'contacted'
      break
    }
    case 'email_followup_1':
    case 'email_followup_2': {
      emailSent = await sendCadenceEmail(deps, target)
      const firstContacted = new Date(collab.first_contacted_at as string)
      const nextDays =
        plan.action === 'email_followup_1'
          ? OUTREACH_CADENCE_DAYS.secondFollowup
          : OUTREACH_CADENCE_DAYS.terminal
      update = { next_action_at: scheduleAt(firstContacted, nextDays) }
      break
    }
    case 'email_terminal': {
      emailSent = await sendCadenceEmail(deps, target)
      update = { next_action_at: null }
      // Timed out with no reply -> archive (a legal abandon from any active stage).
      if (canTransition(collab.stage as Stage, 'archived')) update.stage = 'archived'
      break
    }
    case 'none':
      break
  }

  if (update) {
    const { error } = await deps.client.from('collaboration').update(update).eq('id', collab.id)
    if (error) throw error
  }

  deps.logger.log(
    `[outreach] collaboration ${collab.id}: ${plan.action} (${plan.reason})` +
      `${dmSent ? ' dm-sent' : ''}${emailSent ? ' email-sent' : ''}`
  )
  return { action: plan.action, dmSent, emailSent, update }
}

async function sendCadenceEmail(deps: CreatorDeps, target: OutreachTarget): Promise<boolean> {
  if (!target.email) {
    deps.logger.warn(`[outreach] collaboration ${target.collaboration.id}: no email on file — skipping email step`)
    return false
  }
  const res = await deps.outreach.sendEmail({
    to: target.email,
    subject: target.emailSubject ?? 'Following up on a collaboration',
    body: target.emailBody ?? 'Just following up on our earlier message — would you be open to working together?',
  })
  return res.delivered
}

// ---------------------------------------------------------------------------
// Entrypoint (creators:outreach)
// ---------------------------------------------------------------------------
export async function main(): Promise<void> {
  const { boot, makeCreatorDeps } = await import('./deps.js')
  boot()
  const { db } = await import('@goodfor/db')
  const deps = makeCreatorDeps({ client: db() })
  deps.logger.log('[outreach] resolve due collaborations (next_action_at <= now) and run the cadence.')
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-creators[\\/]src[\\/]outreach\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
