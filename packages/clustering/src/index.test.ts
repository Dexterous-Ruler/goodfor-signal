import { describe, it, expect, vi } from 'vitest'
import { ProviderError, type MediaBundle, type VideoFingerprint } from '@goodfor/contracts'
import {
  BertopicClusterer,
  VpdqDedupeProvider,
  type CommandRunner,
  type RunResult,
} from './index.js'

// ---------------------------------------------------------------------------
// Deterministic hex-hash helpers (no real ffmpeg/PDQ — pure fixtures)
// ---------------------------------------------------------------------------

/**
 * A 32-byte (256-bit) hash as lowercase hex, every byte = `seed`. This gives a
 * provable inter-frame distance: two frames with different seeds are
 * `32 * popcount(a ^ b) >= 32` bits apart, so a "trimmed" frame is genuinely
 * unmatchable — a random generator would occasionally place two frames within
 * D=20 and make the test flaky.
 */
function seededHash(seed: number): string {
  return Buffer.alloc(32, seed & 0xff).toString('hex')
}

/** Flip the first `k` bits (k ≤ 256) → a hash exactly Hamming-distance k away. */
function flipBits(hex: string, k: number): string {
  const buf = Buffer.from(hex, 'hex')
  for (let idx = 0; idx < k; idx++) {
    const byteI = idx >> 3
    const bitI = idx & 7
    buf[byteI]! ^= 1 << bitI
  }
  return buf.toString('hex')
}

/** Bitwise NOT — always Hamming-distance 256, i.e. as far as possible. */
function invert(hex: string): string {
  const buf = Buffer.from(hex, 'hex')
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! ^ 0xff
  return buf.toString('hex')
}

function frames(hashes: string[]): VideoFingerprint['frames'] {
  return hashes.map((hash, i) => ({ tSeconds: i, hash }))
}

const okRunner = (payload: unknown): CommandRunner =>
  vi.fn(async (): Promise<RunResult> => ({ stdout: JSON.stringify(payload), stderr: '', code: 0 }))

// ---------------------------------------------------------------------------
// findDuplicates — both directions (PHASE-2 §6.4, acceptance test 4)
// ---------------------------------------------------------------------------

describe('VpdqDedupeProvider.findDuplicates', () => {
  const dedupe = new VpdqDedupeProvider()

  // A known original: 10 mutually-distant frames.
  const original = frames(Array.from({ length: 10 }, (_, i) => seededHash(i)))
  const query: VideoFingerprint = { videoId: 1, frames: original }

  it('matches a trimmed + cropped repost at D=20 (matchFraction >= 0.8)', () => {
    // "Cropped": each kept frame is a near-copy (10 bits flipped, < D=20).
    // "Trimmed": the last frame is dropped, so 9 of 10 query frames match.
    const repostFrames = frames(
      original.slice(0, 9).map((f) => flipBits(f.hash, 10))
    )
    const repost: VideoFingerprint = { videoId: 2, frames: repostFrames }

    const out = dedupe.findDuplicates(query, [repost])
    expect(out).toHaveLength(1)
    expect(out[0]!.videoId).toBe(2)
    expect(out[0]!.matchFraction).toBeCloseTo(0.9, 5)
    expect(out[0]!.matchFraction).toBeGreaterThanOrEqual(0.8)
  })

  it('does NOT match a different-creator recreation (distinct frames)', () => {
    // Same format, different execution → every frame is far (inverted = D256).
    const recreationFrames = frames(original.map((f) => invert(f.hash)))
    const recreation: VideoFingerprint = { videoId: 3, frames: recreationFrames }

    const out = dedupe.findDuplicates(query, [recreation])
    expect(out).toHaveLength(0)
  })

  it('separates the repost from the recreation in a mixed corpus', () => {
    const repost: VideoFingerprint = {
      videoId: 2,
      frames: frames(original.slice(0, 9).map((f) => flipBits(f.hash, 8))),
    }
    const recreation: VideoFingerprint = {
      videoId: 3,
      frames: frames(original.map((f) => invert(f.hash))),
    }

    const out = dedupe.findDuplicates(query, [recreation, repost])
    expect(out.map((m) => m.videoId)).toEqual([2]) // only the repost survives
  })

  it('respects a just-below-threshold cut: 15 bits in matches, 25 bits out', () => {
    const within = frames(original.map((f) => flipBits(f.hash, 15)))
    const beyond = frames(original.map((f) => flipBits(f.hash, 25)))

    expect(dedupe.findDuplicates(query, [{ videoId: 5, frames: within }])).toHaveLength(1)
    expect(dedupe.findDuplicates(query, [{ videoId: 6, frames: beyond }])).toHaveLength(0)
  })

  it('honours an overridden maxDistance', () => {
    const beyondDefault = frames(original.map((f) => flipBits(f.hash, 25)))
    const cand: VideoFingerprint = { videoId: 7, frames: beyondDefault }

    expect(dedupe.findDuplicates(query, [cand])).toHaveLength(0)
    expect(dedupe.findDuplicates(query, [cand], { maxDistance: 30 })).toHaveLength(1)
  })

  it('never reports a video as its own duplicate', () => {
    const selfInCorpus: VideoFingerprint = { videoId: 1, frames: original }
    expect(dedupe.findDuplicates(query, [selfInCorpus])).toHaveLength(0)
  })

  it('returns nothing for an empty query or empty candidate', () => {
    expect(dedupe.findDuplicates({ videoId: 1, frames: [] }, [query])).toHaveLength(0)
    expect(dedupe.findDuplicates(query, [{ videoId: 9, frames: [] }])).toHaveLength(0)
  })

  it('sorts best match first', () => {
    const closer: VideoFingerprint = {
      videoId: 20,
      frames: frames(original.map((f) => flipBits(f.hash, 2))),
    }
    const looser: VideoFingerprint = {
      videoId: 21,
      frames: frames(original.slice(0, 8).map((f) => flipBits(f.hash, 5))),
    }
    const out = dedupe.findDuplicates(query, [looser, closer])
    expect(out.map((m) => m.videoId)).toEqual([20, 21])
    expect(out[0]!.matchFraction).toBeGreaterThanOrEqual(out[1]!.matchFraction)
  })
})

