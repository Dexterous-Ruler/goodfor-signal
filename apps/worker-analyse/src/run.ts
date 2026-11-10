/**
 * Read-plane analysis orchestrator (Phase 2 "Understand").
 *
 * This is the worker the dashboard's Formats & hooks page already names
 * (`apps/dashboard/app/formats/page.tsx` → `npx tsx apps/worker-analyse/src/run.ts
 * --enqueue`). It drains `analysis_queue`, spends the five providers built in
 * `packages/{media,asr,vision,embeddings,clustering}`, and writes `video_analysis`
 * / `format_cluster` — the rows `getHookPerformance` / `getFormats` /
 * `getAnalysisProgress` read.
 *
 * MODES (via process.argv, mirroring apps/worker-read/src/tick.ts):
 *   (default)      drain loop — setInterval, plus --once for a single pass.
 *   --enqueue      corpus feeder: insert corpus-worthy videos (reason='corpus').
 *   --refit        weekly BERTopic re-fit + cluster labels.
 *   --assign       daily approximate_predict for newly-analysed videos.
 *   --poll-batch   reconcile Gemini Batch jobs; re-submit the 48h-expired ones.
 *
 * TWO LANES, keyed on `analysis_queue.reason` (PHASE-2-understand.md §6.3):
 *   reason='alert'  → SYNC Gemini (`vision.analyse`), cleared now — latency lane.
 *   otherwise       → Gemini BATCH (`vision.submitBatch`, 50% off) — corpus lane,
 *                     tracked in `vision_batch_job`; results applied by --poll-batch.
 *
 * COST DISCIPLINE. Vision is the only expensive step. So the sync pipeline treats
 * media/vision/db as HARD failures (respect ProviderError.retryable — a retryable
 * failure is left pending, a permanent one is completed with `last_error`) but ASR,
 * embeddings and dedupe as SOFT: once vision is PAID FOR, a hiccup in a cheaper
 * step must never discard the row and force a re-pay — it degrades and lands in
 * `video_analysis.analysis_errors`.
 *
 * Every external side effect goes through injected providers + the db client, so
 * `run.test.ts` mocks all I/O (no live keys, no ffmpeg, no python, no network).
 */

import { resolve } from 'node:path'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { db, loadEnv, type Db, type Database } from '@goodfor/db'
import {
  ProviderError,
  toPgVector,
  type MediaProvider,
  type AsrProvider,
  type EmbeddingProvider,
  type DedupeProvider,
  type MediaBundle,
  type Transcript,
  type VisionAnalysis,
  type VideoFingerprint,
} from '@goodfor/contracts'
import { FfmpegMediaProvider } from '@goodfor/media'
import { GroqAsrProvider } from '@goodfor/asr'
import { GeminiVisionProvider } from '@goodfor/vision'
import { OpenAiEmbeddingProvider } from '@goodfor/embeddings'
import { VpdqDedupeProvider, BertopicClusterer, type ClusterEmbeddingItem } from '@goodfor/clustering'
import { createSource, type TikTokSource } from '@goodfor/tiktok-source'
import { assertReadPlane } from './guard.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Poll cadence for the drain loop — matches worker-read's tick. */
const TICK_MS = 60_000
/** Queue rows pulled per drain pass. */
const DRAIN_BATCH = 20
/** How many recent fingerprints to compare a fresh clip against for dedupe. */
const RECENT_CORPUS_LIMIT = 500
/** The hook window — words spoken before this offset (seconds). */
const HOOK_WINDOW_S = 3.0
/** PostgREST `.in()` filters have a practical URL-length ceiling. */
const IN_CHUNK = 100

// ---------------------------------------------------------------------------
// Table row/insert aliases
// ---------------------------------------------------------------------------

type VideoAnalysisInsert = Database['public']['Tables']['video_analysis']['Insert']
type VisionBatchInsert = Database['public']['Tables']['vision_batch_job']['Insert']
type FormatClusterInsert = Database['public']['Tables']['format_cluster']['Insert']

/** The subset of an `analysis_queue` row the drain needs. */
export interface QueueRow {
  video_id: number
  priority: number
  reason: string | null
  attempts: number
}

/** The subset of a `tracked_video` row needed to resolve + label a clip. */
export interface VideoRow {
  id: number
  platform_video_id: string
  description: string | null
  duration_s: number | null
  /** Owning account handle — reconstructs the tiktok.com URL for a fresh media re-fetch. */
  username: string | null
}

// ---------------------------------------------------------------------------
// Dependency bag — everything injectable, so the test never touches real I/O
// ---------------------------------------------------------------------------

