import { describe, it, expect } from 'vitest'
import {
  STAGES,
  TERMINAL_STAGES,
  canTransition,
  allowedTransitions,
  assertTransition,
  isTerminal,
  type Stage,
} from './stage-machine.js'

describe('collaboration stage machine — legal transitions', () => {
  it('advances along the main sequence', () => {
    const seq: [Stage, Stage][] = [
      ['sourced', 'qualified'],
      ['qualified', 'contacted'],
      ['contacted', 'replied'],
      ['replied', 'negotiating'],
      ['negotiating', 'contracted'],
      ['contracted', 'delivered'],
      ['delivered', 'live'],
      ['live', 'paid'],
      ['paid', 'renewed'],
    ]
    for (const [from, to] of seq) expect(canTransition(from, to)).toBe(true)
  })

  it('allows abandoning any active stage to archived or rejected', () => {
    for (const from of ['sourced', 'qualified', 'contacted', 'replied', 'negotiating', 'contracted', 'delivered', 'live', 'paid'] as Stage[]) {
      expect(canTransition(from, 'archived')).toBe(true)
      expect(canTransition(from, 'rejected')).toBe(true)
    }
  })
})

describe('collaboration stage machine — illegal transitions', () => {
  it('rejects skipping stages (sourced → live)', () => {
    expect(canTransition('sourced', 'live')).toBe(false)
    expect(canTransition('sourced', 'contacted')).toBe(false)
    expect(canTransition('qualified', 'contracted')).toBe(false)
  })

  it('rejects moving backwards', () => {
    expect(canTransition('contacted', 'sourced')).toBe(false)
    expect(canTransition('live', 'delivered')).toBe(false)
  })

  it('has no transitions out of terminal stages', () => {
    for (const t of TERMINAL_STAGES) {
      expect(allowedTransitions(t)).toHaveLength(0)
      expect(isTerminal(t)).toBe(true)
      for (const to of STAGES) expect(canTransition(t, to)).toBe(false)
    }
  })

  it('treats a no-op (same stage) as not a legal move', () => {
    expect(canTransition('replied', 'replied')).toBe(false)
  })

  it('assertTransition throws on an illegal jump with a helpful message', () => {
    expect(() => assertTransition('sourced', 'live')).toThrow(/illegal collaboration stage transition/)
    expect(() => assertTransition('sourced', 'qualified')).not.toThrow()
  })
})

describe('the same creator sits at different stages in two collaborations', () => {
  it('advances two independent collaborations without conflict', () => {
    // The stage lives on the collaboration, not the creator: one creator, two
    // Goodfor apps, two collaborations, two different stages simultaneously.
    let appAStage: Stage = 'negotiating'
    let appBStage: Stage = 'sourced'

    // App A moves forward; App B is independently rejected. Same creator.
    expect(canTransition(appAStage, 'contracted')).toBe(true)
    appAStage = 'contracted'
    expect(canTransition(appBStage, 'rejected')).toBe(true)
    appBStage = 'rejected'

    expect(appAStage).toBe('contracted')
    expect(appBStage).toBe('rejected')
    // The rejection of B does not constrain A: A can still go live.
    expect(canTransition(appAStage, 'delivered')).toBe(true)
  })
})
