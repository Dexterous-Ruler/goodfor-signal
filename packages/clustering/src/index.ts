/**
 * Clustering + near-duplicate detection.
 *
 * Two providers live here, both thin Node clients over a Python sidecar because
 * BERTopic/UMAP/HDBSCAN and PDQ have no first-class Node equivalent (PHASE-2
 * §4, completion.md §6.4):
 *
 *   - BertopicClusterer  — UMAP → HDBSCAN over FIXED embeddings. Embeddings are
 *     computed once in Node (OpenAI) and handed to Python as vectors, so a
 *     stochastic UMAP re-runs over the same input every week (random_state=42).
 *     Re-fit weekly, `approximate_predict` daily in ms. The Node↔Python boundary
 *     is PURE JSON on stdio: Python does compute only. DB writes and Gemini
 *     cluster-labelling are the ORCHESTRATOR's job, never Python's.
 *
 *   - VpdqDedupeProvider — vPDQ, not TMK. A trimmed/cropped/re-captioned TikTok
 *     repost keeps a variable-length subsequence of the original's frames, which
 *     a fixed-length hash cannot match. Python PDQ-hashes ~1 frame/sec; the
 *     Hamming compare is PURE TS. The distance default is a deliberately TIGHT
 *     D=20 (not the vPDQ reference 31): at 31 you cannot separate "same creator
 *     reposting" (dedupe it) from "different creator recreating the format"
 *     (that IS the product).
 *
 * This package imports ONLY @goodfor/contracts — no analysis package imports
 * another (the contracts-file header rule).
 */

import { spawn } from 'node:child_process'
import * as path from 'node:path'
import {
  DEFAULT_HAMMING_DISTANCE,
  DEFAULT_MIN_MATCH_FRACTION,
  ProviderError,
  type DedupeProvider,
  type DuplicateMatch,
  type FrameHash,
  type MediaBundle,
  type VideoFingerprint,
} from '@goodfor/contracts'

// ---------------------------------------------------------------------------
// Injectable command runner
// ---------------------------------------------------------------------------

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

export interface RunOptions {
  /** Written to the child's stdin, then stdin is closed. */
  input?: string
  cwd?: string
  /** Kill the child after this many ms. 0/undefined disables the timeout. */
  timeoutMs?: number
}

/**
 * How every Python shell-out is performed. Injected in tests so no real
 * `python`/`ffmpeg` process ever runs. The default is a `node:child_process`
 * spawn wrapper (no shell, so paths with spaces and untrusted-looking argv are
 * passed literally, never re-parsed).
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: RunOptions
) => Promise<RunResult>

export function defaultRun(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true })

    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`command timed out after ${opts.timeoutMs}ms: ${cmd}`))
      }, opts.timeoutMs)
    }

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 0 })
    })

    // A Python sidecar that dies before reading stdin (e.g. a missing ML import
    // that crashes at module load) closes its stdin, so our write() below EPIPEs.
    // That fires an async 'error' on the stdin stream which, if unhandled, is a
    // fatal uncaught exception — a missing dependency must never take down the
    // worker. Swallow it here; the non-zero exit + stderr are still reported via
    // 'close', and parsePythonResult turns that into a clean ProviderError.
    child.stdin.on('error', () => {})
    if (opts.input != null) {
      child.stdin.write(opts.input, () => {})
      child.stdin.end()
    } else {
      child.stdin.end()
    }
  })
}

/**
 * Parse a Python sidecar's stdout as JSON, turning both a structured
 * `{ error, ... }` payload and a hard crash into a clean ProviderError so a
 * missing ML dependency never takes down the whole worker.
 */
function parsePythonResult(result: RunResult, provider: string): Record<string, unknown> {
  const raw = result.stdout.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const detail = result.stderr.trim() || raw.slice(0, 200) || '(no output)'
    throw new ProviderError(
      `${provider} sidecar emitted non-JSON (exit ${result.code}): ${detail}`,
      provider,
      result.code !== 0
    )
  }

  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const p = parsed as { error?: unknown; detail?: unknown; pip?: unknown }
    const detail = p.detail ? `: ${String(p.detail)}` : ''
    const pip = p.pip ? ` (pip install ${String(p.pip)})` : ''
    throw new ProviderError(`${String(p.error)}${detail}${pip}`, provider, false)
  }

  if (result.code !== 0) {
    throw new ProviderError(
      `${provider} sidecar exited ${result.code}: ${result.stderr.trim() || '(no stderr)'}`,
      provider,
      false
    )
  }

  return (parsed ?? {}) as Record<string, unknown>
}

