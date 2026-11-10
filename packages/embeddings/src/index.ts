/**
 * Text embeddings for format/hook clustering.
 *
 * Design notes (PHASE-2-understand.md §6.6, completion.md §6):
 *
 * 1. MODEL CHOSEN ON DIMENSION, NOT PRICE. `text-embedding-3-small` at 1536
 *    dims maps exactly onto the live `video_analysis.embedding halfvec(1536)`
 *    column + its HNSW index. At $0.02/M tokens the whole corpus costs ~$1.20
 *    a YEAR — a rounding error. The decision is made entirely by the target
 *    vector width, never by cost.
 *
 * 2. EMBEDDINGS ARE COMPUTED ONCE. Python (UMAP/BERTopic) re-runs over these
 *    fixed vectors; it never re-embeds. So this provider only has to be correct
 *    and cheap, not clever — it is deliberately the simplest of the five.
 *
 * 3. COST IS PER-ITEM. The API only reports one `usage.total_tokens` per
 *    request, but the orchestrator writes `video_analysis.cost_usd` PER VIDEO
 *    (`cost_usd = Σ provider.costUsd`). So a batch's cost is split across its
 *    members proportionally to text length, rather than dumped on the first
 *    result — see `splitCost` below.
 */

import { ProviderError, type EmbeddingProvider, type EmbeddingResult } from '@goodfor/contracts'

/** OpenAI list-price for text-embedding-3-small, USD per 1M tokens. */
export const COST_PER_MILLION_TOKENS = 0.02

/** text-embedding-3-small's native (and our target `halfvec`) width. */
export const DEFAULT_DIMS = 1536

/**
 * Inputs per request. OpenAI's hard cap is 2048; we stay well under it so a
 * single request never trips the per-request token ceiling on long transcripts.
 * Chunking is transparent — `embed()` reassembles results in input order.
 */
export const DEFAULT_BATCH_SIZE = 128

/** Minimal shape of the global fetch, so tests can inject a stub. */
type FetchImpl = typeof fetch

export interface OpenAiEmbeddingOptions {
  /** Overrides `process.env.OPENAI_API_KEY`. */
  apiKey?: string
  /** Defaults to `text-embedding-3-small`. */
  model?: string
  /**
   * Output width. Defaults to 1536. When set, a `dimensions` param is sent so
   * OpenAI truncates+renormalises server-side. Leave unset to keep the model's
   * native 1536 — the width the DB column and HNSW index are built for.
   */
  dims?: number
  /** Inputs per HTTP request. Defaults to {@link DEFAULT_BATCH_SIZE}. */
  batchSize?: number
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: FetchImpl
  /** Overridable for a proxy/gateway. Defaults to the public API. */
  baseUrl?: string
}

interface OpenAiEmbeddingItem {
  index: number
  embedding: number[]
}

interface OpenAiEmbeddingResponse {
  data: OpenAiEmbeddingItem[]
  model: string
  usage: { prompt_tokens: number; total_tokens: number }
}

/**
 * Split a request's total cost across its inputs proportionally to text length.
 *
 * The API gives one `total_tokens` for the whole request, not per input. Text
 * length is a good enough proxy for token share, and weighting this way makes
 * the split sum back to the request's true cost exactly (a single-item batch
 * therefore gets 100%). We deliberately do NOT dump the whole cost on the first
 * result and zero the rest: the orchestrator attributes cost per video, so a
 * per-video figure has to be honest even though the dollar amounts are tiny.
 */
export function splitCost(texts: readonly string[], totalTokens: number): number[] {
  const totalCost = (totalTokens / 1e6) * COST_PER_MILLION_TOKENS
  // max(len, 1): a whitespace/empty input still carries the request's fixed
  // per-item overhead and must never get a zero weight (which could NaN the split).
  const weights = texts.map((t) => Math.max(t.length, 1))
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => (totalCost * w) / totalWeight)
}

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai-embeddings'
  readonly dims: number

  private readonly apiKey: string | undefined
  private readonly model: string
  private readonly batchSize: number
  private readonly fetchImpl: FetchImpl
  private readonly baseUrl: string
  /** Only send a `dimensions` param when the caller narrowed it explicitly. */
  private readonly sendDimensions: boolean

  constructor(opts: OpenAiEmbeddingOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
    this.model = opts.model ?? 'text-embedding-3-small'
    this.dims = opts.dims ?? DEFAULT_DIMS
    this.sendDimensions = opts.dims !== undefined
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com'
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return []

    if (!this.apiKey) {
      throw new ProviderError('OPENAI_API_KEY is not set', this.name, false)
    }

    const results: EmbeddingResult[] = []
    for (const batch of chunk(texts, this.batchSize)) {
      results.push(...(await this.embedBatch(batch)))
    }
    return results
  }

  private async embedBatch(batch: string[]): Promise<EmbeddingResult[]> {
    const body: Record<string, unknown> = { model: this.model, input: batch }
    if (this.sendDimensions) body.dimensions = this.dims

    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      // Network-layer failure: nothing was billed, and it is worth a retry.
      throw new ProviderError(
        `embeddings request failed: ${(err as Error).message}`,
        this.name,
        true,
        0
      )
    }

    if (!res.ok) {
      // 429 (rate limit) and 5xx are transient; 4xx (bad key, bad input) is not.
      const retryable = res.status === 429 || res.status >= 500
      const detail = await safeErrorMessage(res)
      throw new ProviderError(
        `embeddings request failed: ${res.status}${detail ? ` — ${detail}` : ''}`,
        this.name,
        retryable,
        0
      )
    }

    const json = (await res.json()) as OpenAiEmbeddingResponse
    if (!json || !Array.isArray(json.data)) {
      throw new ProviderError('embeddings response missing data[]', this.name, false, 0)
    }

    // OpenAI documents that `data` MAY be returned out of order — each item
    // carries its own `index`. Align by index, never by array position, or the
    // whole downstream video↔vector mapping silently corrupts.
    const byIndex = [...json.data].sort((a, b) => a.index - b.index)
    if (byIndex.length !== batch.length) {
      throw new ProviderError(
        `expected ${batch.length} embeddings, got ${byIndex.length}`,
        this.name,
        false,
        0
      )
    }

    const model = json.model ?? this.model
    const costs = splitCost(batch, json.usage?.total_tokens ?? 0)

    return byIndex.map((item, i) => {
      const vector = item.embedding
      return {
        vector,
        dims: vector.length,
        model,
        costUsd: costs[i]!,
      }
    })
  }
}

async function safeErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    return body?.error?.message ?? null
  } catch {
    return null
  }
}
