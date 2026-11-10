/**
 * Apple App Store Connect — Analytics Reports parsing (PHASE-4-attribute.md §10.3).
 *
 * Apple's Analytics Reports API returns tab-delimited `.txt.gz`. It is a daily,
 * channel-level CONTROL TOTAL — NEVER a per-video ledger — because of the
 * privacy floor (values from <5 users omitted; noise ±2 @68.2%). We load it
 * idempotently, newest `processing_date` wins.
 *
 * Source Type is Apple's channel enum. TikTok's in-app webview surfaces as an
 * "App referrer" (a link opened inside another app), NOT a "Web referrer".
 *
 * Pure: gunzip + parse only. The worker owns the idempotent upsert.
 *
 * // UNVERIFIED — the exact column headers of each Apple report are written from
 * the docs, not validated against a live App Store Connect export. The parser is
 * therefore column-driven (find columns by header) rather than positional.
 */

import { gunzipSync } from 'node:zlib'

/** Apple's Source Type enum (§10.3). */
export const APPLE_SOURCE_TYPES = [
  'App Store search',
  'App Store browse',
  'App referrer',
  'Web referrer',
  'App Clip',
  'Unavailable',
  'Institutional purchase',
] as const
export type AppleSourceType = (typeof APPLE_SOURCE_TYPES)[number]

/** TikTok's in-app webview is an App referrer, not a Web referrer (§10.3). */
export const TIKTOK_SOURCE_TYPE: AppleSourceType = 'App referrer'

const SOURCE_LOOKUP = new Map<string, AppleSourceType>(
  APPLE_SOURCE_TYPES.map((s) => [s.toLowerCase(), s])
)

/**
 * Normalise a raw Source Type cell to the canonical enum.
 *
 * `strict` (default false) maps an unrecognised value to 'Unavailable' so one
 * unexpected row never crashes a whole report load. Pass `strict: true` to
 * assert the enum is complete (throws on an unknown source — use in tests /
 * schema-drift checks).
 */
export function mapSourceType(raw: string, opts: { strict?: boolean } = {}): AppleSourceType {
  const hit = SOURCE_LOOKUP.get(raw.trim().toLowerCase())
  if (hit) return hit
  if (opts.strict) throw new Error(`unknown Apple Source Type: '${raw}'`)
  return 'Unavailable'
}

/** gunzip a `.txt.gz` Analytics report into its tab-delimited text. */
export function gunzipReport(gz: Uint8Array): string {
  return gunzipSync(gz).toString('utf8')
}

/** One emitted control-total cell, keyed exactly as `apple_analytics_daily`. */
export interface AppleAnalyticsRow {
  reportDate: string // YYYY-MM-DD, from the report's Date column
  processingDate: string // YYYY-MM-DD, when Apple generated THIS version
  sourceType: AppleSourceType
  metricName: string // snake_cased header, e.g. 'installs', 'product_page_views'
  value: number // privacy-floored; cells Apple omitted (<5) simply don't appear
}

export interface ParseReportOptions {
  /** The Apple processing date for this report version (from request metadata). */
  processingDate: string
  /** Header of the per-row report date column. Default 'Date'. */
  dateColumn?: string
  /** Header of the Source Type column. Default 'Source Type'. */
  sourceTypeColumn?: string
  /**
   * Which columns are metrics. If omitted, every column that is neither the
   * date nor the source-type column and whose cell parses as a number is
   * treated as a metric.
   */
  metricColumns?: string[]
  /** Map an unknown source type to 'Unavailable' (default) vs throw. */
  strictSourceType?: boolean
}

/** Snake_case a header so metric names are stable across reports. */
export function normaliseMetricName(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function parseNumericCell(cell: string): number | null {
  const t = cell.trim()
  if (t === '' || t === '-') return null
  // Apple omits <5; a literal '< 5' should also be skipped rather than coerced.
  if (/^<\s*\d+$/.test(t)) return null
  const n = Number(t.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * Parse a tab-delimited Analytics report into control-total rows keyed on
 * (report_date, processing_date, source_type, metric_name).
 *
 * Rows with an empty date cell are skipped. Metric cells that don't parse as a
 * number (blank, '-', '<5') are omitted, matching Apple's privacy-floor
 * suppression — we never invent a value for a suppressed cell.
 */
export function parseControlTotalReport(tsv: string, opts: ParseReportOptions): AppleAnalyticsRow[] {
  const dateCol = opts.dateColumn ?? 'Date'
  const srcCol = opts.sourceTypeColumn ?? 'Source Type'

  const lines = tsv.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return []

  const header = lines[0]!.split('\t').map((h) => h.trim())
  const dateIdx = header.indexOf(dateCol)
  const srcIdx = header.indexOf(srcCol)
  if (dateIdx === -1) throw new Error(`report is missing the '${dateCol}' column`)
  if (srcIdx === -1) throw new Error(`report is missing the '${srcCol}' column`)

  // Resolve metric columns to indices (explicit list, or auto = everything else).
  const metricIdx: { name: string; idx: number }[] = []
  header.forEach((h, i) => {
    if (i === dateIdx || i === srcIdx) return
    if (opts.metricColumns && !opts.metricColumns.includes(h)) return
    metricIdx.push({ name: normaliseMetricName(h), idx: i })
  })

  const rows: AppleAnalyticsRow[] = []
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r]!.split('\t')
    const reportDate = (cells[dateIdx] ?? '').trim()
    if (reportDate === '') continue
    const sourceType = mapSourceType(cells[srcIdx] ?? '', { strict: opts.strictSourceType })

    for (const m of metricIdx) {
      const value = parseNumericCell(cells[m.idx] ?? '')
      if (value === null) continue
      rows.push({
        reportDate,
        processingDate: opts.processingDate,
        sourceType,
        metricName: m.name,
        value,
      })
    }
  }
  return rows
}
