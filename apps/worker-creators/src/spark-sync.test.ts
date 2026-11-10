import { describe, it, expect } from 'vitest'
import {
  makeCreatorDeps,
  type CreatorDeps,
  type DeliverableRow,
  type SparkClient,
  type SparkCode,
} from './deps.js'
import { handleSparkError, syncSparkForDeliverable, mintNewSparkCode, SPARK_ERROR } from './spark-sync.js'
import { mockDb, opsFor, quietLogger, type Router } from './testutil.js'

const NOW = new Date('2026-08-16T00:00:00Z')
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 3600_000).toISOString()

function deliverable(over: Partial<DeliverableRow> = {}): DeliverableRow {
  return {
    id: 900,
    collaboration_id: 5,
    type: 'video',
    due_date: null,
    status: 'live',
    asset_url: null,
    posted_url: null,
    platform_post_id: '7412345678901234567',
    is_spark_ads_authorized: true,
    spark_ads_code: null,
    spark_ads_expires_at: null,
    ...over,
  }
}

function fakeSpark() {
  const mintCalls: { platformPostId: string; durationDays?: number }[] = []
  const metricCalls: string[] = []
  const spark: SparkClient = {
    async linkBusinessCenter() {
      return { linked: true }
    },
    async pullPostMetrics(platformPostId: string) {
      metricCalls.push(platformPostId)
      return { platformPostId, paidImpressions: 1000, paidClicks: 50, paidConversions: 5, spendCents: 20_000 }
    },
    async mintSparkCode(p): Promise<SparkCode> {
      mintCalls.push(p)
      return { code: 'new_code_abc', expiresAt: days(30) }
    },
  }
  return { spark, mintCalls, metricCalls }
}

function deps(router: Router, spark: SparkClient): CreatorDeps {
  const { client, calls } = mockDb(router)
  const d = makeCreatorDeps({ client, spark, now: () => NOW, logger: quietLogger })
  return Object.assign(d, { __calls: calls }) as CreatorDeps & { __calls: typeof calls }
}

describe('handleSparkError — auth_code_expired mints a NEW code (never reactivate)', () => {
  it('mints a new code for the organic post and persists it', async () => {
    const router: Router = () => ({ data: null })
    const { spark, mintCalls } = fakeSpark()
    const d = deps(router, spark) as CreatorDeps & { __calls: any[] }

    const code = await handleSparkError(d, deliverable(), SPARK_ERROR.authCodeExpired)

    expect(code).not.toBeNull()
    expect(code!.code).toBe('new_code_abc')
    // Minted exactly one new code, keyed on the organic post id (the join key).
    expect(mintCalls).toHaveLength(1)
    expect(mintCalls[0]!.platformPostId).toBe('7412345678901234567')

    // Deliverable updated with the NEW code — the old one is never revived.
    const upd = opsFor(d.__calls, 'deliverable', 'update')[0]!
    expect(upd.payload.spark_ads_code).toBe('new_code_abc')
    expect(upd.payload.is_spark_ads_authorized).toBe(true)
    expect(upd.payload.spark_ads_expires_at).toBe(days(30))
  })

  it('does NOT mint for other terminal errors (format / not-public / story)', async () => {
    const router: Router = () => ({ data: null })
    const { spark, mintCalls } = fakeSpark()
    const d = deps(router, spark)

    expect(await handleSparkError(d, deliverable(), SPARK_ERROR.notPublicVideo)).toBeNull()
    expect(await handleSparkError(d, deliverable(), SPARK_ERROR.authCodeFormatError)).toBeNull()
    expect(mintCalls).toHaveLength(0)
  })
})

describe('syncSparkForDeliverable — refreshes a lapsed code + joins metrics on the organic post', () => {
  it('mints a new code when the stored one has expired and pulls paid metrics via platform_post_id', async () => {
    const router: Router = () => ({ data: null })
    const { spark, mintCalls, metricCalls } = fakeSpark()
    const d = deps(router, spark)

    const res = await syncSparkForDeliverable(
      d,
      deliverable({ spark_ads_code: 'old_code', spark_ads_expires_at: days(-1) })
    )

    expect(res.codeRefreshed).toBe(true)
    expect(res.newCode?.code).toBe('new_code_abc')
    expect(mintCalls).toHaveLength(1)
    // Paid metrics joined to the organic post via platform_post_id (§9.3).
    expect(metricCalls).toEqual(['7412345678901234567'])
    expect(res.metrics?.platformPostId).toBe('7412345678901234567')
  })

  it('does not refresh a still-valid code', async () => {
    const router: Router = () => ({ data: null })
    const { spark, mintCalls } = fakeSpark()
    const d = deps(router, spark)
    const res = await syncSparkForDeliverable(
      d,
      deliverable({ spark_ads_code: 'valid', spark_ads_expires_at: days(30) })
    )
    expect(res.codeRefreshed).toBe(false)
    expect(mintCalls).toHaveLength(0)
  })
})

describe('mintNewSparkCode — requires the organic post id', () => {
  it('throws without a platform_post_id (the join key)', async () => {
    const router: Router = () => ({ data: null })
    const { spark } = fakeSpark()
    const d = deps(router, spark)
    await expect(mintNewSparkCode(d, deliverable({ platform_post_id: null }))).rejects.toThrow(
      /platform_post_id/
    )
  })
})
