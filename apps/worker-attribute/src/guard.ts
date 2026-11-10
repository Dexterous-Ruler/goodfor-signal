/**
 * Plane-isolation boot guard (Phase 4, mirrors apps/worker-write/src/guard.ts).
 *
 * Attribution is the WRITE plane: it holds Goodfor's own MMP (Kochava) keys and
 * Apple App Store Connect credentials. It must NEVER share compute, egress, or
 * secrets with the READ plane (§14 risk 2, High). This guard is the
 * process-level enforcement: `worker-attribute` must never have a read-plane
 * credential in its env. If a deploy bleeds `ENSEMBLEDATA_TOKEN` /
 * `SCRAPECREATORS_API_KEY` into this process, we fail loudly at boot rather than
 * run a plane-crossing service.
 *
 * This is a deliberately independent, self-contained copy — it imports NOTHING
 * from another app (the two planes share no code). Call `assertWritePlane()` in
 * every entrypoint, right after `loadEnv()`.
 */

/** Read-plane credentials that must never be visible to the write plane. */
export const READ_PLANE_VARS = ['ENSEMBLEDATA_TOKEN', 'SCRAPECREATORS_API_KEY'] as const

/**
 * Throw if any read-plane credential is present with a NON-EMPTY value. A blank
 * value (template placeholder materialised as '' by dotenv) is treated as
 * absent; only a real, non-empty value is a plane-isolation violation. `env` is
 * injectable so tests can exercise it without mutating `process.env`.
 */
export function assertWritePlane(env: Record<string, string | undefined> = process.env): void {
  const present = READ_PLANE_VARS.filter((k) => {
    const v = env[k]
    return typeof v === 'string' && v.trim() !== ''
  })
  if (present.length > 0) {
    throw new Error(
      `[worker-attribute] plane isolation violation: read-plane env var(s) present in the write ` +
        `plane: ${present.join(', ')}. The attribution worker must run as a separate write-plane ` +
        `deployment with its own secret bundle (KOCHAVA_* / APP_STORE_CONNECT_* / DATABASE_URL) and separate ` +
        `egress. A scraping complaint must never be able to reach these keys. Remove the read-plane ` +
        `credentials from this process before starting it.`
    )
  }
}