const DEFAULT_PYTHON = process.env.PYTHON_BIN ?? 'python3'

// ---------------------------------------------------------------------------
// BERTopic clusterer (UMAP → HDBSCAN over fixed embeddings)
// ---------------------------------------------------------------------------

export interface ClusterEmbeddingItem {
  videoId: number
  /** The transcript + format_summary text embedding (1536-dim halfvec source). */
  embedding: number[]
}

export interface FormatCluster {
  /** HDBSCAN cluster id; -1 is the outlier bucket = the "novel format" queue. */
  id: number
  memberVideoIds: number[]
  /**
   * The 15–20 highest-probability members, which the orchestrator hands to
   * Gemini for a human-readable cluster label. Empty for the -1 bucket.
   */
  representativeVideoIds: number[]
}

export interface ClusterAssignment {
  videoId: number
  /** -1 = HDBSCAN outlier. */
  clusterId: number
}

export interface RefitResult {
  clusters: FormatCluster[]
  assignments: ClusterAssignment[]
}

export interface BertopicClustererOptions {
  run?: CommandRunner
  /** Python interpreter. Defaults to $PYTHON_BIN or 'python3'. */
  pythonPath?: string
  /** Path to cluster.py. Defaults to scripts/analysis/cluster.py under cwd. */
  scriptPath?: string
  /**
   * Where Python persists the fitted UMAP+HDBSCAN model between a weekly
   * `refit` and daily `assign` calls. This is Python-internal state; it never
   * crosses the JSON boundary.
   */
  modelPath?: string
  cwd?: string
}

export class BertopicClusterer {
  readonly name = 'bertopic'
  private readonly run: CommandRunner
  private readonly pythonPath: string
  private readonly scriptPath: string
  private readonly modelPath: string
  private readonly cwd: string

  constructor(opts: BertopicClustererOptions = {}) {
    this.run = opts.run ?? defaultRun
    this.pythonPath = opts.pythonPath ?? DEFAULT_PYTHON
    this.cwd = opts.cwd ?? process.cwd()
    this.scriptPath = opts.scriptPath ?? path.join('scripts', 'analysis', 'cluster.py')
    this.modelPath = opts.modelPath ?? path.join('scripts', 'analysis', '.cache', 'bertopic-model.pkl')
  }

  /**
   * Weekly re-fit. Shells `cluster.py --refit`, passing items as JSON on stdin.
   * Python fits UMAP→HDBSCAN with `min_cluster_size = max(25, round(0.005*N))`
   * (0.5% of corpus — the documented default 150 collapses a 15k corpus into
   * 5–8 mega-clusters) and persists the model for later `assign` calls.
   */
  async refit(items: ClusterEmbeddingItem[]): Promise<RefitResult> {
    const result = await this.run(
      this.pythonPath,
      [this.scriptPath, '--refit', '--model-path', this.modelPath],
      { input: JSON.stringify(items), cwd: this.cwd }
    )
    const parsed = parsePythonResult(result, this.name)

    const clustersRaw = Array.isArray(parsed.clusters) ? parsed.clusters : []
    const assignmentsRaw = Array.isArray(parsed.assignments) ? parsed.assignments : []

    return {
      clusters: clustersRaw.map((c) => {
        const cc = c as Record<string, unknown>
        return {
          id: Number(cc.id),
          memberVideoIds: toNumberArray(cc.memberVideoIds),
          representativeVideoIds: toNumberArray(cc.representativeVideoIds),
        }
      }),
      assignments: assignmentsRaw.map(toAssignment),
    }
  }

  /**
   * Daily assignment via HDBSCAN `approximate_predict` against the persisted
   * model. Milliseconds per batch; no re-fit.
   */
  async assign(items: ClusterEmbeddingItem[]): Promise<ClusterAssignment[]> {
    const result = await this.run(
      this.pythonPath,
      [this.scriptPath, '--assign', '--model-path', this.modelPath],
      { input: JSON.stringify(items), cwd: this.cwd }
    )
    const parsed = parsePythonResult(result, this.name)
    const assignmentsRaw = Array.isArray(parsed.assignments) ? parsed.assignments : []
    return assignmentsRaw.map(toAssignment)
  }
}