// ---------------------------------------------------------------------------
// serialise / deserialise round-trip
// ---------------------------------------------------------------------------

describe('VpdqDedupeProvider serialise/deserialise', () => {
  const dedupe = new VpdqDedupeProvider()

  it('round-trips a fingerprint exactly', () => {
    const fp: VideoFingerprint = {
      videoId: 42,
      frames: [
        { tSeconds: 0, hash: seededHash(1) },
        { tSeconds: 1, hash: seededHash(2) },
        { tSeconds: 2.5, hash: seededHash(3) }, // fractional t survives (f64)
      ],
    }

    const buf = dedupe.serialise(fp)
    expect(Buffer.isBuffer(buf)).toBe(true)
    // 1 version byte + 3 records × 40 bytes.
    expect(buf.length).toBe(1 + 3 * 40)

    const back = dedupe.deserialise(42, buf)
    expect(back).toEqual(fp)
  })

  it('round-trips an empty fingerprint', () => {
    const fp: VideoFingerprint = { videoId: 7, frames: [] }
    const back = dedupe.deserialise(7, dedupe.serialise(fp))
    expect(back).toEqual(fp)
  })

  it('re-serialising a deserialised buffer is byte-stable', () => {
    const fp: VideoFingerprint = {
      videoId: 5,
      frames: frames([seededHash(11), seededHash(12)]),
    }
    const buf1 = dedupe.serialise(fp)
    const buf2 = dedupe.serialise(dedupe.deserialise(5, buf1))
    expect(buf2.equals(buf1)).toBe(true)
  })

  it('rejects a corrupt buffer length', () => {
    expect(() => dedupe.deserialise(1, Buffer.from([1, 2, 3]))).toThrow(ProviderError)
  })

  it('rejects an unknown serial version', () => {
    const bad = Buffer.alloc(1 + 40)
    bad.writeUInt8(9, 0)
    expect(() => dedupe.deserialise(1, bad)).toThrow(/version/)
  })

  it('rejects a non-256-bit hash on serialise', () => {
    const fp: VideoFingerprint = { videoId: 1, frames: [{ tSeconds: 0, hash: 'abcd' }] }
    expect(() => dedupe.serialise(fp)).toThrow(ProviderError)
  })
})

// ---------------------------------------------------------------------------
// fingerprint — shells to vpdq.py (runner mocked)
// ---------------------------------------------------------------------------

