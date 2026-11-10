/**
 * Format-lift regression (PHASE-4-attribute.md §10.5).
 *
 *   installs_t = baseline + Σ_v (views_{v,t} × k_format_v)
 *
 * with a 1–3 day lag kernel (~72% of a video's views land on day one). We fit
 * one coefficient `k_format` per `format_cluster` plus a baseline intercept, by
 * ordinary least squares. Pure math — no external stats library.
 *
 * The cadence constraint (§10.5) is what makes this identifiable at all: at >2
 * videos/account/day the per-format regressors collinearise and OLS cannot
 * separate which format drove which spike. See `cadence.ts`.
 */

export interface FormatLiftDay {
  /** ISO date (YYYY-MM-DD) — used only for chronological ordering. */
  date: string
  installs: number
  /** views that day, keyed by format_cluster_id. Missing formats = 0 views. */
  viewsByFormat: Record<number, number>
}

export interface FormatLiftFit {
  /** installs-per-view coefficient, keyed by format_cluster_id. */
  kByFormat: Record<number, number>
  baseline: number
  rSquared: number
  lagDays: number
}

export interface FitOptions {
  /** Format cluster ids to fit. Default: the union of ids seen in the data. */
  formatClusterIds?: number[]
  /** Candidate lag windows to try; the best rSquared wins. Default [1,2,3]. */
  candidateLags?: number[]
  /**
   * Lag kernel factory: weights over lags [0..lagDays-1], lag 0 = same day.
   * Default puts ~72% on day one and decays. Weights are normalised internally.
   */
  kernel?: (lagDays: number) => number[]
}

/** Default lag kernel: ~72% same-day, decaying, normalised to sum 1 (§10.5). */
export function defaultLagKernel(lagDays: number): number[] {
  if (lagDays <= 1) return [1]
  if (lagDays === 2) return [0.72, 0.28]
  // lagDays >= 3: front-load day one, taper the tail.
  const base = [0.72, 0.2, 0.08]
  const w = base.slice(0, lagDays)
  while (w.length < lagDays) w.push(0)
  const sum = w.reduce((a, b) => a + b, 0)
  return w.map((x) => x / sum)
}

function normalise(weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum === 0) throw new Error('lag kernel sums to zero')
  return weights.map((w) => w / sum)
}

/**
 * Solve `Xβ = y` in the least-squares sense via the normal equations
 * `(XᵀX)β = Xᵀy` with Gaussian elimination + partial pivoting.
 *
 * Exported for testing; throws if the system is singular (e.g. collinear
 * regressors — the exact failure the cadence guard exists to prevent).
 */
export function solveLeastSquares(X: number[][], y: number[]): number[] {
  const rows = X.length
  if (rows === 0) throw new Error('no rows to fit')
  const cols = X[0]!.length
  if (rows < cols) throw new Error(`underdetermined: ${rows} rows < ${cols} unknowns`)

  // A = XᵀX (cols×cols), b = Xᵀy (cols).
  const A: number[][] = Array.from({ length: cols }, () => new Array(cols).fill(0))
  const b: number[] = new Array(cols).fill(0)
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < cols; j++) {
      let s = 0
      for (let r = 0; r < rows; r++) s += X[r]![i]! * X[r]![j]!
      A[i]![j] = s
    }
    let s = 0
    for (let r = 0; r < rows; r++) s += X[r]![i]! * y[r]!
    b[i] = s
  }

  // Gaussian elimination with partial pivoting on the augmented [A|b].
  for (let col = 0; col < cols; col++) {
    let pivot = col
    for (let r = col + 1; r < cols; r++) {
      if (Math.abs(A[r]![col]!) > Math.abs(A[pivot]![col]!)) pivot = r
    }
    if (Math.abs(A[pivot]![col]!) < 1e-12) {
      throw new Error('singular system — regressors are collinear (check posting cadence)')
    }
    if (pivot !== col) {
      ;[A[col], A[pivot]] = [A[pivot]!, A[col]!]
      ;[b[col], b[pivot]] = [b[pivot]!, b[col]!]
    }
    const pivVal = A[col]![col]!
    for (let r = 0; r < cols; r++) {
      if (r === col) continue
      const factor = A[r]![col]! / pivVal
      if (factor === 0) continue
      for (let c = col; c < cols; c++) A[r]![c]! -= factor * A[col]![c]!
      b[r]! -= factor * b[col]!
    }
  }

  const beta = new Array(cols).fill(0)
  for (let i = 0; i < cols; i++) beta[i] = b[i]! / A[i]![i]!
  return beta
}