function toAssignment(a: unknown): ClusterAssignment {
  const aa = a as Record<string, unknown>
  return { videoId: Number(aa.videoId), clusterId: Number(aa.clusterId) }
}

function toNumberArray(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => Number(x)) : []
}

// ---------------------------------------------------------------------------
// vPDQ near-duplicate dedupe
// ---------------------------------------------------------------------------

/** 256-bit PDQ hash = 32 bytes = 64 hex chars. */
const HASH_BYTES = 32
const HASH_HEX_LEN = HASH_BYTES * 2

/** Per-frame serialised record: Float64BE tSeconds + 32-byte hash. */
const TS_BYTES = 8
const RECORD_BYTES = TS_BYTES + HASH_BYTES // 40
const SERIAL_VERSION = 1

/** Byte-wise popcount table; d(a,b) = Σ popcount(a_i ^ b_i). */
const POPCOUNT_8 = (() => {
  const t = new Uint8Array(256)
  for (let i = 1; i < 256; i++) t[i] = t[i >> 1]! + (i & 1)
  return t
})()

function hexToBytes(hex: string, provider: string): Uint8Array {
  const h = hex.trim().toLowerCase()
  if (h.length % 2 !== 0) {
    throw new ProviderError(`odd-length hash hex (${h.length} chars)`, provider)
  }
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new ProviderError(`invalid hash hex: ${hex}`, provider)
    out[i] = byte
  }
  return out
}

/**
 * Hamming distance over two byte arrays. If the lengths differ (should not
 * happen for well-formed PDQ-256 hashes) the trailing bytes of the longer one
 * count as fully differing, so a malformed short hash never masquerades as a
 * match.
 */
function hammingBytes(a: Uint8Array, b: Uint8Array): number {
  const common = Math.min(a.length, b.length)
  let d = 0
  for (let i = 0; i < common; i++) d += POPCOUNT_8[a[i]! ^ b[i]!]!
  const longer = a.length > b.length ? a : b
  for (let i = common; i < longer.length; i++) d += POPCOUNT_8[longer[i]!]!
  return d
}

export interface VpdqDedupeProviderOptions {
  run?: CommandRunner
  pythonPath?: string
  /** Path to vpdq.py. Defaults to scripts/analysis/vpdq.py under cwd. */
  scriptPath?: string
  cwd?: string
  /** Frames sampled per second. Reference vPDQ is ~1 fps. */
  fps?: number
}

export class VpdqDedupeProvider implements DedupeProvider {
  readonly name = 'vpdq'
  private readonly run: CommandRunner
  private readonly pythonPath: string
  private readonly scriptPath: string
  private readonly cwd: string
  private readonly fps: number

  constructor(opts: VpdqDedupeProviderOptions = {}) {
    this.run = opts.run ?? defaultRun
    this.pythonPath = opts.pythonPath ?? DEFAULT_PYTHON
    this.cwd = opts.cwd ?? process.cwd()
    this.scriptPath = opts.scriptPath ?? path.join('scripts', 'analysis', 'vpdq.py')
    this.fps = opts.fps ?? 1
  }

  /**
   * PDQ-hash ~1 frame/sec of the clip. Shells `vpdq.py --video <path> --fps N`;
   * Python emits `{ frames: [{ tSeconds, hash }] }` with `hash` a 64-char hex
   * PDQ-256. ~30 hashes/video.
   */
  async fingerprint(bundle: MediaBundle): Promise<VideoFingerprint> {
    const result = await this.run(
      this.pythonPath,
      [this.scriptPath, '--video', bundle.videoPath, '--fps', String(this.fps)],
      { cwd: this.cwd }
    )
    const parsed = parsePythonResult(result, this.name)
    const framesRaw = Array.isArray(parsed.frames) ? parsed.frames : []

    const frames: FrameHash[] = framesRaw.map((f) => {
      const ff = f as Record<string, unknown>
      const hash = String(ff.hash).toLowerCase()
      if (hash.length !== HASH_HEX_LEN) {
        throw new ProviderError(
          `expected a ${HASH_HEX_LEN}-char PDQ-256 hex hash, got ${hash.length} chars`,
          this.name
        )
      }
      return { tSeconds: Number(ff.tSeconds), hash }
    })

    return { videoId: bundle.videoId, frames }
  }

