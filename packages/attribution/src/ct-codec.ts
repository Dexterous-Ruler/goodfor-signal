/**
 * Apple campaign-link `ct` codec (PHASE-4-attribute.md §10.3).
 *
 * Apple's `ct` (campaign token) is capped at 30 alphanumeric chars, and both
 * `pt` AND `ct` are required or nothing registers. Our campaign keys (e.g. a
 * format-cluster descriptor) are longer and non-alphanumeric, so we assign each
 * a compact base36 code and keep a lookup table mapping code <-> key.
 *
 * Pure: the lookup table is in-memory and seedable/observable via callbacks —
 * the worker persists it (`custom_product_page.ct_code`). No I/O here.
 */

export const CT_MAX_LEN = 30
const CT_RE = /^[a-z0-9]{1,30}$/i
const BASE36 = /^[0-9a-z]+$/

/** A `ct` code is valid iff it is 1–30 alphanumeric chars. */
export function isValidCt(code: string): boolean {
  return CT_RE.test(code)
}

/** Throw unless `code` is a legal `ct` (≤30 alphanumeric). */
export function assertValidCt(code: string): void {
  if (!isValidCt(code)) {
    throw new Error(`invalid ct code '${code}': must be 1-${CT_MAX_LEN} alphanumeric chars`)
  }
}

/** Base36-encode a non-negative integer. */
export function encodeBase36(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`encodeBase36 needs a non-negative integer, got ${n}`)
  return n.toString(36)
}

/** Decode a base36 string back to an integer. */
export function decodeBase36(code: string): number {
  if (!BASE36.test(code.toLowerCase())) throw new Error(`not a base36 code: '${code}'`)
  return parseInt(code, 36)
}

export interface CtCodecOptions {
  /** Called whenever a NEW (key -> code) mapping is assigned, for persistence. */
  onAssign?: (key: string, code: string) => void
  /**
   * The counter seed for auto-assigned codes. Codes are `prefix + base36(seq)`.
   * Default 0. Pass the current max so a restarted process never re-issues a
   * code (the persisted table is the system of record).
   */
  startSeq?: number
  /** Optional constant prefix so codes are recognisable, e.g. 'f' for format. */
  prefix?: string
}

/**
 * A bidirectional key<->ct lookup table. Seed it from persistence, then call
 * `codeFor(key)` — it returns the existing code or assigns the next base36 one
 * (firing `onAssign` so the caller can persist it). Every code is guaranteed
 * ≤30 alphanumeric chars.
 */
export class CtCodec {
  private readonly byKey = new Map<string, string>()
  private readonly byCode = new Map<string, string>()
  private seq: number
  private readonly prefix: string
  private readonly onAssign?: (key: string, code: string) => void

  constructor(entries: Iterable<readonly [string, string]> = [], opts: CtCodecOptions = {}) {
    this.seq = opts.startSeq ?? 0
    this.prefix = opts.prefix ?? ''
    this.onAssign = opts.onAssign
    for (const [key, code] of entries) this.register(key, code)
  }

  /** Seed / pin an explicit mapping (validates the code). Idempotent per key. */
  register(key: string, code: string): void {
    assertValidCt(code)
    const existing = this.byKey.get(key)
    if (existing && existing !== code) {
      throw new Error(`key '${key}' already mapped to '${existing}', cannot remap to '${code}'`)
    }
    const owner = this.byCode.get(code)
    if (owner && owner !== key) {
      throw new Error(`ct code '${code}' already used by key '${owner}'`)
    }
    this.byKey.set(key, code)
    this.byCode.set(code, key)
  }

  /** Return the existing code for `key`, or assign + persist the next one. */
  codeFor(key: string): string {
    const existing = this.byKey.get(key)
    if (existing) return existing

    // Advance the counter past any code already taken (seeded pins).
    let code = ''
    do {
      code = this.prefix + encodeBase36(this.seq++)
    } while (this.byCode.has(code))
    assertValidCt(code)

    this.byKey.set(key, code)
    this.byCode.set(code, key)
    this.onAssign?.(key, code)
    return code
  }

  /** Reverse lookup: the campaign key for a `ct` code, or null. */
  keyFor(code: string): string | null {
    return this.byCode.get(code) ?? null
  }

  /** All (key, code) pairs — for persistence / inspection. */
  entries(): [string, string][] {
    return [...this.byKey.entries()]
  }
}
