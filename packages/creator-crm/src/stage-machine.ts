/**
 * Collaboration stage machine (PHASE-5-scale-creators.md §9.5).
 *
 * THE MOVING ENTITY IS THE COLLABORATION, NOT THE CREATOR. One creator sits at
 * different stages for different Goodfor apps simultaneously — the state lives on
 * the `collaboration` row, never on `creator_account`. This module is pure and
 * has no notion of a creator; it only validates transitions on a single
 * collaboration's `stage`, so two collaborations for the same creator are
 * independent by construction.
 *
 * Main sequence:
 *   sourced → qualified → contacted → replied → negotiating → contracted
 *           → delivered → live → paid → renewed
 *
 * Terminal outcomes: paid | renewed | archived | rejected. Any non-terminal
 * stage may be abandoned to `archived` (we walked away / timed out at day 28) or
 * `rejected` (the creator declined / failed vetting). Illegal jumps such as
 * `sourced → live` are rejected.
 */

export const STAGES = [
  'sourced',
  'qualified',
  'contacted',
  'replied',
  'negotiating',
  'contracted',
  'delivered',
  'live',
  'paid',
  'renewed',
  'archived',
  'rejected',
] as const

export type Stage = (typeof STAGES)[number]

/** Fully terminal stages — no outgoing transitions. */
export const TERMINAL_STAGES = ['renewed', 'archived', 'rejected'] as const
export type TerminalStage = (typeof TERMINAL_STAGES)[number]

/** The linear "happy path" advance for each stage, if any. */
const NEXT_IN_SEQUENCE: Partial<Record<Stage, Stage>> = {
  sourced: 'qualified',
  qualified: 'contacted',
  contacted: 'replied',
  replied: 'negotiating',
  negotiating: 'contracted',
  contracted: 'delivered',
  delivered: 'live',
  live: 'paid',
  paid: 'renewed',
}

/**
 * Stages from which a collaboration may still be abandoned/declined. Terminal
 * stages are excluded, so once `archived`/`rejected`/`renewed` nothing moves.
 */
const CAN_ABANDON: readonly Stage[] = [
  'sourced',
  'qualified',
  'contacted',
  'replied',
  'negotiating',
  'contracted',
  'delivered',
  'live',
  'paid',
]

/** Full adjacency map: for each stage, the set of stages it may transition to. */
export function allowedTransitions(from: Stage): readonly Stage[] {
  const out: Stage[] = []
  const forward = NEXT_IN_SEQUENCE[from]
  if (forward) out.push(forward)
  if (CAN_ABANDON.includes(from)) {
    out.push('archived', 'rejected')
  }
  return out
}

/** True iff `to` is a legal next stage from `from`. Same stage is NOT a move. */
export function canTransition(from: Stage, to: Stage): boolean {
  return allowedTransitions(from).includes(to)
}

export function isTerminal(stage: Stage): stage is TerminalStage {
  return (TERMINAL_STAGES as readonly Stage[]).includes(stage)
}

/**
 * Assert a transition is legal, throwing a descriptive error otherwise. Callers
 * that mutate `collaboration.stage` should route through this so an illegal
 * write (e.g. `sourced → live`) fails loudly rather than corrupting the pipeline.
 */
export function assertTransition(from: Stage, to: Stage): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `illegal collaboration stage transition: ${from} → ${to}. ` +
        `Legal next stages from '${from}': ${allowedTransitions(from).join(', ') || '(none — terminal)'}`
    )
  }
}
