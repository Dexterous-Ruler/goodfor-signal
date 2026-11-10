/**
 * Read-plane isolation guard (Phase 3 §Week-11 task 1). The READ plane must
 * NEVER hold a WRITE-plane secret. Symmetric to apps/worker-write/src/guard.ts;
 * imports NOTHING from any write-plane package — the two planes share no code.
 *
 * A blank value (e.g. `TOKEN_ENCRYPTION_KEY=` copied from a template) is treated
 * as absent — dotenv materialises it as an empty string; only a real, non-empty
 * value is a plane-isolation violation. `env` is injectable so tests can
 * exercise it without mutating `process.env`.
 *
 * Call `assertReadPlane()` in EVERY read-plane entrypoint (tick, trends, analyse
 * and its one-shots), right after `loadEnv()`.
 */
export const WRITE_PLANE_VARS = ['TIKTOK_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'] as const

export function assertReadPlane(env: Record<string, string | undefined> = process.env): void {
  const foreign = WRITE_PLANE_VARS.filter((k) => {
    const v = env[k]
    return typeof v === 'string' && v.trim() !== ''
  })
  if (foreign.length > 0) {
    throw new Error(
      `[worker-read] plane isolation violation: write-plane env var(s) present in the read ` +
        `plane: ${foreign.join(', ')}. The read plane must run as a separate deployment with a ` +
        `read-plane-only secret bundle. Remove the write-plane credentials before starting it.`
    )
  }
}