  /**
   * Pure-TS Hamming compare. For each corpus video, matchFraction = fraction of
   * QUERY frames within `maxDistance` of ANY corpus frame; include the video
   * when matchFraction ≥ `minMatchFraction`. Variable-length by construction —
   * a trimmed repost with fewer frames still matches as long as ≥80% of the
   * query's frames find a near neighbour.
   *
   * A corpus entry with the same videoId as the query is skipped so a video
   * never reports itself as its own duplicate.
   */
  findDuplicates(
    query: VideoFingerprint,
    corpus: readonly VideoFingerprint[],
    opts?: { maxDistance?: number; minMatchFraction?: number }
  ): DuplicateMatch[] {
    const maxDistance = opts?.maxDistance ?? DEFAULT_HAMMING_DISTANCE
    const minMatchFraction = opts?.minMatchFraction ?? DEFAULT_MIN_MATCH_FRACTION

    const queryBytes = query.frames.map((f) => hexToBytes(f.hash, this.name))
    if (queryBytes.length === 0) return []

    const matches: DuplicateMatch[] = []
    for (const cand of corpus) {
      if (cand.videoId === query.videoId) continue

      const candBytes = cand.frames.map((f) => hexToBytes(f.hash, this.name))
      if (candBytes.length === 0) continue

      let matched = 0
      for (const qf of queryBytes) {
        for (const cf of candBytes) {
          if (hammingBytes(qf, cf) <= maxDistance) {
            matched++
            break
          }
        }
      }

      const matchFraction = matched / queryBytes.length
      if (matchFraction >= minMatchFraction) {
        matches.push({ videoId: cand.videoId, matchFraction })
      }
    }

    // Best match first; break ties by videoId for determinism.
    matches.sort((a, b) => b.matchFraction - a.matchFraction || a.videoId - b.videoId)
    return matches
  }

  /**
   * Pack the fingerprint to a Buffer for `phash_frames bytea`. Layout:
   *   [version:u8][ (tSeconds:f64be)(hash:32 bytes) × frames ]
   * tSeconds is Float64 so it round-trips any JS number exactly.
   */
  serialise(fp: VideoFingerprint): Buffer {
    const buf = Buffer.alloc(1 + fp.frames.length * RECORD_BYTES)
    buf.writeUInt8(SERIAL_VERSION, 0)
    let off = 1
    for (const f of fp.frames) {
      const bytes = hexToBytes(f.hash, this.name)
      if (bytes.length !== HASH_BYTES) {
        throw new ProviderError(
          `expected a ${HASH_BYTES}-byte PDQ-256 hash, got ${bytes.length} bytes`,
          this.name
        )
      }
      buf.writeDoubleBE(f.tSeconds, off)
      off += TS_BYTES
      Buffer.from(bytes).copy(buf, off)
      off += HASH_BYTES
    }
    return buf
  }

  /** Inverse of `serialise`. Round-trips exactly for lowercase-hex fingerprints. */
  deserialise(videoId: number, buf: Buffer): VideoFingerprint {
    if (buf.length < 1) throw new ProviderError('empty fingerprint buffer', this.name)
    const version = buf.readUInt8(0)
    if (version !== SERIAL_VERSION) {
      throw new ProviderError(`unknown fingerprint serial version ${version}`, this.name)
    }
    const body = buf.length - 1
    if (body % RECORD_BYTES !== 0) {
      throw new ProviderError(`corrupt fingerprint buffer (length ${buf.length})`, this.name)
    }

    const frames: FrameHash[] = []
    let off = 1
    const n = body / RECORD_BYTES
    for (let i = 0; i < n; i++) {
      const tSeconds = buf.readDoubleBE(off)
      off += TS_BYTES
      const hash = buf.subarray(off, off + HASH_BYTES).toString('hex')
      off += HASH_BYTES
      frames.push({ tSeconds, hash })
    }

    return { videoId, frames }
  }
}
