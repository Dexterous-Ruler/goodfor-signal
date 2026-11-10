/**
 * Plane-isolation boot guard (Phase 3 §Week-11 task 1, risk "Scraping complaint
 * jeopardises the authenticated API client").
 *
 * The WRITE plane and the READ plane share NO compute, egress IP, credentials,
 * or TikTok accounts. This guard is the process-level enforcement of that on the
 * write side: `worker-write` must NEVER have a read-plane credential in its env.
 * If a deploy ever bleeds `ENSEMBLEDATA_TOKEN` / `SCRAPECREATORS_API_KEY` into
 * this process, we fail loudly at boot rather than run a plane-crossing service.
 *
 * The symmetric check lives inline in `apps/worker-read/src/tick.ts`
 * (`assertReadPlane`) — it throws if a WRITE-plane secret
 * (`TIKTOK_CLIENT_SECRET` / `TOKEN_ENCRYPTION_KEY`) is present. Neither guard
 * imports the other plane's packages; the two are deliberately independent.
 *
 * Call `assertWritePlane()` in every entrypoint, right after `loadEnv()`.
 */

/** Read-plane credentials that must never be visible to the write plane. */
export const READ_PLANE_VARS = ['ENSEMBLEDATA_TOKEN', 'SCRAPECREATORS_API_KEY'] as const

/**
 * Throw if any read-plane credential is present with a NON-EMPTY value.
 *
 * A blank value (e.g. `ENSEMBLEDATA_TOKEN=` copied from `.env.example`) is
 * treated as absent — it is a template placeholder, not a live credential, and
 * dotenv materialises it as an empty string. Only a real, non-empty value is a
 * plane-isolation violation.
 *
 * `env` is injectable so tests can exercise it without mutating `process.env`.
 */
export function assertWritePlane(env: Record<string, string | undefined> = process.env): void {
  const present = READ_PLANE_VARS.filter((k) => {
    const v = env[k]
    return typeof v === 'string' && v.trim() !== ''
  })
  if (present.length > 0) {
    throw new Error(
      `[worker-write] plane isolation violation: read-plane env var(s) present in the write ` +
        `plane: ${present.join(', ')}. The write plane must run as a separate deployment with a ` +
        `write-plane-only secret bundle (TIKTOK_CLIENT_* / TOKEN_ENCRYPTION_KEY / DATABASE_URL). ` +
        `Remove the read-plane credentials from this process before starting it.`
    )
  }
}
