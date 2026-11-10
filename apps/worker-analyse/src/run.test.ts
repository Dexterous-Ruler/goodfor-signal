import { describe, it, expect, vi } from 'vitest'
import type { Db } from '@goodfor/db'
import type { MediaBundle, VisionAnalysis, Transcript } from '@goodfor/contracts'
import {
  drainOnce,
  pollBatch,
  resolvePlayableUrl,
  parsePgVector,
  bufferToPgBytea,
  pgByteaToBuffer,
  makeDeps,
  type AnalyseDeps,
} from './run.js'

// ---------------------------------------------------------------------------
// A tiny chainable mock of the supabase-js query builder.
//
// `from(table)` returns a thenable that records the whole call (table, kind,
// filters, payload) and resolves to whatever `router(op)` returns. Every op is
// pushed to `calls` so a test can assert what was written.
// ---------------------------------------------------------------------------

interface Op {
  table: string
  kind: 'select' | 'insert' | 'update' | 'upsert'
  select?: string
  payload?: any
  opts?: any
  filters: [string, string, unknown][]
}

type RouterResult = { data?: any; error?: any }

function mockDb(router: (op: Op) => RouterResult | void): { client: Db; calls: Op[] } {
  const calls: Op[] = []
  const client = {
    from(table: string) {
      const op: Op = { table, kind: 'select', filters: [] }
      const q: any = {}
      q.select = (sel?: string) => {
        op.select = sel
        return q
      }
      q.insert = (p: any) => {
        op.kind = 'insert'
        op.payload = p
        return q
      }
      q.update = (p: any) => {
        op.kind = 'update'
        op.payload = p
        return q
      }
      q.upsert = (p: any, o?: any) => {
        op.kind = 'upsert'
        op.payload = p
        op.opts = o
        return q
      }
      for (const m of ['eq', 'neq', 'in', 'is', 'not', 'gt', 'gte', 'lt', 'lte'] as const) {
        q[m] = (col: string, val: unknown) => {
          op.filters.push([m, col, val])
          return q
        }
      }
      q.order = () => q
      q.limit = () => q
      q.then = (resolve: any, reject: any) =>
        Promise.resolve()
          .then(() => {
            calls.push(op)
            return { data: null, error: null, ...(router(op) ?? {}) }
          })
          .then(resolve, reject)
      return q
    },
  }
  return { client: client as unknown as Db, calls }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBundle(videoId: number): MediaBundle {
  return {
    videoId,
    videoPath: `/tmp/v-${videoId}.mp4`,
    audioPath: `/tmp/a-${videoId}.wav`,
    keyframes: [],
    hookFrames: [],
    probe: { durationS: 20, width: 1080, height: 1920, fps: 30, hasAudio: true },
  }
}

const VISION: VisionAnalysis = {
  hookType: 'question',
  hookTextSequence: [{ tSeconds: 0, text: 'wait for it' }],
  spokenHook: 'wait for it',
  facePresent: true,
  faceScreenFraction: 0.3,
  cutCountFirst3s: 2,
  captionStyle: 'burned_in_subtitles',
  audioType: 'original_voiceover',
  formatSummary: 'talking head with burned-in captions',
  modelVersion: 'gemini-2.5-flash-x',
  costUsd: 0.0045,
}

const TRANSCRIPT: Transcript = {
  text: 'wait for it here is the whole thing',
  words: [
    { word: 'wait', start: 0.2, end: 0.5 },
    { word: 'for', start: 0.6, end: 0.8 },
    { word: 'it', start: 0.9, end: 1.1 },
    { word: 'here', start: 3.4, end: 3.6 }, // outside the 3s hook window
  ],
  language: 'en',
  hookText: 'wait for it',
  costUsd: 0.0001,
}

/** A provider bag of vi.fn spies; each test overrides only what it cares about. */
function makeProviders(over: Record<string, any> = {}) {
  return {
    media: {
      name: 'ffmpeg-mock',
      probe: vi.fn(),
      fetch: vi.fn(async () => '/tmp/dl.mp4'),
      extract: vi.fn(async (_p: string, id: number) => makeBundle(id)),
      cleanup: vi.fn(async () => {}),
      ...over.media,
    },
    asr: { name: 'asr-mock', transcribe: vi.fn(async () => TRANSCRIPT), ...over.asr },
    vision: {
      name: 'gemini-mock',
      model: 'gemini-2.5-flash',
      batchModel: 'gemini-3.1-flash-lite',
      analyse: vi.fn(async () => VISION),
      submitBatch: vi.fn(),
      fetchBatch: vi.fn(),
      ...over.vision,
    },
    embeddings: {
      name: 'emb-mock',
      dims: 2,
      embed: vi.fn(async () => [{ vector: [0.1, 0.2], dims: 2, model: 'm', costUsd: 1e-7 }]),
      ...over.embeddings,
    },
    dedupe: {
      name: 'vpdq-mock',
      fingerprint: vi.fn(async (b: MediaBundle) => ({ videoId: b.videoId, frames: [] })),
      findDuplicates: vi.fn(() => []),
      serialise: vi.fn(() => Buffer.from([1, 2, 3])),
      deserialise: vi.fn(),
      ...over.dedupe,
    },
    clusterer: { name: 'bertopic-mock', refit: vi.fn(), assign: vi.fn() },
  }
}

function makeTestDeps(
  client: Db,
  providers: ReturnType<typeof makeProviders>,
  extra: Partial<AnalyseDeps> = {}
): AnalyseDeps {
  return makeDeps({
    client,
    media: providers.media as any,
    asr: providers.asr as any,
    vision: providers.vision as any,
    embeddings: providers.embeddings as any,
    dedupe: providers.dedupe as any,
    clusterer: providers.clusterer as any,
    resolveUrl: () => 'http://cdn.example/v.mp4',
    now: () => new Date('2026-08-16T00:00:00Z'),
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    ...extra,
  })
}

// ---------------------------------------------------------------------------
// Lane decision — alert => sync analyse(), corpus => batch submitBatch()
// ---------------------------------------------------------------------------

describe('drainOnce lane decision', () => {
  it('alert (reason="alert") runs the SYNC lane and writes a full video_analysis row', async () => {
    const { client, calls } = mockDb((op) => {
      if (op.table === 'analysis_queue' && op.kind === 'select') {
        return { data: [{ video_id: 101, priority: 0, reason: 'alert', attempts: 0 }] }
      }
      if (op.table === 'tracked_video' && op.kind === 'select') {
        return { data: [{ id: 101, platform_video_id: 'tt_101', description: 'hi', duration_s: 20 }] }
      }
      if (op.table === 'video_analysis' && op.kind === 'select') {
        return { data: [] } // loadRecentCorpus → no corpus yet
      }
      return { data: null, error: null }
    })

    const providers = makeProviders()
    const deps = makeTestDeps(client, providers)

    const summary = await drainOnce(deps)

    expect(summary).toEqual({ processed: 1, alerts: 1, batched: 0 })
    // SYNC lane used, batch lane not touched.
    expect(providers.vision.analyse).toHaveBeenCalledTimes(1)
    expect(providers.vision.submitBatch).not.toHaveBeenCalled()

    // The full row was written to video_analysis.
    const write = calls.find((c) => c.table === 'video_analysis' && c.kind === 'upsert')
    expect(write).toBeTruthy()
    expect(write!.opts).toEqual({ onConflict: 'video_id' })
    expect(write!.payload.video_id).toBe(101)
    expect(write!.payload.hook_type).toBe('question')
    expect(write!.payload.model_version).toBe('gemini-2.5-flash-x')
    expect(write!.payload.format_summary).toBe(VISION.formatSummary)
    // embedding is written as the pgvector literal, not a JS array.
    expect(write!.payload.embedding).toBe('[0.1,0.2]')
    // cost_usd = asr + vision + embedding, all summed.
    expect(write!.payload.cost_usd).toBeCloseTo(0.0046, 6)
    // spoken_hook_words keeps only words inside the 3s hook window (drops "here").
    expect(write!.payload.spoken_hook_words).toHaveLength(3)
    // phash_frames is the serialised fingerprint as a bytea hex literal.
    expect(String(write!.payload.phash_frames)).toMatch(/^\\x/)

    // Queue row marked completed.
    const done = calls.find((c) => c.table === 'analysis_queue' && c.kind === 'update')
    expect(done!.payload.completed_at).toBeTruthy()
  })

  it('corpus (reason="corpus") runs the BATCH lane: submitBatch + a vision_batch_job row', async () => {
    const { client, calls } = mockDb((op) => {
      if (op.table === 'analysis_queue' && op.kind === 'select') {
        return { data: [{ video_id: 202, priority: 5, reason: 'corpus', attempts: 0 }] }
      }
      if (op.table === 'tracked_video' && op.kind === 'select') {
        return { data: [{ id: 202, platform_video_id: 'tt_202', description: null, duration_s: 30 }] }
      }
      return { data: null, error: null }
    })

    const providers = makeProviders({
      vision: {
        submitBatch: vi.fn(async (ids: number[]) => ({
          id: 'batches/job-1',
          status: 'pending',
          submittedAt: new Date('2026-08-16T00:00:00Z'),
          expiresAt: new Date('2026-08-18T00:00:00Z'),
          videoIds: [...ids],
          model: 'gemini-3.1-flash-lite',
        })),
      },
    })
    const deps = makeTestDeps(client, providers)

    const summary = await drainOnce(deps)

    expect(summary).toEqual({ processed: 1, alerts: 0, batched: 1 })
    // BATCH lane used, sync analyse() never called.
    expect(providers.vision.submitBatch).toHaveBeenCalledTimes(1)
    expect(providers.vision.submitBatch).toHaveBeenCalledWith([202], expect.any(Array))
    expect(providers.vision.analyse).not.toHaveBeenCalled()

    // A vision_batch_job row was recorded, and NO video_analysis row was written yet.
    const job = calls.find((c) => c.table === 'vision_batch_job' && c.kind === 'insert')
    expect(job).toBeTruthy()
    expect(job!.payload.id).toBe('batches/job-1')
    expect(job!.payload.video_ids).toEqual([202])
    expect(job!.payload.status).toBe('pending')
    expect(calls.some((c) => c.table === 'video_analysis' && c.kind === 'upsert')).toBe(false)

    // Queue row marked completed.
    const done = calls.find((c) => c.table === 'analysis_queue' && c.kind === 'update')
    expect(done!.payload.completed_at).toBeTruthy()
  })

  it('a video with no playable URL is skipped gracefully, not crashed', async () => {
    const { client, calls } = mockDb((op) => {
      if (op.table === 'analysis_queue' && op.kind === 'select') {
        return { data: [{ video_id: 9, priority: 0, reason: 'alert', attempts: 0 }] }
      }
      if (op.table === 'tracked_video' && op.kind === 'select') {
        return { data: [{ id: 9, platform_video_id: 'fixture_x', description: null, duration_s: 10 }] }
      }
      if (op.table === 'video_analysis' && op.kind === 'select') return { data: [] }
      return { data: null, error: null }
    })

    const providers = makeProviders()
    // Use the real resolver so the fixture id resolves to null.
    const deps = makeTestDeps(client, providers, { resolveUrl: undefined })

    await expect(drainOnce(deps)).resolves.toBeTruthy()
    expect(providers.media.extract).not.toHaveBeenCalled()
    const done = calls.find((c) => c.table === 'analysis_queue' && c.kind === 'update')
    expect(done!.payload.completed_at).toBeTruthy()
    expect(String(done!.payload.last_error)).toMatch(/no playable URL/)
  })
})

// ---------------------------------------------------------------------------
// --poll-batch expiry + re-submit (never re-charging analysed videos)
// ---------------------------------------------------------------------------

describe('pollBatch expiry / re-submit', () => {
  it('expires a 48h job and re-submits only the still-unanalysed videos', async () => {
    const { client, calls } = mockDb((op) => {
      if (op.table === 'vision_batch_job' && op.kind === 'select') {
        const expiredQuery = op.filters.some(([m, c]) => m === 'lt' && c === 'expires_at')
        if (expiredQuery) {
          return { data: [{ id: 'batches/old', video_ids: [1, 2, 3], status: 'pending' }] }
        }
        return { data: [] } // live (gte) reconcile query — nothing live
      }
      if (op.table === 'video_analysis' && op.kind === 'select') {
        // video 1 is already analysed (hook_type set); 2 and 3 are not.
        return { data: [{ video_id: 1 }] }
      }
      if (op.table === 'tracked_video' && op.kind === 'select') {
        return {
          data: [
            { id: 2, platform_video_id: 'tt_2', description: null, duration_s: 10 },
            { id: 3, platform_video_id: 'tt_3', description: null, duration_s: 10 },
          ],
        }
      }
      return { data: null, error: null }
    })

    const providers = makeProviders({
      vision: {
        fetchBatch: vi.fn(),
        submitBatch: vi.fn(async (ids: number[]) => ({
          id: 'batches/new',
          status: 'pending',
          submittedAt: new Date('2026-08-16T00:00:00Z'),
          expiresAt: new Date('2026-08-18T00:00:00Z'),
          videoIds: [...ids],
          model: 'gemini-3.1-flash-lite',
        })),
      },
    })
    const deps = makeTestDeps(client, providers)

    const summary = await pollBatch(deps)

    expect(summary).toEqual({ reconciled: 0, expired: 1, resubmitted: 1 })
    // No live jobs → fetchBatch never called.
    expect(providers.vision.fetchBatch).not.toHaveBeenCalled()

    // The expired job was marked expired.
    const expired = calls.find(
      (c) => c.table === 'vision_batch_job' && c.kind === 'update' && c.payload.status === 'expired'
    )
    expect(expired).toBeTruthy()
    expect(expired!.filters).toContainEqual(['eq', 'id', 'batches/old'])

    // Re-submit covered ONLY the unanalysed videos (2, 3) — video 1 is not re-charged.
    expect(providers.vision.submitBatch).toHaveBeenCalledTimes(1)
    expect(providers.vision.submitBatch).toHaveBeenCalledWith([2, 3], expect.any(Array))

    // The fresh job is linked back via resubmit_of.
    const resub = calls.find((c) => c.table === 'vision_batch_job' && c.kind === 'insert')
    expect(resub!.payload.id).toBe('batches/new')
    expect(resub!.payload.video_ids).toEqual([2, 3])
    expect(resub!.payload.resubmit_of).toBe('batches/old')
    expect(resub!.payload.status).toBe('pending')
  })

  it('applies a finished live job to video_analysis and marks it succeeded', async () => {
    const { client, calls } = mockDb((op) => {
      if (op.table === 'vision_batch_job' && op.kind === 'select') {
        const expiredQuery = op.filters.some(([m, c]) => m === 'lt' && c === 'expires_at')
        if (expiredQuery) return { data: [] } // nothing expired
        return { data: [{ id: 'batches/live', video_ids: [5], status: 'pending' }] }
      }
      return { data: null, error: null }
    })

    const providers = makeProviders({
      vision: {
        submitBatch: vi.fn(),
        fetchBatch: vi.fn(async () => ({
          id: 'batches/live',
          status: 'succeeded',
          results: [{ videoId: 5, analysis: VISION }],
        })),
      },
    })
    const deps = makeTestDeps(client, providers)

    const summary = await pollBatch(deps)

    expect(summary).toEqual({ reconciled: 1, expired: 0, resubmitted: 0 })
    expect(providers.vision.submitBatch).not.toHaveBeenCalled()

    // The batch result was applied to video_analysis…
    const write = calls.find((c) => c.table === 'video_analysis' && c.kind === 'upsert')
    expect(write!.payload.video_id).toBe(5)
    expect(write!.payload.hook_type).toBe('question')
    expect(write!.payload.embedding).toBe('[0.1,0.2]')

    // …and the job flipped to succeeded with a cost.
    const done = calls.find(
      (c) => c.table === 'vision_batch_job' && c.kind === 'update' && c.payload.status === 'succeeded'
    )
    expect(done).toBeTruthy()
    expect(done!.payload.cost_usd).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('resolvePlayableUrl', () => {
  it('returns null for a FixtureSource id (no downloadable media)', () => {
    expect(resolvePlayableUrl({ platform_video_id: 'fixture_acc_1' }, {})).toBeNull()
  })
  it('returns null when nothing maps a real id to a URL', () => {
    expect(resolvePlayableUrl({ platform_video_id: 'tt_123' }, {})).toBeNull()
  })
  it('uses a configured {id} template when one is provided', () => {
    expect(
      resolvePlayableUrl(
        { platform_video_id: 'tt_123' },
        { TIKTOK_MEDIA_URL_TEMPLATE: 'https://cdn.example/{id}.mp4' }
      )
    ).toBe('https://cdn.example/tt_123.mp4')
  })
})

describe('pgvector / bytea round-trips', () => {
  it('parses a pgvector literal to numbers', () => {
    expect(parsePgVector('[0.5,-1,2]')).toEqual([0.5, -1, 2])
    expect(parsePgVector('[]')).toEqual([])
    expect(parsePgVector([1, 2, 3])).toEqual([1, 2, 3])
    expect(parsePgVector(null)).toBeNull()
  })
  it('round-trips a bytea buffer through the hex literal', () => {
    const buf = Buffer.from([0, 1, 2, 255])
    const literal = bufferToPgBytea(buf)
    expect(literal).toBe('\\x000102ff')
    expect(pgByteaToBuffer(literal)!.equals(buf)).toBe(true)
  })
})
