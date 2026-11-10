import { describe, it, expect } from 'vitest'
import { ProviderError, type MediaBundle } from '@goodfor/contracts'
import {
  FfmpegMediaProvider,
  averageHash,
  hammingDistance,
  parseFps,
  filenameFromUrl,
  HOOK_FPS,
  HOOK_FRAME_COUNT,
  type CommandRunner,
  type RunResult,
  type FileOps,
} from './index.js'

// ---------------------------------------------------------------------------
// Test doubles — nothing here shells out, hits the network, or touches disk.
// ---------------------------------------------------------------------------

interface RecordedCall {
  cmd: string
  args: string[]
}

/**
 * A runner that records every invocation and routes by inspecting the args,
 * exactly the way a real ffmpeg/ffprobe call would be distinguished.
 */
function makeRunner(opts: {
  probeJson?: unknown
  probeCode?: number
  probeStderr?: string
  /** Raw 8x8 gray bytes keyed by hook frame path; missing => ffmpeg "failed". */
  phashByPath?: (path: string) => Buffer | null
  audioCode?: number
  keyframeCode?: number
}): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const runner: CommandRunner = async (cmd, args) => {
    const a = [...args]
    calls.push({ cmd, args: a })
    const has = (s: string) => a.includes(s)

    // ffprobe
    if (has('-show_streams')) {
      return {
        stdout: JSON.stringify(opts.probeJson ?? {}),
        stderr: opts.probeStderr ?? '',
        code: opts.probeCode ?? 0,
      } satisfies RunResult
    }
    // pHash: 8x8 gray raw frame to stdout
    if (has('scale=8:8,format=gray')) {
      // The input frame path is the arg after '-i'.
      const path = a[a.indexOf('-i') + 1]!
      // Distinguish "no handler" (default 64 bytes) from "handler said null"
      // (ffmpeg exits non-zero: the frame was never emitted).
      const bytes = opts.phashByPath ? opts.phashByPath(path) : Buffer.alloc(64)
      if (bytes === null) return { stdout: Buffer.alloc(0), stderr: '', code: 1 }
      return { stdout: bytes, stderr: '', code: 0 }
    }
    // audio extract
    if (has('16000')) {
      return { stdout: Buffer.alloc(0), stderr: '', code: opts.audioCode ?? 0 }
    }
    // hook frame extraction (fps=4) — writes files, empty stdout
    if (a.some((x) => x.startsWith('fps='))) {
      return { stdout: Buffer.alloc(0), stderr: '', code: 0 }
    }
    // sparse keyframe seek
    if (has('-frames:v')) {
      return { stdout: Buffer.alloc(0), stderr: '', code: opts.keyframeCode ?? 0 }
    }
    return { stdout: Buffer.alloc(0), stderr: '', code: 0 }
  }
  return { runner, calls }
}

function makeFs(): { fs: FileOps; writes: Array<{ path: string; data: Buffer }>; removed: string[] } {
  const writes: Array<{ path: string; data: Buffer }> = []
  const removed: string[] = []
  const fs: FileOps = {
    mkdir: async () => {},
    writeFile: async (path, data) => {
      writes.push({ path, data })
    },
    rm: async (path) => {
      removed.push(path)
    },
  }
  return { fs, writes, removed }
}

const VIDEO_STREAM = { codec_type: 'video', width: 1080, height: 1920, avg_frame_rate: '30/1' }
const AUDIO_STREAM = { codec_type: 'audio' }

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('parseFps', () => {
  it('parses rational frame rates', () => {
    expect(parseFps('30/1')).toBe(30)
    expect(parseFps('30000/1001')).toBeCloseTo(29.97, 2)
  })
  it('handles the degenerate 0/0 without dividing by zero', () => {
    expect(parseFps('0/0')).toBe(0)
  })
  it('accepts a bare number', () => {
    expect(parseFps(24)).toBe(24)
    expect(parseFps('60')).toBe(60)
  })
})

