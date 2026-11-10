/**
 * Shared contracts for the Phase 2 analysis pipeline.
 *
 * Every analysis package implements an interface defined here and NOTHING
 * imports another analysis package directly. That keeps providers swappable
 * (the same reason TikTokSource exists) and lets the packages be built and
 * tested independently.
 *
 * Cost fields are not decoration. The spread between a sensible and a naive
 * analysis architecture is ~30x, so every provider reports what it spent.
 */

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface ProbeResult {
  durationS: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
}

export interface Keyframe {
  /** Absolute path to a PNG or JPEG on disk. */
  path: string
  /** Offset from the start of the video, in seconds. */
  tSeconds: number
}

export interface MediaBundle {
  videoId: number
  videoPath: string
  /** 16 kHz mono WAV — what every ASR provider wants. */
  audioPath: string | null
  /** Sparse frames across the whole clip, for format/scene understanding. */
  keyframes: Keyframe[]
  /**
   * Dense frames from the first 3 seconds.
   *
   * Sampled densely REGARDLESS of scene-change scores: a static talking-head
   * clip whose on-screen text swaps every 0.8s scores near zero on scene
   * detection and yields one keyframe, losing exactly the text sequence the
   * hook classifier needs.
   */
  hookFrames: Keyframe[]
  probe: ProbeResult
}

export interface MediaProvider {
  readonly name: string
  probe(videoPath: string): Promise<ProbeResult>
  /** Downloads to a local path. Returns the path. */
  fetch(url: string, destDir: string): Promise<string>
  extract(videoPath: string, videoId: number, workDir: string): Promise<MediaBundle>
  cleanup(bundle: MediaBundle): Promise<void>
}

// ---------------------------------------------------------------------------
// ASR
// ---------------------------------------------------------------------------

export interface TranscriptWord {
  word: string
  start: number
  end: number
}

export interface Transcript {
  text: string
  words: TranscriptWord[]
  language: string | null
  /** Words spoken before t=3.0s — the hook window. */
  hookText: string
  costUsd: number
}

export interface AsrProvider {
  readonly name: string
  transcribe(audioPath: string): Promise<Transcript>
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

/**
 * Constrained enum so clusters stay comparable across runs. An open-ended
 * label field produces a different taxonomy every week and nothing aggregates.
 */
export const HOOK_TYPES = [
  'direct_address',
  'question',
  'negative_claim',
  'result_reveal',
  'before_after',
  'listicle_countdown',
  'pattern_interrupt',
  'text_only_static',
  'duet_react',
  'pov_scenario',
  'price_reveal',
  'controversy_bait',
  'unknown',
] as const
export type HookType = (typeof HOOK_TYPES)[number]

export const CAPTION_STYLES = [
  'none',
  'burned_in_subtitles',
  'large_statement_text',
  'meme_top_bottom',
  'minimal_label',
  'unknown',
] as const
export type CaptionStyle = (typeof CAPTION_STYLES)[number]

export const AUDIO_TYPES = [
  'original_voiceover',
  'trending_sound',
  'music_only',
  'silent',
  'dialogue',
  'unknown',
] as const
export type AudioType = (typeof AUDIO_TYPES)[number]

export interface OnScreenText {
  tSeconds: number
  text: string
}

export interface VisionAnalysis {
  hookType: HookType
  /** Each distinct on-screen text state in the first 3s, with its timestamp. */
  hookTextSequence: OnScreenText[]
  spokenHook: string | null
  facePresent: boolean
  /** 0..1 — how much of the frame the largest face occupies. */
  faceScreenFraction: number | null
  cutCountFirst3s: number
  captionStyle: CaptionStyle
  audioType: AudioType
  /** Free-text format description, used as clustering input. */
  formatSummary: string
  modelVersion: string
  costUsd: number
}

export interface VisionProvider {
  readonly name: string
  analyse(bundle: MediaBundle, transcript: Transcript | null): Promise<VisionAnalysis>
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbeddingResult {
  vector: number[]
  dims: number
  model: string
  costUsd: number
}

export interface EmbeddingProvider {
  readonly name: string
  readonly dims: number
  embed(texts: string[]): Promise<EmbeddingResult[]>
}

/** pgvector wants a bracketed literal, not a JSON array. */
export function toPgVector(v: readonly number[]): string {
  return `[${v.join(',')}]`
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

export interface FrameHash {
  tSeconds: number
  /**
   * 256-bit PDQ perceptual hash as a 64-character hex string — the vPDQ
   * near-duplicate path (`DedupeProvider` / `VideoFingerprint`).
   *
   * NOTE: this is deliberately PDQ-256, not the 64-bit pHash used *internally*
   * by `MediaProvider.extract` to de-duplicate hook frames. Those two hashes
   * serve different jobs: pHash collapses near-identical frames while sampling
   * the hook; PDQ-256 fingerprints the whole clip for repost detection at
   * Hamming distance ~20. Only the PDQ hash is ever serialised to
   * `phash_frames bytea` and compared by `findDuplicates`.
   */
  hash: string
}

export interface VideoFingerprint {
  videoId: number
  frames: FrameHash[]
}

export interface DuplicateMatch {
  videoId: number
  /** Fraction of query frames matched within the distance threshold. */
  matchFraction: number
}

export interface DedupeProvider {
  readonly name: string
  fingerprint(bundle: MediaBundle): Promise<VideoFingerprint>
  /**
   * Default Hamming distance is deliberately TIGHTER than the vPDQ reference
   * (31). At the loose default you cannot separate "same creator reposting"
   * (dedupe it) from "different creator recreating the format" — and the
   * second one IS the product. Deduping it away destroys the signal.
   */
  findDuplicates(
    query: VideoFingerprint,
    corpus: readonly VideoFingerprint[],
    opts?: { maxDistance?: number; minMatchFraction?: number }
  ): DuplicateMatch[]
  serialise(fp: VideoFingerprint): Buffer
  deserialise(videoId: number, buf: Buffer): VideoFingerprint
}

export const DEFAULT_HAMMING_DISTANCE = 20
export const DEFAULT_MIN_MATCH_FRACTION = 0.8

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface AnalysisResult {
  videoId: number
  transcript: Transcript | null
  vision: VisionAnalysis | null
  embedding: EmbeddingResult | null
  fingerprint: VideoFingerprint | null
  duplicateOf: number | null
  totalCostUsd: number
  errors: string[]
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable = false,
    readonly costIncurredUsd = 0
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
