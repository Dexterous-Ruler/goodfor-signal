/**
 * Token vault — AES-256-GCM envelope encryption for OAuth tokens at rest.
 *
 * `owned_account.access_token` / `refresh_token` are `bytea` and must NEVER
 * hold plaintext (see the column comments in the init migration). Everything
 * here is pure `node:crypto`; the key is a base64-encoded 32-byte value from
 * `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`). In prod this is the
 * envelope layer under a KMS-managed key.
 *
 * Ciphertext layout (a single Buffer, exactly as stored in `bytea`):
 *
 *   iv (12 bytes) ‖ authTag (16 bytes) ‖ ciphertext (n bytes)
 *
 * `openToken` reverses it and THROWS on a wrong key or a tampered tag/body —
 * GCM authentication is the whole point, so a silent-wrong-plaintext path must
 * never exist.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

/**
 * Resolve the 32-byte key. Accepts a raw Buffer (already 32 bytes) or a
 * base64 string; defaults to `TOKEN_ENCRYPTION_KEY`. Throws at call time — not
 * at import — if the key is missing or the wrong length, so a misconfigured
 * process fails loudly instead of encrypting under a truncated key.
 */
function resolveKey(key?: string | Buffer): Buffer {
  const raw = key ?? process.env.TOKEN_ENCRYPTION_KEY
  if (raw === undefined || raw === null || raw === '') {
    throw new PublishingKeyError(
      'TOKEN_ENCRYPTION_KEY is not set — cannot seal/open tokens (generate with `openssl rand -base64 32`)'
    )
  }
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'base64')
  if (buf.length !== KEY_LEN) {
    throw new PublishingKeyError(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_LEN} bytes, got ${buf.length}`
    )
  }
  return buf
}

export class PublishingKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishingKeyError'
  }
}

/** Encrypts `plaintext` → `iv ‖ authTag ‖ ciphertext` Buffer (store in bytea). */
export function sealToken(plaintext: string, key?: string | Buffer): Buffer {
  const k = resolveKey(key)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag() // 16 bytes
  return Buffer.concat([iv, tag, enc])
}

/** Reverses `sealToken`. Throws on wrong key or tampered iv/tag/ciphertext. */
export function openToken(sealed: Buffer | Uint8Array, key?: string | Buffer): string {
  const k = resolveKey(key)
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed)
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new PublishingKeyError('sealed token is too short to contain iv + authTag')
  }
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const data = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', k, iv)
  decipher.setAuthTag(tag)
  // `final()` throws 'Unsupported state or unable to authenticate data' when
  // the tag does not verify — i.e. wrong key or any tampered byte.
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