describe('averageHash / hammingDistance', () => {
  it('sets a bit only where the byte is above the frame mean', () => {
    // 32 bright then 32 dark → lower 32 bits set.
    const buf = Buffer.concat([Buffer.alloc(32, 255), Buffer.alloc(32, 0)])
    const hash = averageHash(buf)
    expect(hash).toBe((1n << 32n) - 1n)
  })
  it('a uniform frame hashes to zero (nothing above the mean)', () => {
    expect(averageHash(Buffer.alloc(64, 10))).toBe(0n)
  })
  it('measures bit differences', () => {
    expect(hammingDistance(0b1011n, 0b1110n)).toBe(2)
    expect(hammingDistance(0n, (1n << 32n) - 1n)).toBe(32)
  })
})

describe('filename derivation', () => {
  it('takes the URL leaf and sanitises it', () => {
    expect(filenameFromUrl('https://cdn.example.com/a/b/clip.mp4?token=x')).toBe('clip.mp4')
  })
  it('falls back to a default when there is no usable leaf', () => {
    expect(filenameFromUrl('https://cdn.example.com/')).toBe('video.mp4')
  })
  it('appends an extension when the leaf has none', () => {
    expect(filenameFromUrl('https://cdn.example.com/download')).toBe('download.mp4')
  })
})

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

describe('probe', () => {
  it('maps ffprobe JSON into a ProbeResult and passes the right args', async () => {
    const { runner, calls } = makeRunner({
      probeJson: { format: { duration: '12.5' }, streams: [VIDEO_STREAM, AUDIO_STREAM] },
    })
    const provider = new FfmpegMediaProvider({ run: runner, ffprobePath: 'ffprobe' })
    const probe = await provider.probe('/tmp/v.mp4')

    expect(probe).toEqual({ durationS: 12.5, width: 1080, height: 1920, fps: 30, hasAudio: true })
    expect(calls[0]!.cmd).toBe('ffprobe')
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining(['-print_format', 'json', '-show_streams', '/tmp/v.mp4'])
    )
  })

  it('reports hasAudio=false when there is no audio stream', async () => {
    const { runner } = makeRunner({
      probeJson: { format: { duration: '8' }, streams: [VIDEO_STREAM] },
    })
    const provider = new FfmpegMediaProvider({ run: runner })
    expect((await provider.probe('/tmp/v.mp4')).hasAudio).toBe(false)
  })

  it('throws a non-retryable ProviderError when ffprobe fails', async () => {
    const { runner } = makeRunner({ probeCode: 1, probeStderr: 'boom' })
    const provider = new FfmpegMediaProvider({ run: runner })
    await expect(provider.probe('/tmp/v.mp4')).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: false,
    })
  })

  it('throws when there is no video stream', async () => {
    const { runner } = makeRunner({ probeJson: { streams: [AUDIO_STREAM] } })
    const provider = new FfmpegMediaProvider({ run: runner })
    await expect(provider.probe('/tmp/v.mp4')).rejects.toBeInstanceOf(ProviderError)
  })
})

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

describe('fetch', () => {
  const okResponse = (body: Uint8Array) =>
    ({ ok: true, status: 200, arrayBuffer: async () => body.buffer }) as unknown as Response

  it('downloads a 200 body and writes it to destDir', async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const { fs, writes } = makeFs()
    let calledUrl = ''
    const provider = new FfmpegMediaProvider({
      fs,
      fetchImpl: async (url) => {
        calledUrl = url
        return okResponse(body)
      },
    })

    const dest = await provider.fetch('https://cdn.example.com/x/clip.mp4', '/work')

    expect(calledUrl).toBe('https://cdn.example.com/x/clip.mp4')
    expect(dest).toContain('clip.mp4')
    expect(writes).toHaveLength(1)
    expect([...writes[0]!.data]).toEqual([1, 2, 3, 4])
  })

  it('marks 5xx and 429 as retryable', async () => {
    const { fs } = makeFs()
    for (const status of [500, 503, 429]) {
      const provider = new FfmpegMediaProvider({
        fs,
        fetchImpl: async () => ({ ok: false, status }) as unknown as Response,
      })
      await expect(provider.fetch('https://x/y.mp4', '/w')).rejects.toMatchObject({
        retryable: true,
      })
    }
  })

  it('marks a 404 as non-retryable', async () => {
    const { fs } = makeFs()
    const provider = new FfmpegMediaProvider({
      fs,
      fetchImpl: async () => ({ ok: false, status: 404 }) as unknown as Response,
    })
    await expect(provider.fetch('https://x/y.mp4', '/w')).rejects.toMatchObject({
      retryable: false,
    })
  })

  it('treats a thrown network error as retryable', async () => {
    const { fs } = makeFs()
    const provider = new FfmpegMediaProvider({
      fs,
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      },
    })
    await expect(provider.fetch('https://x/y.mp4', '/w')).rejects.toMatchObject({
      retryable: true,
    })
  })
})

