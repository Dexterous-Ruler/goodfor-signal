/**
 * @goodfor/attribution — pure-TS attribution core (PHASE-4-attribute.md).
 *
 * Everything here is I/O-free and injectable: parsers, the ct codec, the
 * format-lift regression, the CPI computation, the cadence guard, and a thin
 * fetch-based Kochava client whose fetch + secrets are overridable for tests.
 * The write-plane worker (`apps/worker-attribute`) composes these with
 * `@goodfor/db` and owns all persistence.
 *
 * Convention: this package imports ONLY @goodfor/contracts (shared enums) if it
 * needs them, never another analysis/attribution package.
 */

export * from './install-referrer.js'
export * from './apple-control-total.js'
export * from './ct-codec.js'
export * from './format-lift.js'
export * from './cpi.js'
export * from './cadence.js'
export * from './mmp.js'
