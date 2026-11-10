/**
 * ffmpeg-backed MediaProvider — the front of the Phase 2 read pipeline.
 *
 * Everything downstream (Groq ASR, Gemini vision, dedupe) wants extracted
 * audio + frames, not a video container, so this package turns a URL or a
 * local file into a `MediaBundle`: a 16 kHz mono WAV, a sparse set of keyframes
 * for format understanding, and a DENSE set of hook frames from the first 3 s.
 *
 * TWO DESIGN POINTS THAT ARE LOAD-BEARING (completion.md §6.5, contract comment
 * on `MediaBundle.hookFrames`):
 *
 * 1. The hook is sampled at fps=4 across the first 3 s REGARDLESS of scene
 *    scores. Scene detection is a pixel-difference metric; a static talking
 *    head whose on-screen text swaps every 0.8 s scores near zero and yields a
 *    single keyframe — losing exactly the text sequence the hook classifier
 *    needs. So we never gate the hook on scene detection.
 *
 * 2. The pHash used to collapse near-identical adjacent hook frames is a 64-bit
 *    average hash computed WITHOUT any image library — ffmpeg scales each frame
 *    to an 8x8 grayscale raw buffer (64 bytes) and we average-hash it in TS.
 *    This is deliberately NOT the contract's `FrameHash` (PDQ-256, owned by the
 *    dedupe package for whole-clip repost detection). Different hash, different
 *    job — see the contract note on `FrameHash`.
 *
 * Every external side effect is injectable: ffmpeg/ffprobe go through a
 * command runner, HTTP through `fetchImpl`, and disk through `fs`. The
 * defaults are real; tests pass fakes so nothing here ever shells out, hits the
 * network, or writes a file during `vitest`.
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'

import {
  ProviderError,
  type MediaProvider,
  type MediaBundle,
  type ProbeResult,
  type Keyframe,
} from '@goodfor/contracts'

// ---------------------------------------------------------------------------
// Injectable I/O boundaries
// ---------------------------------------------------------------------------

export interface RunResult {
  /** stdout as raw bytes (pHash frames) or text (ffprobe JSON). */
  stdout: Buffer | string
  stderr?: string
  /** Process exit code. 0 = success. */
  code: number
}

/** How every ffmpeg/ffprobe invocation is made. Injected in tests. */
export type CommandRunner = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string }
) => Promise<RunResult>

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

/** The three fs operations this provider needs. Injected in tests. */
export interface FileOps {
  mkdir(dir: string): Promise<void>
  writeFile(path: string, data: Buffer): Promise<void>
  /** Recursive + force — never throws on a missing path. */
  rm(path: string): Promise<void>
}

export interface FfmpegMediaProviderOptions {
  run?: CommandRunner
  ffmpegPath?: string
  ffprobePath?: string
  /** For `fetch()`. Defaults to the global fetch. */
  fetchImpl?: FetchImpl
  /** Disk access. Defaults to node:fs/promises. */
  fs?: FileOps
  /** Sparse-keyframe cadence, in seconds. */
  keyframeIntervalS?: number
  /** Upper bound on sparse keyframes for a long clip. */
  maxKeyframes?: number
  /** Adjacent hook frames within this Hamming distance are collapsed. */
  hookPhashMaxDistance?: number
}

// ---------------------------------------------------------------------------
// Constants — grounded in PHASE-2-understand.md §6.5 / completion.md §6.5
// ---------------------------------------------------------------------------

/** `ffmpeg -ss 0 -t 3 -vf fps=4` — dense hook sampling. */
export const HOOK_FPS = 4
export const HOOK_WINDOW_S = 3
/** fps=4 over 3 s = 12 frames at t = 0, 0.25, … 2.75 s. */
export const HOOK_FRAME_COUNT = HOOK_FPS * HOOK_WINDOW_S

