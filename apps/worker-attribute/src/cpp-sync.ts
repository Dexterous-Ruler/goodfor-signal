/**
 * Custom Product Page sync + registry (PHASE-4-attribute.md §Work-breakdown 7 / §10.3).
 *
 * Apple Custom Product Pages (up to 70) give FORMAT-LEVEL iOS conversion above
 * the privacy floor — each CPP has its own conversion metrics. We map each CPP
 * 1:1 onto a `format_cluster` and store `cpp_apple_id ↔ format_cluster_id ↔
 * ct_code` (the `ct` is base36 + a lookup table, ≤30 chars, via
 * @goodfor/attribution's CtCodec).
 *
 * `provisionCpp` registers a CPP with a collision-free ct code; `syncCppMetrics`
 * pulls per-CPP conversion metrics and joins them to their format cluster.
 *
 * // UNVERIFIED — the App Store Connect CPP metrics endpoint shape is written
 * from the docs, not validated against a live key.
 */

import { CtCodec } from '@goodfor/attribution'

import type { AttributeDeps, CustomProductPageInsert, CustomProductPageRow } from './deps.js'

/**
 * Build a CtCodec seeded from the ct codes already persisted, so a newly-issued
 * code never collides with an existing one. The key is the CPP's Apple id.
 */
export async function loadCtCodec(
  deps: AttributeDeps,
  opts: { onAssign?: (key: string, code: string) => void } = {}
): Promise<CtCodec> {
  const { data, error } = await deps.client.from('custom_product_page').select('cpp_apple_id, ct_code')
  if (error) throw error
  const rows = (data as Pick<CustomProductPageRow, 'cpp_apple_id' | 'ct_code'>[] | null) ?? []
  return new CtCodec(
    rows.map((r) => [r.cpp_apple_id, r.ct_code] as const),
    { prefix: 'c', onAssign: opts.onAssign }
  )
}

export interface ProvisionCppInput {
  cppAppleId: string
  name: string
  formatClusterId: number
  /** Optional shared codec (so a batch of provisions share one counter). */
  codec?: CtCodec
}

/** Register a Custom Product Page with a collision-free base36 `ct` code. */
export async function provisionCpp(
  deps: AttributeDeps,
  input: ProvisionCppInput
): Promise<{ ctCode: string; cppId: number | null }> {
  const codec = input.codec ?? (await loadCtCodec(deps))
  const ctCode = codec.codeFor(input.cppAppleId)

  const row: CustomProductPageInsert = {
    cpp_apple_id: input.cppAppleId,
    name: input.name,
    format_cluster_id: input.formatClusterId,
    ct_code: ctCode,
  }
  const { data, error } = await deps.client
    .from('custom_product_page')
    .insert(row)
    .select('id')
    .single()
  if (error) throw error
  const cppId = (data as { id: number } | null)?.id ?? null
  deps.logger.log(`[cpp-sync] provisioned CPP ${input.cppAppleId} -> ct=${ctCode}, format=${input.formatClusterId}`)
  return { ctCode, cppId }
}

/** Per-CPP conversion metrics from Apple. // UNVERIFIED shape. */
export interface CppMetrics {
  cppAppleId: string
  impressions: number
  productPageViews: number
  conversions: number
}

export type CppMetricsFetcher = (deps: AttributeDeps, cppAppleIds: string[]) => Promise<CppMetrics[]>

const defaultFetchCppMetrics: CppMetricsFetcher = async () => {
  throw new Error(
    'CPP metrics fetch is not wired — inject `fetchCppMetrics` (App Store Connect per-CPP ' +
      'conversion metrics endpoint is UNVERIFIED against a live key)'
  )
}

export interface CppMetricsJoined extends CppMetrics {
  formatClusterId: number | null
  ctCode: string
}

/**
 * Pull per-CPP conversion metrics and join each to its `format_cluster` via the
 * `custom_product_page` registry. Returns one joined row per CPP that has
 * metrics; CPPs with no metrics (below the 5-user floor) are simply absent.
 */
export async function syncCppMetrics(
  deps: AttributeDeps,
  opts: { fetchCppMetrics?: CppMetricsFetcher } = {}
): Promise<CppMetricsJoined[]> {
  const fetchCppMetrics = opts.fetchCppMetrics ?? defaultFetchCppMetrics

  const { data, error } = await deps.client
    .from('custom_product_page')
    .select('cpp_apple_id, ct_code, format_cluster_id')
  if (error) throw error
  const cpps = (data as Pick<CustomProductPageRow, 'cpp_apple_id' | 'ct_code' | 'format_cluster_id'>[] | null) ?? []
  if (cpps.length === 0) return []

  const byAppleId = new Map(cpps.map((c) => [c.cpp_apple_id, c]))
  const metrics = await fetchCppMetrics(deps, [...byAppleId.keys()])

  const joined: CppMetricsJoined[] = []
  for (const m of metrics) {
    const cpp = byAppleId.get(m.cppAppleId)
    if (!cpp) {
      deps.logger.warn(`[cpp-sync] metrics for unknown CPP ${m.cppAppleId} — skipping`)
      continue
    }
    joined.push({ ...m, formatClusterId: cpp.format_cluster_id, ctCode: cpp.ct_code })
  }
  deps.logger.log(`[cpp-sync] joined ${joined.length}/${cpps.length} CPP metric rows to format clusters`)
  return joined
}
