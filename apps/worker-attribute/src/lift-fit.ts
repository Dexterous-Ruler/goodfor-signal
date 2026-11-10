/**
 * Nightly format-lift fit (PHASE-4-attribute.md §Work-breakdown 4 / §10.5).
 *
 * Loads a daily series of (installs, views-by-format), fits the regression
 *   installs_t = baseline + Σ_v (views_{v,t} × k_format)
 * (via @goodfor/attribution's pure OLS with a 1–3 day lag kernel), and persists
 * one `format_lift` row per format cluster keyed on (format_cluster_id,
 * fit_date). Upsert so a re-run for the same fit_date is idempotent.
 *
 * The daily series is INJECTABLE. The default loader is UNVERIFIED — the exact
 * SQL/RPC that aggregates owned-post views per format per day is not wired here;
 * inject `loadSeries` (or pass `days`) rather than inventing numbers.
 */

import { fitFormatLift, type FormatLiftDay } from '@goodfor/attribution'

import type { AttributeDeps, FormatLiftInsert } from './deps.js'

export type LiftSeriesLoader = (
  deps: AttributeDeps,
  opts: { windowDays: number; asOf: string }
) => Promise<FormatLiftDay[]>

const defaultLoadSeries: LiftSeriesLoader = async () => {
  throw new Error(
    'format-lift series loader is not wired — inject `loadSeries` or pass `days` ' +
      '(daily installs + per-format views aggregation is UNVERIFIED here)'
  )
}

export interface LiftFitOptions {
  /** Pre-built series (skips the loader entirely). */
  days?: FormatLiftDay[]
  loadSeries?: LiftSeriesLoader
  /** How many days of history to fit over. Default 60. */
  windowDays?: number
  /** The fit_date to stamp on the persisted rows. Default deps.now() date. */
  fitDate?: string
  candidateLags?: number[]
}

export interface LiftFitResult {
  fitDate: string
  rSquared: number
  lagDays: number
  formats: number
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Fit the format-lift model and persist one `format_lift` row per format. */
export async function runLiftFit(deps: AttributeDeps, opts: LiftFitOptions = {}): Promise<LiftFitResult> {
  const fitDate = opts.fitDate ?? isoDate(deps.now())
  const windowDays = opts.windowDays ?? 60

  const days = opts.days ?? (await (opts.loadSeries ?? defaultLoadSeries)(deps, { windowDays, asOf: fitDate }))
  const fit = fitFormatLift(days, { candidateLags: opts.candidateLags })

  const rows: FormatLiftInsert[] = Object.entries(fit.kByFormat).map(([formatId, k]) => ({
    format_cluster_id: Number(formatId),
    fit_date: fitDate,
    k_format: k,
    lag_days: fit.lagDays,
    r_squared: fit.rSquared,
  }))

  const { error } = await deps.client
    .from('format_lift')
    .upsert(rows, { onConflict: 'format_cluster_id,fit_date' })
  if (error) throw error

  deps.logger.log(
    `[lift-fit] fit_date=${fitDate}: ${rows.length} formats, ` +
      `lag=${fit.lagDays}d, r²=${fit.rSquared.toFixed(4)}`
  )
  return { fitDate, rSquared: fit.rSquared, lagDays: fit.lagDays, formats: rows.length }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const { boot, makeAttributeDeps } = await import('./deps.js')
  boot()
  const deps = makeAttributeDeps()
  const res = await runLiftFit(deps)
  console.log(`[lift-fit] fit_date=${res.fitDate} formats=${res.formats} r²=${res.rSquared.toFixed(4)}`)
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-attribute[\\/]src[\\/]lift-fit\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