/**
 * A small Hamming distance on the 64-bit average hash — two adjacent hook
 * frames closer than this are treated as the same on-screen state and the
 * later one is dropped. Kept deliberately tight so a genuine text swap (which
 * moves many bits at once) always survives.
 */
export const HOOK_PHASH_MAX_DISTANCE = 6

export const DEFAULT_KEYFRAME_INTERVAL_S = 5
export const DEFAULT_MAX_KEYFRAMES = 16

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function asText(v: Buffer | string | undefined): string {
  if (v === undefined) return ''
  return typeof v === 'string' ? v : v.toString('utf8')
}

function asBuffer(v: Buffer | string): Buffer {
  // latin1 preserves byte values 0..255 when a test hands back a string.
  return typeof v === 'string' ? Buffer.from(v, 'latin1') : v
}

/** ffprobe frame rates are rationals ("30000/1001"). */
export function parseFps(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v !== 'string') return 0
  const slash = v.indexOf('/')
  if (slash === -1) return num(v)
  const n = Number(v.slice(0, slash))
  const d = Number(v.slice(slash + 1))
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0
  return n / d
}

/**
 * 64-bit average hash of an 8x8 grayscale frame: bit i is set when byte i is
 * brighter than the frame mean. Returned as a bigint so Hamming distance is a
 * single XOR + popcount. Buffers longer than 64 bytes are truncated; shorter
 * ones are rejected by the caller.
 */
export function averageHash(gray: Buffer): bigint {
  const n = Math.min(64, gray.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += gray[i]!
  const mean = sum / n
  let hash = 0n
  for (let i = 0; i < n; i++) {
    if (gray[i]! > mean) hash |= 1n << BigInt(i)
  }
  return hash
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x > 0n) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}

/** Derive a safe leaf filename from a download URL. Exported for tests. */
export function filenameFromUrl(url: string): string {
  let base = ''
  try {
    const path = new URL(url).pathname
    base = path.split('/').filter(Boolean).pop() ?? ''
  } catch {
    base = ''
  }
  base = base.replace(/[^\w.\-]/g, '_')
  if (!base) base = 'video.mp4'
  if (!/\.[A-Za-z0-9]{1,5}$/.test(base)) base += '.mp4'
  return base
}

// ---------------------------------------------------------------------------
// Default runner + fs (real side effects — never touched by tests)
// ---------------------------------------------------------------------------

export const spawnCommandRunner: CommandRunner = (cmd, args, opts) =>
  new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, args as string[], {
      cwd: opts?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
        code: code ?? 0,
      })
    )
  })