describe('VpdqDedupeProvider.fingerprint', () => {
  const bundle: MediaBundle = {
    videoId: 99,
    videoPath: '/tmp/clip.mp4',
    audioPath: null,
    keyframes: [],
    hookFrames: [],
    probe: { durationS: 30, width: 1080, height: 1920, fps: 30, hasAudio: true },
  }

  it('parses the sidecar frames into a VideoFingerprint', async () => {
    const h0 = seededHash(1)
    const h1 = seededHash(2)
    const run = okRunner({
      frames: [
        { tSeconds: 0, hash: h0.toUpperCase() }, // upper-case tolerated, normalised
        { tSeconds: 1, hash: h1 },
      ],
    })
    const dedupe = new VpdqDedupeProvider({ run })

    const fp = await dedupe.fingerprint(bundle)
    expect(fp.videoId).toBe(99)
    expect(fp.frames).toEqual([
      { tSeconds: 0, hash: h0 },
      { tSeconds: 1, hash: h1 },
    ])

    // Shelled with the video path and fps.
    const call = (run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(call[1]).toContain('--video')
    expect(call[1]).toContain('/tmp/clip.mp4')
    expect(call[1]).toContain('--fps')
  })

  it('throws a clean ProviderError on a sidecar {error} payload', async () => {
    const run: CommandRunner = async () => ({
      stdout: JSON.stringify({ error: 'ffmpeg-failed', detail: 'no such file' }),
      stderr: '',
      code: 2,
    })
    const dedupe = new VpdqDedupeProvider({ run })
    await expect(dedupe.fingerprint(bundle)).rejects.toThrow(/ffmpeg-failed/)
  })

  it('throws on a malformed hash length', async () => {
    const run = okRunner({ frames: [{ tSeconds: 0, hash: 'deadbeef' }] })
    const dedupe = new VpdqDedupeProvider({ run })
    await expect(dedupe.fingerprint(bundle)).rejects.toThrow(/PDQ-256/)
  })

  it('surfaces a non-JSON crash as a ProviderError', async () => {
    const run: CommandRunner = async () => ({
      stdout: 'Traceback (most recent call last): ...',
      stderr: 'boom',
      code: 1,
    })
    const dedupe = new VpdqDedupeProvider({ run })
    await expect(dedupe.fingerprint(bundle)).rejects.toThrow(ProviderError)
  })
})

// ---------------------------------------------------------------------------
// BertopicClusterer — shells to cluster.py (runner mocked)
// ---------------------------------------------------------------------------

describe('BertopicClusterer', () => {
  const items = [
    { videoId: 1, embedding: [0.1, 0.2] },
    { videoId: 2, embedding: [0.3, 0.4] },
    { videoId: 3, embedding: [0.9, 0.8] },
  ]

  it('refit parses clusters + assignments and passes items on stdin', async () => {
    const run = okRunner({
      clusters: [
        { id: 0, memberVideoIds: [1, 2], representativeVideoIds: [1] },
        { id: -1, memberVideoIds: [3], representativeVideoIds: [] }, // outlier bucket
      ],
      assignments: [
        { videoId: 1, clusterId: 0 },
        { videoId: 2, clusterId: 0 },
        { videoId: 3, clusterId: -1 },
      ],
    })
    const clusterer = new BertopicClusterer({ run })

    const res = await clusterer.refit(items)
    expect(res.clusters).toHaveLength(2)
    expect(res.clusters[1]!.id).toBe(-1)
    expect(res.clusters[1]!.representativeVideoIds).toEqual([])
    expect(res.assignments.find((a) => a.videoId === 3)!.clusterId).toBe(-1)

    const call = (run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(call[1]).toContain('--refit')
    expect(call[1]).toContain('--model-path')
    expect(JSON.parse(call[2].input)).toEqual(items) // items shipped as JSON stdin
  })

  it('assign parses assignments via approximate_predict path', async () => {
    const run = okRunner({
      assignments: [
        { videoId: 10, clusterId: 4 },
        { videoId: 11, clusterId: -1 },
      ],
    })
    const clusterer = new BertopicClusterer({ run })

    const res = await clusterer.assign([
      { videoId: 10, embedding: [0.1] },
      { videoId: 11, embedding: [0.2] },
    ])
    expect(res).toEqual([
      { videoId: 10, clusterId: 4 },
      { videoId: 11, clusterId: -1 },
    ])

    const call = (run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(call[1]).toContain('--assign')
  })

  it('turns a deps-missing sidecar into a ProviderError with a pip hint', async () => {
    const run: CommandRunner = async () => ({
      stdout: JSON.stringify({ error: 'deps-missing', pip: 'bertopic umap-learn hdbscan' }),
      stderr: '',
      code: 3,
    })
    const clusterer = new BertopicClusterer({ run })
    await expect(clusterer.refit(items)).rejects.toThrow(/deps-missing.*pip install bertopic/)
  })
})
