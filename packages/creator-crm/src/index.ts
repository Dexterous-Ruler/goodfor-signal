/**
 * @goodfor/creator-crm — pure-TS domain core for the UGC Creator CRM
 * (PHASE-5-scale-creators.md).
 *
 * Everything here is I/O-free and injectable: the collaboration stage machine,
 * the licensing/rate maths, the vetting gates, the licence-end alert decision,
 * and two thin fetch-based Discovery clients (Modash + HypeAuditor) whose fetch,
 * clock and secrets are all overridable for tests. The write-plane worker
 * (`apps/worker-creators`) composes these with `@goodfor/db` and owns ALL
 * persistence.
 *
 * Convention: this package imports ONLY @goodfor/contracts (shared enums) if it
 * needs them, never another package. There is deliberately NO "50% of ask"
 * pricing rule anywhere in here, and `exclusivity_multiplier` has no default.
 */

export * from './stage-machine.js'
export * from './pricing.js'
export * from './vetting.js'
export * from './licence.js'
export * from './modash.js'
export * from './hypeauditor.js'