const defaultFileOps: FileOps = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  },
  writeFile: async (path, data) => {
    await writeFile(path, data)
  },
  rm: async (path) => {
    await rm(path, { recursive: true, force: true })
  },
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class FfmpegMediaProvider implements MediaProvider {
  readonly name = 'ffmpeg'

  private readonly run: CommandRunner
  private readonly ffmpegPath: string
  private readonly ffprobePath: string
  private readonly fetchImpl: FetchImpl
  private readonly fs: FileOps
  private readonly keyframeIntervalS: number
  private readonly maxKeyframes: number
  private readonly hookPhashMaxDistance: number

  constructor(opts: FfmpegMediaProviderOptions = {}) {
    this.run = opts.run ?? spawnCommandRunner
    this.ffmpegPath = opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg'
    this.ffprobePath = opts.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe'
    this.fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl)
    this.fs = opts.fs ?? defaultFileOps
    this.keyframeIntervalS = opts.keyframeIntervalS ?? DEFAULT_KEYFRAME_INTERVAL_S
    this.maxKeyframes = opts.maxKeyframes ?? DEFAULT_MAX_KEYFRAMES
    this.hookPhashMaxDistance = opts.hookPhashMaxDistance ?? HOOK_PHASH_MAX_DISTANCE
  }

  // -------------------------------------------------------------------------
  // probe
  // -------------------------------------------------------------------------

  async probe(videoPath: string): Promise<ProbeResult> {
    const r = await this.run(this.ffprobePath, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      videoPath,
    ])
    if (r.code !== 0) {
      throw new ProviderError(
        `ffprobe exited ${r.code}: ${asText(r.stderr).slice(0, 200)}`,
        this.name,
        false
      )
    }

    let json: {
      format?: { duration?: unknown }
      streams?: Array<{
        codec_type?: string
        width?: unknown
        height?: unknown
        duration?: unknown
        avg_frame_rate?: unknown
        r_frame_rate?: unknown
      }>
    }
    try {
      json = JSON.parse(asText(r.stdout))
    } catch {
      throw new ProviderError('ffprobe returned invalid JSON', this.name, false)
    }

    const streams = Array.isArray(json.streams) ? json.streams : []
    const video = streams.find((s) => s.codec_type === 'video')
    const audio = streams.find((s) => s.codec_type === 'audio')
    if (!video) {
      throw new ProviderError('ffprobe found no video stream', this.name, false)
    }

    const durationS = num(json.format?.duration ?? video.duration)
    const rate = video.avg_frame_rate && video.avg_frame_rate !== '0/0'
      ? video.avg_frame_rate
      : video.r_frame_rate

    return {
      durationS,
      width: num(video.width),
      height: num(video.height),
      fps: parseFps(rate),
      hasAudio: audio !== undefined,
    }
  }

  // -------------------------------------------------------------------------
  // fetch
  // -------------------------------------------------------------------------

  async fetch(url: string, destDir: string): Promise<string> {
    let res: Response
    try {
      res = await this.fetchImpl(url)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Network-level failures are transient — let the caller retry.
      throw new ProviderError(`download failed: ${msg}`, this.name, true)
    }

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500
      throw new ProviderError(
        `download failed: HTTP ${res.status}`,
        this.name,
        retryable
      )
    }

    const buf = Buffer.from(await res.arrayBuffer())
    await this.fs.mkdir(destDir)
    const dest = join(destDir, filenameFromUrl(url))
    await this.fs.writeFile(dest, buf)
    return dest
  }

  // -------------------------------------------------------------------------
  // extract
  // -------------------------------------------------------------------------

  async extract(
    videoPath: string,
    videoId: number,
    workDir: string
  ): Promise<MediaBundle> {
    const probe = await this.probe(videoPath)
    await this.fs.mkdir(workDir)

    const audioPath = probe.hasAudio
      ? await this.extractAudio(videoPath, videoId, workDir)
      : null

    const keyframes = await this.extractKeyframes(videoPath, probe, workDir)
    const hookFrames = await this.extractHookFrames(videoPath, workDir)

    return { videoId, videoPath, audioPath, keyframes, hookFrames, probe }
  }

  /** 16 kHz mono WAV — exactly what every ASR provider wants. */
  private async extractAudio(
    videoPath: string,
    videoId: number,
    workDir: string
  ): Promise<string> {
    const audioPath = join(workDir, `audio_${videoId}.wav`)
    const r = await this.run(this.ffmpegPath, [
      '-nostdin',
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      audioPath,
    ])
    if (r.code !== 0) {
      throw new ProviderError(
        `ffmpeg audio extract exited ${r.code}: ${asText(r.stderr).slice(0, 200)}`,
        this.name,
        false
      )
    }
    return audioPath
  }

  /**
   * Sparse frames spread across the whole clip, one ffmpeg seek per timestamp
   * so the on-disk path and its tSeconds are known exactly (no directory
   * listing, which keeps the whole thing testable through the runner).
   */
  private async extractKeyframes(
    videoPath: string,
    probe: ProbeResult,
    workDir: string
  ): Promise<Keyframe[]> {
    const times = this.keyframeTimes(probe.durationS)
    const frames: Keyframe[] = []
    for (let i = 0; i < times.length; i++) {
      const t = times[i]!
      const path = join(workDir, `keyframe_${String(i).padStart(4, '0')}.png`)
      const r = await this.run(this.ffmpegPath, [
        '-nostdin',
        '-y',
        '-ss',
        t.toFixed(3),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        path,
      ])
      if (r.code === 0) frames.push({ path, tSeconds: t })
    }
    return frames
  }

  private keyframeTimes(durationS: number): number[] {
    if (!(durationS > 0)) return [0]
    const raw = Math.ceil(durationS / this.keyframeIntervalS)
    const count = Math.max(1, Math.min(this.maxKeyframes, raw))
    const step = durationS / count
    const times: number[] = []
    for (let i = 0; i < count; i++) times.push(Number((i * step).toFixed(3)))
    return times
  }

  /**
   * Dense frames from the first 3 s at fps=4, then pHash-dedupe adjacent
   * near-identical frames. Sampled densely REGARDLESS of scene scores — the
   * whole reason this exists (see the file header / contract note).
   *
   * ffmpeg writes `hook_0001.png … hook_00NN.png`; fps=4 over 3 s is a fixed 12
   * frames, so the paths + timestamps are predictable. A frame ffmpeg didn't
   * actually emit (short clip, rounding) simply fails its pHash read and is
   * skipped, so over/under-prediction is harmless.
   */
  private async extractHookFrames(
    videoPath: string,
    workDir: string
  ): Promise<Keyframe[]> {
    await this.run(this.ffmpegPath, [
      '-nostdin',
      '-y',
      '-ss',
      '0',
      '-t',
      String(HOOK_WINDOW_S),
      '-i',
      videoPath,
      '-vf',
      `fps=${HOOK_FPS}`,
      join(workDir, 'hook_%04d.png'),
    ])

    const candidates: Keyframe[] = []
    for (let i = 1; i <= HOOK_FRAME_COUNT; i++) {
      candidates.push({
        path: join(workDir, `hook_${String(i).padStart(4, '0')}.png`),
        tSeconds: Number(((i - 1) / HOOK_FPS).toFixed(3)),
      })
    }

    return this.dedupeAdjacent(candidates)
  }

  /**
   * Collapse runs of near-identical adjacent frames. Each surviving frame's
   * pHash differs from the previously SEEN frame by more than
   * `hookPhashMaxDistance`; a text swap moves many bits at once and is always
   * kept, while the ~3 identical frames within one text state collapse to one.
   */
  private async dedupeAdjacent(frames: Keyframe[]): Promise<Keyframe[]> {
    const kept: Keyframe[] = []
    let prevHash: bigint | null = null
    for (const frame of frames) {
      const gray = await this.phashFrame(frame.path)
      if (!gray || gray.length < 64) continue // frame not emitted / unreadable
      const hash = averageHash(gray)
      if (prevHash === null || hammingDistance(hash, prevHash) > this.hookPhashMaxDistance) {
        kept.push(frame)
      }
      prevHash = hash
    }
    return kept
  }

  /** ffmpeg → 8x8 grayscale raw frame (64 bytes) on stdout. No image library. */
  private async phashFrame(framePath: string): Promise<Buffer | null> {
    const r = await this.run(this.ffmpegPath, [
      '-nostdin',
      '-i',
      framePath,
      '-vf',
      'scale=8:8,format=gray',
      '-f',
      'rawvideo',
      '-',
    ])
    if (r.code !== 0) return null
    return asBuffer(r.stdout)
  }

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------

  async cleanup(bundle: MediaBundle): Promise<void> {
    const paths = [
      bundle.audioPath,
      ...bundle.keyframes.map((k) => k.path),
      ...bundle.hookFrames.map((k) => k.path),
    ].filter((p): p is string => typeof p === 'string' && p.length > 0)

    // Remove the containing work dir(s) so leftover raw hook frames (dropped by
    // the dedupe) go too, not just the frames still referenced in the bundle.
    const dirs = new Set(paths.map((p) => dirname(p)))
    for (const dir of dirs) await this.fs.rm(dir)
  }
}
