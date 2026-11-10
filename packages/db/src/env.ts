import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Loads .env.local first, then .env as a fallback. Existing process env always
 * wins, so deployed environments (Vercel, Fly) are never overridden by a
 * stray local file.
 *
 * Call once at the top of every entrypoint, before importing anything that
 * reads process.env at module scope.
 */
export function loadEnv(cwd: string = process.cwd()): void {
  for (const file of ['.env.local', '.env']) {
    const path = resolve(cwd, file)
    if (existsSync(path)) config({ path, override: false })
  }
}
