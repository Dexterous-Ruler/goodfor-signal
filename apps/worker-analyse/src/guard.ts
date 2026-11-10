/**
 * Read-plane isolation guard for worker-analyse. Identical policy to
 * apps/worker-read/src/guard.ts (the analyse worker deploys on the READ plane).
 * Duplicated intentionally: no cross-app import, and the two planes share no
 * guard code. Call `assertReadPlane()` in every analyse entrypoint after loadEnv.
 */
export const WRITE_PLANE_VARS = ['TIKTOK_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'] as const

export function assertReadPlane(env: Record<string, string | undefined> = process.env): void {
  const foreign = WRITE_PLANE_VARS.filter((k) => {
    const v = env[k]
    return typeof v === 'string' && v.trim() !== ''
  })
  if (foreign.length > 0) {
    throw new Error(
      `[worker-analyse] plane isolation violation: write-plane env var(s) present in the read ` +
        `plane: ${foreign.join(', ')}. The read plane must run as a separate deployment with a ` +
        `read-plane-only secret bundle. Remove the write-plane credentials before starting it.`
    )
  }
}