export interface AnalyseDeps {
  client: Db
  media: MediaProvider
  asr: AsrProvider
  /** Concrete type: the batch surface (submitBatch/fetchBatch) is not on VisionProvider. */
  vision: GeminiVisionProvider
  embeddings: EmbeddingProvider
  dedupe: DedupeProvider
  clusterer: BertopicClusterer
  /** Read-plane vendor used to re-fetch a FRESH media URL per clip. Defaults to {@link createSource}. */
  source?: TikTokSource
  /**
   * Resolve a fetchable media URL for a tracked video. When omitted, the drain
   * uses {@link resolvePlayableUrlLive} (stored/templated URL, else a fresh
   * getPostMedia fetch). Tests inject a sync stub. May be sync or async.
   */
  resolveUrl?: (video: VideoRow) => string | null | Promise<string | null>
  /** Clock, injected for deterministic --poll-batch tests. */
  now?: () => Date
  /** Gemini key for cluster labelling; falls back to env. */
  geminiApiKey?: string | null
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

/** Construct the real providers + service-role client once (mirrors tick.ts main). */
export function makeDeps(overrides: Partial<AnalyseDeps> = {}): AnalyseDeps {
  return {
    client: overrides.client ?? db(),
    media: overrides.media ?? new FfmpegMediaProvider(),
    asr: overrides.asr ?? new GroqAsrProvider(),
    vision: overrides.vision ?? new GeminiVisionProvider(),
    embeddings: overrides.embeddings ?? new OpenAiEmbeddingProvider(),
    dedupe: overrides.dedupe ?? new VpdqDedupeProvider(),
    clusterer: overrides.clusterer ?? new BertopicClusterer(),
    source: overrides.source,
    resolveUrl: overrides.resolveUrl,
    now: overrides.now,
    geminiApiKey: overrides.geminiApiKey,
    logger: overrides.logger ?? console,
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function nowDate(deps: AnalyseDeps): Date {
  return deps.now?.() ?? new Date()
}

function log(deps: AnalyseDeps): Pick<Console, 'log' | 'warn' | 'error'> {
  return deps.logger ?? console
}

function errMsg(prefix: string | null, err: unknown): string {
  const base = err instanceof Error ? err.message : String(err)
  return prefix ? `${prefix}: ${base}` : base
}

/** cost_usd is numeric(10,6). */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function isRetryable(err: unknown): boolean {
  return err instanceof ProviderError ? err.retryable : false
}

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/**
 * Resolve a fetchable media URL for a tracked video.
 *
 * `tracked_video` has NO media/URL column (see database.types.ts) and TikTok CDN
 * URLs are signed + ephemeral, so nothing is derivable for a FixtureSource clip:
 * we return null and the drain records the reason and skips gracefully (README
 * gap #1 — a live vendor that returns a play URL — must be closed for real
 * analysis). A deployment that DOES persist/derive one can point
 * `TIKTOK_MEDIA_URL_TEMPLATE` (containing `{id}`) at it without touching code.
 */
export function resolvePlayableUrl(
  video: Pick<VideoRow, 'platform_video_id'>,
  env: Record<string, string | undefined> = process.env
): string | null {
  const id = video.platform_video_id
  if (!id) return null
  if (id.startsWith('fixture_')) return null // FixtureSource — no downloadable media
  const template = env.TIKTOK_MEDIA_URL_TEMPLATE
  if (template && template.includes('{id}')) {
    return template.replace('{id}', encodeURIComponent(id))
  }
  return null
}

/** Canonical post URL used to re-fetch fresh media (EnsembleData's /tt/post/info key). */
export function tiktokPostUrl(username: string, platformVideoId: string): string {
  return `https://www.tiktok.com/@${username}/video/${platformVideoId}`
}

/**
 * Resolve a playable URL for a real tracked video, closing README gap #1.
 *
 * A stored/templated URL wins when configured (see {@link resolvePlayableUrl}).
 * Otherwise — because TikTok CDN URLs are signed + ephemeral, so a URL captured
 * at poll time is stale by analysis time — we re-fetch a FRESH one from the read
 * -plane vendor by the post's canonical URL. This is ~1 unit and runs only for
 * the handful of videos actually queued for analysis, never bulk metric polling.
 * Fixtures (and any vendor miss) return null and the drain skips gracefully.
 */
export async function resolvePlayableUrlLive(
  video: VideoRow,
  deps: Pick<AnalyseDeps, 'source' | 'logger'>,
  env: Record<string, string | undefined> = process.env
): Promise<string | null> {
  const stored = resolvePlayableUrl(video, env)
  if (stored) return stored
  if (video.platform_video_id.startsWith('fixture_') || !video.username) return null
  const source = deps.source ?? createSource()
  try {
    const media = await source.getPostMedia(tiktokPostUrl(video.username, video.platform_video_id))
    return media?.mediaUrl ?? null
  } catch (err) {
    deps.logger?.warn?.(
      `[analyse] getPostMedia failed for ${video.platform_video_id}: ${(err as Error).message}`
    )
    return null
  }
}

/** Drain call sites: honour an injected `resolveUrl`, else the live resolver. */
function resolveMediaUrl(deps: AnalyseDeps, video: VideoRow): Promise<string | null> {
  return Promise.resolve(deps.resolveUrl ? deps.resolveUrl(video) : resolvePlayableUrlLive(video, deps))
}

/** halfvec comes back from PostgREST as a "[a,b,…]" string; parse to number[]. */
export function parsePgVector(v: unknown): number[] | null {
  if (Array.isArray(v)) return v.map(Number).filter((n) => Number.isFinite(n))
  if (typeof v !== 'string') return null
  const s = v.trim()
  const body = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
  if (!body.trim()) return []
  const out: number[] = []
  for (const part of body.split(',')) {
    const n = Number(part)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/**
 * bytea round-trip. PostgREST's default `bytea_output = hex` returns `\x<hex>`;
 * we write the same literal. (Flagged for live verification — some gateways
 * hand bytea back base64, which the reader falls through to.)
 */
export function bufferToPgBytea(buf: Buffer): string {
  return '\\x' + buf.toString('hex')
}

export function pgByteaToBuffer(v: unknown): Buffer | null {
  if (v == null) return null
  if (Buffer.isBuffer(v)) return v
  if (typeof v !== 'string') return null
  if (v.startsWith('\\x')) {
    try {
      return Buffer.from(v.slice(2), 'hex')
    } catch {
      return null
    }
  }
  try {
    return Buffer.from(v, 'base64')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// analysis_queue transitions
// ---------------------------------------------------------------------------

async function complete(deps: AnalyseDeps, row: QueueRow): Promise<void> {
  await deps.client
    .from('analysis_queue')
    .update({ completed_at: nowDate(deps).toISOString(), last_error: null })
    .eq('video_id', row.video_id)
}

/**
 * A failure. Bump attempts + record last_error. A RETRYABLE ProviderError is
 * left pending (completed_at stays null → next drain retries); anything else is
 * completed so a permanent error never spins the queue.
 */
async function recordFailure(deps: AnalyseDeps, row: QueueRow, err: unknown): Promise<void> {
  const update: Database['public']['Tables']['analysis_queue']['Update'] = {
    attempts: (row.attempts ?? 0) + 1,
    last_error: errMsg(null, err).slice(0, 500),
  }
  if (!isRetryable(err)) update.completed_at = nowDate(deps).toISOString()
  await deps.client.from('analysis_queue').update(update).eq('video_id', row.video_id)
}

/** A permanent skip (no playable URL, missing video): record + complete. */
async function skip(deps: AnalyseDeps, row: QueueRow, reason: string): Promise<void> {
  await deps.client
    .from('analysis_queue')
    .update({
      attempts: (row.attempts ?? 0) + 1,
      last_error: reason,
      completed_at: nowDate(deps).toISOString(),
    })
    .eq('video_id', row.video_id)
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

async function loadPending(deps: AnalyseDeps, limit: number): Promise<QueueRow[]> {
  const { data, error } = await deps.client
    .from('analysis_queue')
    .select('video_id, priority, reason, attempts')
    .is('completed_at', null)
    .order('priority', { ascending: true })
    .order('enqueued_at', { ascending: true })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as QueueRow[]
}

async function loadVideos(deps: AnalyseDeps, ids: number[]): Promise<Map<number, VideoRow>> {
  const byId = new Map<number, VideoRow>()
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await deps.client
      .from('tracked_video')
      .select('id, platform_video_id, description, duration_s, competitor_account(username)')
      .in('id', part)
    if (error) throw error
    for (const v of data ?? []) {
      // PostgREST returns the embedded FK row as an object (or array under some configs).
      const acct = (v as { competitor_account?: { username?: string } | { username?: string }[] })
        .competitor_account
      const username = Array.isArray(acct) ? (acct[0]?.username ?? null) : (acct?.username ?? null)
      byId.set(v.id, {
        id: v.id,
        platform_video_id: v.platform_video_id,
        description: v.description,
        duration_s: v.duration_s,
        username,
      })
    }
  }
  return byId
}

/** Recent serialised fingerprints to dedupe a fresh clip against. */
async function loadRecentCorpus(deps: AnalyseDeps, limit: number): Promise<VideoFingerprint[]> {
  const { data, error } = await deps.client
    .from('video_analysis')
    .select('video_id, phash_frames')
    .not('phash_frames', 'is', null)
    .order('analysed_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  const out: VideoFingerprint[] = []
  for (const r of (data ?? []) as { video_id: number; phash_frames: unknown }[]) {
    const buf = pgByteaToBuffer(r.phash_frames)
    if (!buf) continue
    try {
      out.push(deps.dedupe.deserialise(r.video_id, buf))
    } catch {
      /* corrupt row — ignore for corpus */
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// DRAIN
// ---------------------------------------------------------------------------

export interface DrainSummary {
  processed: number
  alerts: number
  batched: number
}

export async function drainOnce(deps: AnalyseDeps): Promise<DrainSummary> {
  const rows = await loadPending(deps, DRAIN_BATCH)
  if (rows.length === 0) {
    log(deps).log('[analyse] nothing pending')
    return { processed: 0, alerts: 0, batched: 0 }
  }

  const byId = await loadVideos(
    deps,
    rows.map((r) => r.video_id)
  )
  const alertRows = rows.filter((r) => r.reason === 'alert')
  const batchRows = rows.filter((r) => r.reason !== 'alert')

  // Only the sync lane needs a dedupe corpus; load it once.
  const corpus = alertRows.length > 0 ? await loadRecentCorpus(deps, RECENT_CORPUS_LIMIT) : []

  for (const row of alertRows) {
    const video = byId.get(row.video_id)
    if (!video) {
      await skip(deps, row, 'tracked_video not found')
      continue
    }
    await processAlert(deps, row, video, corpus)
  }

  await processBatchLane(deps, batchRows, byId)

  log(deps).log(
    `[analyse] drained ${rows.length} (${alertRows.length} sync, ${batchRows.length} batch)`
  )
  return { processed: rows.length, alerts: alertRows.length, batched: batchRows.length }
}

/**
 * SYNC lane (reason='alert'): full pipeline, video_analysis written now.
 * media(extract) → asr → vision.analyse → embed → dedupe → write → complete.
 */
async function processAlert(
  deps: AnalyseDeps,
  row: QueueRow,
  video: VideoRow,
  corpus: VideoFingerprint[]
): Promise<void> {
  const url = await resolveMediaUrl(deps, video)
  if (!url) {
    await skip(deps, row, 'no playable URL (resolvePlayableUrlLive returned null)')
    return
  }

  const workDir = join(tmpdir(), 'goodfor-analyse', `${video.id}-${Date.now()}`)
  const errors: string[] = []
  let bundle: MediaBundle | null = null

  // Media — HARD.
  try {
    const localPath = await deps.media.fetch(url, workDir)
    bundle = await deps.media.extract(localPath, video.id, workDir)
  } catch (err) {
    await recordFailure(deps, row, err)
    return
  }

  try {
    // ASR — SOFT (Gemini reads audio natively; a null transcript degrades, not fails).
    let transcript: Transcript | null = null
    if (bundle.audioPath) {
      try {
        transcript = await deps.asr.transcribe(bundle.audioPath)
      } catch (err) {
        errors.push(errMsg('asr', err))
      }
    }

    // Vision — HARD (the whole product; model_version is NOT NULL).
    let vision: VisionAnalysis
    try {
      vision = await deps.vision.analyse(bundle, transcript)
    } catch (err) {
      await recordFailure(deps, row, err)
      return
    }

    // Embedding — SOFT (vision already paid; never re-pay it for an embed hiccup).
    let vector: number[] | null = null
    let embCost = 0
    const embedInput = [transcript?.text ?? '', vision.formatSummary]
      .filter((s) => s && s.trim())
      .join(' ')
      .trim()
    if (embedInput) {
      try {
        const [e] = await deps.embeddings.embed([embedInput])
        if (e) {
          vector = e.vector
          embCost = e.costUsd
        }
      } catch (err) {
        errors.push(errMsg('embeddings', err))
      }
    }

    // Dedupe — SOFT (repost detection is a bonus; python missing must not block).
    let fp: VideoFingerprint | null = null
    let duplicateOf: number | null = null
    try {
      fp = await deps.dedupe.fingerprint(bundle)
      const matches = deps.dedupe.findDuplicates(fp, corpus)
      duplicateOf = matches[0]?.videoId ?? null
    } catch (err) {
      errors.push(errMsg('dedupe', err))
    }

    const costUsd = (transcript?.costUsd ?? 0) + vision.costUsd + embCost
    const record = buildAnalysisRecord({
      videoId: video.id,
      vision,
      transcript,
      vector,
      fp,
      dedupe: deps.dedupe,
      duplicateOf,
      costUsd,
      errors,
    })

    const { error: wErr } = await deps.client
      .from('video_analysis')
      .upsert(record, { onConflict: 'video_id' })
    if (wErr) {
      await recordFailure(deps, row, wErr)
      return
    }
    await complete(deps, row)
  } finally {
    if (bundle) {
      try {
        await deps.media.cleanup(bundle)
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Assemble the full video_analysis row from a synchronous VisionAnalysis. */
function buildAnalysisRecord(args: {
  videoId: number
  vision: VisionAnalysis
  transcript: Transcript | null
  vector: number[] | null
  fp: VideoFingerprint | null
  dedupe: DedupeProvider
  duplicateOf: number | null
  costUsd: number
  errors: string[]
}): VideoAnalysisInsert {
  const { vision, transcript } = args
  const hookWords = transcript ? transcript.words.filter((w) => w.start < HOOK_WINDOW_S) : null
  const record: VideoAnalysisInsert = {
    video_id: args.videoId,
    hook_type: vision.hookType,
    hook_text_sequence: vision.hookTextSequence as unknown as VideoAnalysisInsert['hook_text_sequence'],
    spoken_hook: vision.spokenHook ?? transcript?.hookText ?? null,
    spoken_hook_words: hookWords as unknown as VideoAnalysisInsert['spoken_hook_words'],
    transcript: transcript?.text ?? null,
    face_present: vision.facePresent,
    face_screen_fraction: vision.faceScreenFraction,
    cut_count_first_3s: vision.cutCountFirst3s,
    caption_style: vision.captionStyle,
    audio_type: vision.audioType,
    format_summary: vision.formatSummary,
    model_version: vision.modelVersion,
    phash_frames: args.fp ? bufferToPgBytea(args.dedupe.serialise(args.fp)) : null,
    duplicate_of_video_id: args.duplicateOf,
    cost_usd: round6(args.costUsd),
    analysis_errors: args.errors.length ? args.errors : null,
  }
  if (args.vector) record.embedding = toPgVector(args.vector)
  return record
}

/**
 * BATCH lane (reason≠'alert'): extract each clip, submit ONE Gemini Batch job
 * over all of them (array signature, 50% off), record it in vision_batch_job,
 * and complete the queue rows. The video_analysis rows land later, when
 * --poll-batch reconciles the finished job.
 */
async function processBatchLane(
  deps: AnalyseDeps,
  rows: QueueRow[],
  byId: Map<number, VideoRow>
): Promise<void> {
  if (rows.length === 0) return

  const collected: { row: QueueRow; bundle: MediaBundle }[] = []
  for (const row of rows) {
    const video = byId.get(row.video_id)
    if (!video) {
      await skip(deps, row, 'tracked_video not found')
      continue
    }
    const url = await resolveMediaUrl(deps, video)
    if (!url) {
      await skip(deps, row, 'no playable URL (resolvePlayableUrlLive returned null)')
      continue
    }
    const workDir = join(tmpdir(), 'goodfor-analyse', `${video.id}-${Date.now()}`)
    try {
      const localPath = await deps.media.fetch(url, workDir)
      const bundle = await deps.media.extract(localPath, video.id, workDir)
      collected.push({ row, bundle })
    } catch (err) {
      await recordFailure(deps, row, err)
    }
  }

  if (collected.length === 0) return

  const videoIds = collected.map((c) => c.bundle.videoId)
  const bundles = collected.map((c) => c.bundle)
  try {
    const job = await deps.vision.submitBatch(videoIds, bundles)
    const insert: VisionBatchInsert = {
      id: job.id,
      video_ids: job.videoIds,
      submitted_at: job.submittedAt.toISOString(),
      expires_at: job.expiresAt.toISOString(),
      status: 'pending',
    }
    const { error } = await deps.client.from('vision_batch_job').insert(insert)
    if (error) throw error
    for (const c of collected) await complete(deps, c.row)
    log(deps).log(`[analyse] batch ${job.id}: submitted ${videoIds.length} video(s)`)
  } catch (err) {
    for (const c of collected) await recordFailure(deps, c.row, err)
  } finally {
    for (const c of collected) {
      try {
        await deps.media.cleanup(c.bundle)
      } catch {
        /* best-effort */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// --enqueue : corpus feeder
// ---------------------------------------------------------------------------

/**
 * Insert corpus-worthy videos into `analysis_queue` (reason='corpus', priority=5)
 * ON CONFLICT (video_id) DO NOTHING. Any video with an existing queue row —
 * pending OR completed — is left untouched (video_id is the PK), so already-seen
 * videos are never re-enqueued.
 */
export async function enqueueCorpus(deps: AnalyseDeps): Promise<number> {
  const { data, error } = await deps.client
    .from('tracked_video')
    .select('id')
    .eq('tracking_active', true)
    .limit(20000)
  if (error) throw error

  const ids = (data ?? []).map((r) => (r as { id: number }).id)
  if (ids.length === 0) return 0

  const rows: Database['public']['Tables']['analysis_queue']['Insert'][] = ids.map((id) => ({
    video_id: id,
    reason: 'corpus',
    priority: 5,
  }))

  const { error: insErr } = await deps.client
    .from('analysis_queue')
    .upsert(rows, { onConflict: 'video_id', ignoreDuplicates: true })
  if (insErr) throw insErr

  log(deps).log(`[analyse] enqueue: offered ${rows.length} video(s) (existing rows kept)`)
  return rows.length
}

// ---------------------------------------------------------------------------
// Clustering: --refit (weekly) / --assign (daily)
// ---------------------------------------------------------------------------

async function loadEmbeddings(
  deps: AnalyseDeps,
  opts: { onlyUnclustered: boolean }
): Promise<ClusterEmbeddingItem[]> {
  let q = deps.client
    .from('video_analysis')
    .select('video_id, embedding')
    .not('embedding', 'is', null)
  if (opts.onlyUnclustered) q = q.is('format_cluster_id', null)
  const { data, error } = await q.limit(50000)
  if (error) throw error

  const items: ClusterEmbeddingItem[] = []
  for (const r of (data ?? []) as { video_id: number; embedding: unknown }[]) {
    const vec = parsePgVector(r.embedding)
    if (vec && vec.length > 0) items.push({ videoId: r.video_id, embedding: vec })
  }
  return items
}

/** Group assignments by cluster and update video_analysis.format_cluster_id in chunks. */
async function applyAssignments(
  deps: AnalyseDeps,
  assignments: { videoId: number; clusterId: number }[]
): Promise<void> {
  const byCluster = new Map<number, number[]>()
  for (const a of assignments) {
    const list = byCluster.get(a.clusterId) ?? []
    list.push(a.videoId)
    byCluster.set(a.clusterId, list)
  }
  for (const [clusterId, ids] of byCluster) {
    for (const part of chunk(ids, IN_CHUNK)) {
      const { error } = await deps.client
        .from('video_analysis')
        .update({ format_cluster_id: clusterId })
        .in('video_id', part)
      if (error) throw error
    }
  }
}

async function loadSummaries(deps: AnalyseDeps, videoIds: number[]): Promise<string[]> {
  if (videoIds.length === 0) return []
  const { data, error } = await deps.client
    .from('video_analysis')
    .select('format_summary')
    .in('video_id', videoIds.slice(0, IN_CHUNK))
    .not('format_summary', 'is', null)
  if (error) throw error
  return (data ?? [])
    .map((r) => (r as { format_summary: string | null }).format_summary)
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
}

/**
 * Weekly BERTopic re-fit. Pull the whole corpus's fixed embeddings, re-fit
 * UMAP→HDBSCAN in the python sidecar, upsert one `format_cluster` per cluster
 * (id = -1 is the outlier / novel-format bucket), and re-assign every video.
 * Cluster labels come from Gemini when a key exists, else a placeholder.
 */
export async function refit(deps: AnalyseDeps): Promise<{ clusters: number; assigned: number }> {
  const items = await loadEmbeddings(deps, { onlyUnclustered: false })
  if (items.length === 0) {
    log(deps).log('[analyse] refit: no embeddings yet')
    return { clusters: 0, assigned: 0 }
  }

  const { clusters, assignments } = await deps.clusterer.refit(items)

  for (const c of clusters) {
    let label = `Cluster ${c.id}`
    let definition: string | null = null
    if (c.id === -1) {
      label = 'novel / unclustered'
    } else {
      const summaries = await loadSummaries(deps, c.representativeVideoIds)
      const labelled = await labelCluster(deps, summaries)
      if (labelled) {
        label = labelled.label
        definition = labelled.definition
      }
    }
    const row: FormatClusterInsert = {
      id: c.id,
      label,
      definition,
      member_count: c.memberVideoIds.length,
      updated_at: nowDate(deps).toISOString(),
    }
    const { error } = await deps.client.from('format_cluster').upsert(row, { onConflict: 'id' })
    if (error) throw error
  }

  await applyAssignments(deps, assignments)
  log(deps).log(`[analyse] refit: ${clusters.length} cluster(s), ${assignments.length} assigned`)
  return { clusters: clusters.length, assigned: assignments.length }
}

/** Daily approximate_predict for videos analysed since the last refit. */
export async function assign(deps: AnalyseDeps): Promise<{ assigned: number }> {
  const items = await loadEmbeddings(deps, { onlyUnclustered: true })
  if (items.length === 0) {
    log(deps).log('[analyse] assign: nothing new to assign')
    return { assigned: 0 }
  }
  const assignments = await deps.clusterer.assign(items)
  await applyAssignments(deps, assignments)
  log(deps).log(`[analyse] assign: ${assignments.length} video(s)`)
  return { assigned: assignments.length }
}

/**
 * Best-effort cluster label via one Gemini 2.5 Flash call (~$0.05/week for the
 * whole taxonomy). No key → null → the caller stores a placeholder. Any failure
 * degrades to null; labelling never blocks a refit. NOTE: written from the
 * generateContent shape — verify against a live key before trusting labels.
 */
async function labelCluster(
  deps: AnalyseDeps,
  summaries: string[]
): Promise<{ label: string; definition: string | null } | null> {
  const key =
    deps.geminiApiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? null
  if (!key || summaries.length === 0) return null

  const prompt =
    'You are naming a cluster of short-form video FORMATS (structure, not topic). ' +
    'Given these per-video format summaries, return JSON {"label","definition"}: a ' +
    'label of at most 6 words and a one-sentence definition.\n\n' +
    summaries
      .slice(0, 20)
      .map((s, i) => `${i + 1}. ${s}`)
      .join('\n')

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        }),
      }
    )
    if (!res.ok) return null
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p?.text ?? '')
      .join('')
      .trim()
    if (!text) return null
    const parsed = JSON.parse(text) as { label?: unknown; definition?: unknown }
    const label = String(parsed.label ?? '').trim().slice(0, 80)
    if (!label) return null
    const definition =
      typeof parsed.definition === 'string' && parsed.definition.trim()
        ? parsed.definition.trim()
        : null
    return { label, definition }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// --poll-batch : reconcile finished jobs + re-submit the 48h-expired ones
// ---------------------------------------------------------------------------

interface BatchJobRow {
  id: string
  video_ids: number[]
  status: string
}

export interface PollBatchSummary {
  reconciled: number
  expired: number
  resubmitted: number
}

/**
 * (1) Reconcile still-live pending jobs — fetch each, apply results when done.
 * (2) Expire + re-submit jobs past their 48h window: mark 'expired', then
 *     re-submit ONLY the still-unanalysed video_ids as a fresh job with
 *     resubmit_of set — already-analysed videos are never re-charged.
 */
export async function pollBatch(deps: AnalyseDeps): Promise<PollBatchSummary> {
  const nowIso = nowDate(deps).toISOString()

  // (1) Live jobs — reconcile finished ones.
  let reconciled = 0
  const { data: live, error: e1 } = await deps.client
    .from('vision_batch_job')
    .select('id, video_ids, status')
    .eq('status', 'pending')
    .gte('expires_at', nowIso)
  if (e1) throw e1
  for (const job of (live ?? []) as BatchJobRow[]) {
    if (await reconcileJob(deps, job)) reconciled++
  }

  // (2) Expired jobs — expire + re-submit the unanalysed remainder.
  const { data: expired, error: e2 } = await deps.client
    .from('vision_batch_job')
    .select('id, video_ids, status')
    .eq('status', 'pending')
    .lt('expires_at', nowIso)
  if (e2) throw e2

  let resubmitted = 0
  for (const job of (expired ?? []) as BatchJobRow[]) {
    await deps.client.from('vision_batch_job').update({ status: 'expired' }).eq('id', job.id)

    const unanalysed = await unanalysedIds(deps, job.video_ids)
    if (unanalysed.length === 0) continue

    const collected = await extractBundles(deps, unanalysed)
    if (collected.length === 0) continue

    try {
      const fresh = await deps.vision.submitBatch(
        collected.map((c) => c.videoId),
        collected.map((c) => c.bundle)
      )
      const insert: VisionBatchInsert = {
        id: fresh.id,
        video_ids: fresh.videoIds,
        submitted_at: fresh.submittedAt.toISOString(),
        expires_at: fresh.expiresAt.toISOString(),
        status: 'pending',
        resubmit_of: job.id,
      }
      const { error } = await deps.client.from('vision_batch_job').insert(insert)
      if (error) throw error
      resubmitted++
      log(deps).log(
        `[analyse] poll-batch: ${job.id} expired → re-submitted ${fresh.videoIds.length} as ${fresh.id}`
      )
    } catch (err) {
      log(deps).error(`[analyse] poll-batch: re-submit for ${job.id} failed — ${errMsg(null, err)}`)
    } finally {
      for (const c of collected) {
        try {
          await deps.media.cleanup(c.bundle)
        } catch {
          /* best-effort */
        }
      }
    }
  }

  log(deps).log(
    `[analyse] poll-batch: reconciled ${reconciled}, expired ${(expired ?? []).length}, resubmitted ${resubmitted}`
  )
  return { reconciled, expired: (expired ?? []).length, resubmitted }
}

/** Video ids from `ids` that do NOT yet have an analysed (hook_type set) row. */
async function unanalysedIds(deps: AnalyseDeps, ids: number[]): Promise<number[]> {
  const analysed = new Set<number>()
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await deps.client
      .from('video_analysis')
      .select('video_id')
      .in('video_id', part)
      .not('hook_type', 'is', null)
    if (error) throw error
    for (const r of (data ?? []) as { video_id: number }[]) analysed.add(r.video_id)
  }
  return ids.filter((id) => !analysed.has(id))
}

/** Re-extract media bundles for a set of video ids (for batch re-submit). */
async function extractBundles(
  deps: AnalyseDeps,
  ids: number[]
): Promise<{ videoId: number; bundle: MediaBundle }[]> {
  const byId = await loadVideos(deps, ids)
  const out: { videoId: number; bundle: MediaBundle }[] = []
  for (const id of ids) {
    const video = byId.get(id)
    if (!video) continue
    const url = await resolveMediaUrl(deps, video)
    if (!url) continue
    const workDir = join(tmpdir(), 'goodfor-analyse', `resubmit-${id}-${Date.now()}`)
    try {
      const localPath = await deps.media.fetch(url, workDir)
      const bundle = await deps.media.extract(localPath, id, workDir)
      out.push({ videoId: id, bundle })
    } catch (err) {
      log(deps).warn(`[analyse] poll-batch: re-extract ${id} failed — ${errMsg(null, err)}`)
    }
  }
  return out
}

/**
 * Fetch one batch job; if it has finished, apply each VisionAnalysis to
 * video_analysis (embedding from format_summary — the corpus lane has no stored
 * transcript) and mark the job succeeded. Corpus rows do not get a dedupe
 * fingerprint here; that stays a sync-lane concern.
 */
async function reconcileJob(deps: AnalyseDeps, job: BatchJobRow): Promise<boolean> {
  let fetched
  try {
    fetched = await deps.vision.fetchBatch(job.id)
  } catch (err) {
    log(deps).warn(`[analyse] poll-batch: fetch ${job.id} failed — ${errMsg(null, err)}`)
    return false
  }

  if (fetched.status === 'pending') return false
  if (fetched.status === 'failed') {
    await deps.client.from('vision_batch_job').update({ status: 'failed' }).eq('id', job.id)
    return false
  }

  let cost = 0
  for (const r of fetched.results) {
    if (!r.analysis) continue
    const errors: string[] = []
    let vector: number[] | null = null
    let embCost = 0
    const input = r.analysis.formatSummary?.trim()
    if (input) {
      try {
        const [e] = await deps.embeddings.embed([input])
        if (e) {
          vector = e.vector
          embCost = e.costUsd
        }
      } catch (err) {
        errors.push(errMsg('embeddings', err))
      }
    }

    const record = buildAnalysisRecord({
      videoId: r.videoId,
      vision: r.analysis,
      transcript: null,
      vector,
      fp: null,
      dedupe: deps.dedupe,
      duplicateOf: null,
      costUsd: r.analysis.costUsd + embCost,
      errors,
    })
    const { error } = await deps.client
      .from('video_analysis')
      .upsert(record, { onConflict: 'video_id' })
    if (error) throw error
    cost += r.analysis.costUsd + embCost
  }

  await deps.client
    .from('vision_batch_job')
    .update({ status: 'succeeded', cost_usd: round6(cost) })
    .eq('id', job.id)
  return true
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Root .env.local first (monorepo), then app-local — mirrors the dashboard.
  loadEnv(resolve(process.cwd(), '..', '..'))
  loadEnv()
  assertReadPlane() // fail closed if a write-plane secret bled into the analyse process

  const argv = process.argv.slice(2)
  const deps = makeDeps()

  if (argv.includes('--enqueue')) {
    await enqueueCorpus(deps)
    return
  }
  if (argv.includes('--refit')) {
    await refit(deps)
    return
  }
  if (argv.includes('--assign')) {
    await assign(deps)
    return
  }
  if (argv.includes('--poll-batch')) {
    await pollBatch(deps)
    return
  }

  await drainOnce(deps)
  if (argv.includes('--once')) return

  console.log(`[analyse] entering loop, every ${TICK_MS / 1000}s. Ctrl-C to stop.`)
  setInterval(() => {
    drainOnce(deps).catch((e) => console.error('[analyse] error', e))
  }, TICK_MS)
}

// Only run when invoked directly (tsx run.ts …), never when imported by a test.
const invokedDirectly =
  typeof process.argv[1] === 'string' && /worker-analyse[\\/]src[\\/]run\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