function rSquared(yObs: number[], yHat: number[]): number {
  const mean = yObs.reduce((a, b) => a + b, 0) / yObs.length
  let ssTot = 0
  let ssRes = 0
  for (let i = 0; i < yObs.length; i++) {
    ssTot += (yObs[i]! - mean) ** 2
    ssRes += (yObs[i]! - yHat[i]!) ** 2
  }
  if (ssTot === 0) return ssRes === 0 ? 1 : 0
  return 1 - ssRes / ssTot
}

/** Build the lagged regressor matrix + target for a given lag window. */
function buildDesign(
  days: FormatLiftDay[],
  formatIds: number[],
  weights: number[]
): { X: number[][]; y: number[] } {
  const L = weights.length
  const X: number[][] = []
  const y: number[] = []
  // Only days with a full lag window behind them can be used.
  for (let t = L - 1; t < days.length; t++) {
    const row = [1] // intercept -> baseline
    for (const f of formatIds) {
      let reg = 0
      for (let j = 0; j < L; j++) {
        reg += weights[j]! * (days[t - j]!.viewsByFormat[f] ?? 0)
      }
      row.push(reg)
    }
    X.push(row)
    y.push(days[t]!.installs)
  }
  return { X, y }
}

/**
 * Fit the format-lift model. Tries each candidate lag window and returns the fit
 * with the highest rSquared. Days are sorted chronologically first.
 *
 * Throws if there is not enough data (fewer usable rows than unknowns) for every
 * candidate lag, or if the regressors are collinear (singular system).
 */
export function fitFormatLift(days: FormatLiftDay[], opts: FitOptions = {}): FormatLiftFit {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date))
  const formatIds =
    opts.formatClusterIds ??
    [...new Set(ordered.flatMap((d) => Object.keys(d.viewsByFormat).map(Number)))].sort((a, b) => a - b)
  if (formatIds.length === 0) throw new Error('no format clusters to fit')

  const candidateLags = opts.candidateLags ?? [1, 2, 3]
  const kernelFn = opts.kernel ?? defaultLagKernel

  let best: FormatLiftFit | null = null
  const failures: string[] = []
  for (const lagDays of candidateLags) {
    const weights = normalise(kernelFn(lagDays))
    const { X, y } = buildDesign(ordered, formatIds, weights)
    if (X.length < formatIds.length + 1) {
      failures.push(`lag=${lagDays}: ${X.length} usable rows < ${formatIds.length + 1} unknowns`)
      continue
    }
    let beta: number[]
    try {
      beta = solveLeastSquares(X, y)
    } catch (err) {
      failures.push(`lag=${lagDays}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const yHat = X.map((row) => row.reduce((acc, xi, i) => acc + xi * beta[i]!, 0))
    const r2 = rSquared(y, yHat)

    const kByFormat: Record<number, number> = {}
    formatIds.forEach((f, i) => (kByFormat[f] = beta[i + 1]!))
    const fit: FormatLiftFit = { kByFormat, baseline: beta[0]!, rSquared: r2, lagDays }
    if (!best || fit.rSquared > best.rSquared) best = fit
  }

  if (!best) throw new Error(`format-lift fit failed for every candidate lag: ${failures.join('; ')}`)
  return best
}