// ---------------------------------------------------------------------------
// extract — arg strings + audio gating + keyframe count
// ---------------------------------------------------------------------------

describe('extract', () => {
  const probeJson = { format: { duration: '12' }, streams: [VIDEO_STREAM, AUDIO_STREAM] }

  it('extracts 16 kHz mono audio, fps=4 hook frames, and scale=8:8 pHash frames', async () => {
    const { runner, calls } = makeRunner({ probeJson })
    const { fs } = makeFs()
    const provider = new FfmpegMediaProvider({ run: runner, fs, ffmpegPath: 'ffmpeg' })

    await provider.extract('/tmp/v.mp4', 77, '/work/77')

    const audioCall = calls.find((c) => c.args.includes('16000'))!
    expect(audioCall.args).toEqual(expect.arrayContaining(['-ar', '16000', '-ac', '1', '-vn']))

    const hookCall = calls.find((c) => c.args.some((x) => x === `fps=${HOOK_FPS}`))!
    expect(hookCall.args).toEqual(expect.arrayContaining(['-ss', '0', '-t', '3', '-vf', 'fps=4']))

    const phashCall = calls.find((c) => c.args.includes('scale=8:8,format=gray'))!
    expect(phashCall.args).toEqual(
      expect.arrayContaining(['-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-'])
    )
  })

  it('produces sparse keyframes spread across the clip', async () => {
    const { runner } = makeRunner({ probeJson })
    const { fs } = makeFs()
    const provider = new FfmpegMediaProvider({
      run: runner,
      fs,
      keyframeIntervalS: 5,
    })
    const bundle = await provider.extract('/tmp/v.mp4', 1, '/work/1')

    // duration 12, interval 5 → ceil(12/5)=3 keyframes at 0, 4, 8s.
    expect(bundle.keyframes.map((k) => k.tSeconds)).toEqual([0, 4, 8])
    expect(bundle.keyframes.every((k) => k.path.includes('keyframe_'))).toBe(true)
    expect(bundle.probe.durationS).toBe(12)
  })

  it('sets audioPath to null when the clip has no audio', async () => {
    const { runner, calls } = makeRunner({
      probeJson: { format: { duration: '9' }, streams: [VIDEO_STREAM] },
    })
    const { fs } = makeFs()
    const provider = new FfmpegMediaProvider({ run: runner, fs })
    const bundle = await provider.extract('/tmp/v.mp4', 5, '/work/5')

    expect(bundle.audioPath).toBeNull()
    expect(calls.some((c) => c.args.includes('16000'))).toBe(false)
  })

  it('throws a ProviderError when audio extraction fails', async () => {
    const { runner } = makeRunner({ probeJson, audioCode: 1 })
    const { fs } = makeFs()
    const provider = new FfmpegMediaProvider({ run: runner, fs })
    await expect(provider.extract('/tmp/v.mp4', 1, '/w')).rejects.toBeInstanceOf(ProviderError)
  })
})

// ---------------------------------------------------------------------------
// hook-frame pHash dedupe
// ---------------------------------------------------------------------------

