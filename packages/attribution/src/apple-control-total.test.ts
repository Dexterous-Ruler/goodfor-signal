import { describe, it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import {
  gunzipReport,
  mapSourceType,
  parseControlTotalReport,
  normaliseMetricName,
  TIKTOK_SOURCE_TYPE,
} from './apple-control-total.js'

describe('mapSourceType', () => {
  it('maps TikTok in-app webview to "App referrer", not "Web referrer"', () => {
    expect(TIKTOK_SOURCE_TYPE).toBe('App referrer')
    expect(mapSourceType('App referrer')).toBe('App referrer')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(mapSourceType('  app store SEARCH ')).toBe('App Store search')
  })

  it('maps unknown source types to Unavailable by default', () => {
    expect(mapSourceType('Carrier Pigeon')).toBe('Unavailable')
  })

  it('throws on an unknown source type when strict (schema-drift check)', () => {
    expect(() => mapSourceType('Carrier Pigeon', { strict: true })).toThrow(/unknown Apple Source Type/)
  })
})

describe('normaliseMetricName', () => {
  it('snake_cases headers', () => {
    expect(normaliseMetricName('Product Page Views')).toBe('product_page_views')
    expect(normaliseMetricName('Installs')).toBe('installs')
  })
})

describe('gunzipReport + parseControlTotalReport', () => {
  const tsv =
    'Date\tSource Type\tInstalls\tProduct Page Views\n' +
    '2026-08-14\tApp referrer\t812\t9004\n' +
    '2026-08-14\tApp Store search\t120\t2200\n' +
    '2026-08-14\tWeb referrer\t-\t15\n' // omitted install cell (privacy floor)

  it('gunzips a .txt.gz report', () => {
    const gz = gzipSync(Buffer.from(tsv, 'utf8'))
    expect(gunzipReport(gz)).toBe(tsv)
  })

  it('parses rows keyed on (report_date, processing_date, source_type, metric_name)', () => {
    const rows = parseControlTotalReport(tsv, { processingDate: '2026-08-16' })
    // App referrer: installs + product_page_views ; App Store search: 2 ; Web referrer: only product_page_views (install omitted)
    expect(rows).toHaveLength(5)

    const appRef = rows.find((r) => r.sourceType === 'App referrer' && r.metricName === 'installs')
    expect(appRef).toEqual({
      reportDate: '2026-08-14',
      processingDate: '2026-08-16',
      sourceType: 'App referrer',
      metricName: 'installs',
      value: 812,
    })
  })

  it('skips privacy-floored (omitted) cells rather than inventing a value', () => {
    const rows = parseControlTotalReport(tsv, { processingDate: '2026-08-16' })
    const webInstalls = rows.find((r) => r.sourceType === 'Web referrer' && r.metricName === 'installs')
    expect(webInstalls).toBeUndefined()
    const webPPV = rows.find((r) => r.sourceType === 'Web referrer' && r.metricName === 'product_page_views')
    expect(webPPV?.value).toBe(15)
  })

  it('respects an explicit metricColumns allow-list', () => {
    const rows = parseControlTotalReport(tsv, {
      processingDate: '2026-08-16',
      metricColumns: ['Installs'],
    })
    expect(rows.every((r) => r.metricName === 'installs')).toBe(true)
  })

  it('throws if a required column is missing', () => {
    expect(() => parseControlTotalReport('Foo\tBar\n1\t2', { processingDate: '2026-08-16' })).toThrow(
      /missing the 'Date' column/
    )
  })
})
