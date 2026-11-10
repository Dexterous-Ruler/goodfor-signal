import { describe, it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import { generateKeyPairSync, verify } from 'node:crypto'
import type { AppleAnalyticsRow } from '@goodfor/attribution'

import { makeAttributeDeps, type AttributeDeps } from './deps.js'
import {
  buildAppleJwt,
  pickLatestProcessing,
  persistAppleRows,
  runApplePoll,
} from './apple-poll.js'
import { mockDb, opsFor, quietLogger } from './testutil.js'

const NOW = new Date('2026-08-16T00:00:00Z')

function deps(client: AttributeDeps['client']): AttributeDeps {
  return makeAttributeDeps({ client, now: () => NOW, logger: quietLogger })
}

function row(overrides: Partial<AppleAnalyticsRow> = {}): AppleAnalyticsRow {
  return {
    reportDate: '2026-08-14',
    processingDate: '2026-08-16',
    sourceType: 'App referrer',
    metricName: 'installs',
    value: 812,
    ...overrides,
  }
}

describe('pickLatestProcessing — newest processing_date wins, older ignored (§10.3)', () => {
  it('keeps the newest processing_date for a given (report_date, source, metric)', () => {
    const older = row({ processingDate: '2026-08-16', value: 800 })
    const newer = row({ processingDate: '2026-08-18', value: 815 }) // Apple correction
    const latest = pickLatestProcessing([older, newer])
    expect(latest).toHaveLength(1)
    expect(latest[0]!.processingDate).toBe('2026-08-18')
    expect(latest[0]!.value).toBe(815)
  })

  it('ignores an older processing_date that arrives after a newer one', () => {
    const newer = row({ processingDate: '2026-08-18', value: 815 })
    const older = row({ processingDate: '2026-08-16', value: 800 })
    const latest = pickLatestProcessing([newer, older]) // order-independent
    expect(latest[0]!.value).toBe(815)
  })

  it('keeps distinct keys separate', () => {
    const a = row({ metricName: 'installs' })
    const b = row({ metricName: 'product_page_views', value: 9000 })
    const c = row({ sourceType: 'App Store search', value: 120 })
    expect(pickLatestProcessing([a, b, c])).toHaveLength(3)
  })
})

describe('persistAppleRows — idempotent upsert on the full primary key', () => {
  it('upserts with onConflict = the 4-column primary key (zero PK collisions)', async () => {
    const { client, calls } = mockDb(() => ({ data: null, error: null }))
    const n = await persistAppleRows(deps(client), [row(), row({ metricName: 'product_page_views', value: 9004 })])
    expect(n).toBe(2)

    const up = opsFor(calls, 'apple_analytics_daily', 'upsert')[0]!
    expect(up.opts.onConflict).toBe('report_date,processing_date,source_type,metric_name')
    expect(up.payload).toHaveLength(2)
    expect(up.payload[0]).toMatchObject({
      report_date: '2026-08-14',
      processing_date: '2026-08-16',
      source_type: 'App referrer',
      metric_name: 'installs',
      value: 812,
    })
  })

  it('is a no-op for an empty row set', async () => {
    const { client, calls } = mockDb()
    expect(await persistAppleRows(deps(client), [])).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

describe('runApplePoll — fetch -> gunzip -> parse -> upsert', () => {
  it('loads an injected gz report and upserts the parsed rows', async () => {
    const tsv =
      'Date\tSource Type\tInstalls\n' +
      '2026-08-14\tApp referrer\t812\n' +
      '2026-08-14\tApp Store search\t120\n'
    const gz = gzipSync(Buffer.from(tsv, 'utf8'))

    const { client, calls } = mockDb(() => ({ data: null, error: null }))
    const res = await runApplePoll(deps(client), {
      fetchReports: async () => [{ gz, processingDate: '2026-08-16' }],
    })

    expect(res.reports).toBe(1)
    expect(res.rows).toBe(2)
    expect(res.upserted).toBe(2)
    const up = opsFor(calls, 'apple_analytics_daily', 'upsert')[0]!
    expect(up.opts.onConflict).toBe('report_date,processing_date,source_type,metric_name')
  })
})

describe('buildAppleJwt — ES256 via node:crypto', () => {
  it('produces a 3-segment JWT whose signature verifies with the public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

    const jwt = buildAppleJwt({ issuerId: 'iss-1', keyId: 'kid-1', privateKeyPem: pem }, { now: NOW })
    const parts = jwt.split('.')
    expect(parts).toHaveLength(3)

    const [h, p, s] = parts as [string, string, string]
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
    expect(header).toMatchObject({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' })
    expect(payload).toMatchObject({ iss: 'iss-1', aud: 'appstoreconnect-v1' })
    expect(payload.exp).toBeGreaterThan(payload.iat)

    // ES256 signatures are raw r‖s (ieee-p1363), NOT DER — verify with the same.
    const sig = Buffer.from(s, 'base64url')
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)
    expect(ok).toBe(true)
  })
})