describe('hook-frame dedupe', () => {
  const probeJson = { format: { duration: '6' }, streams: [VIDEO_STREAM, AUDIO_STREAM] }

  // Three distinct on-screen text states, each held for 4 frames.
  const uniform = Buffer.alloc(64, 10) // hash 0
  const lowerHalf = Buffer.concat([Buffer.alloc(32, 255), Buffer.alloc(32, 0)]) // low 32 bits
  const upperHalf = Buffer.concat([Buffer.alloc(32, 0), Buffer.alloc(32, 255)]) // high 32 bits

  function frameIndex(path: string): number {
    // hook_0001.png → 1
    return Number(path.match(/hook_(\d+)\.png$/)![1])
  }

  it('collapses runs of identical frames but keeps each text swap', async () => {
    const { runner } = makeRunner({
      probeJson,
      phashByPath: (path) => {
        const i = frameIndex(path)
        if (i <= 4) return uniform
        if (i <= 8) return lowerHalf
        return upperHalf
      },
    })
    const { fs } = makeFs()
    const provider = new FfmpegMediaProvider({ run: runner, fs })
    const bundle = await provider.extract('/tmp/v.mp4', 1, '/w')

    // 12 near-identical-in-runs frames → 3 distinct states kept, at the first
    // frame of each run: t = 0, 1.0, 2.0s.
    expect(bundle.hookFrames.map((k) => k.tSeconds)).toEqual([0, 1, 2])
    expect(bundle.hookFrames.map((k) => frameIndex(k.path))).toEqual([1, 5, 9])
  })

  it('keeps a frame that differs by more than the threshold, drops one within it', async () => {
    // frame 2 differs from frame 1 by only 2 bits (below threshold) → dropped.
    const nearDup = Buffer.concat([Buffer.alloc(32, 255), Buffer.alloc(30, 0), Buffer.alloc(2, 255)])
    const { runner } = makeRunner({
      probeJson: { format: { duration: '1' }, streams: [VIDEO_STREAM] },
      phashByPath: (path) => (frameIndex(path) === 1 ? lowerHalf : frameIndex(path) === 2 ? nearDup : upperHalf),
    })
    const { fs } = makeFs()
    const provider = new FfmpegMediaProvider({ run: runner, fs, hookPhashMaxDistance: 6 })
    const bundle = await provider.extract('/tmp/v.mp4', 1, '/w')

    const kept = bundle.hookFrames.map((k) => frameIndex(k.path))
    expect(kept).toContain(1)
    expect(kept).not.toContain(2) // 2-bit change is below the dedupe threshold
    expect(kept).toContain(3) // upperHalf differs by 64 bits → kept
  })

  it('skips hook frames ffmpeg did not actually emit', async () => {
    // Only frames 1..3 exist (short clip); the rest fail their pHash read.
    const { runner } = makeRunner({
      probeJson: { format: { duration: '1' }, streams: [VIDEO_STREAM] },
      phashByPath: (path) => {
        const i = frameIndex(path)
        if (i === 1) return uniform
        if (i === 2) return lowerHalf
        if (i === 3) return upperHalf
        return null // ffmpeg exits non-zero: frame does not exist
      },
    })
    const { fs } = makeFs()
    const provider = new FfmpegMediaProvider({ run: runner, fs })
    const bundle = await provider.extract('/tmp/v.mp4', 1, '/w')

    expect(bundle.hookFrames.map((k) => frameIndex(k.path))).toEqual([1, 2, 3])
    expect(bundle.hookFrames.length).toBeLessThan(HOOK_FRAME_COUNT)
  })
})

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe('cleanup', () => {
  it('removes the work dir(s) that hold the bundle artefacts', async () => {
    const { fs, removed } = makeFs()
    const provider = new FfmpegMediaProvider({ fs })
    const bundle: MediaBundle = {
      videoId: 1,
      videoPath: '/dl/clip.mp4',
      audioPath: '/work/1/audio_1.wav',
      keyframes: [{ path: '/work/1/keyframe_0000.png', tSeconds: 0 }],
      hookFrames: [{ path: '/work/1/hook_0001.png', tSeconds: 0 }],
      probe: { durationS: 5, width: 1, height: 1, fps: 30, hasAudio: true },
    }

    await provider.cleanup(bundle)

    // The parent work dir (deduped) — not each individual file.
    expect(removed).toEqual(['/work/1'])
  })

  it('is a no-op with nothing to clean', async () => {
    const { fs, removed } = makeFs()
    const provider = new FfmpegMediaProvider({ fs })
    await provider.cleanup({
      videoId: 1,
      videoPath: '/dl/clip.mp4',
      audioPath: null,
      keyframes: [],
      hookFrames: [],
      probe: { durationS: 5, width: 1, height: 1, fps: 30, hasAudio: false },
    })
    expect(removed).toEqual([])
  })
})
