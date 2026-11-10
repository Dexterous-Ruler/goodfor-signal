'use server'

import { resolve } from 'node:path'
import { revalidatePath } from 'next/cache'
import { db, loadEnv } from '@goodfor/db'

// Monorepo env lives at the repo root as well as the app dir; load both, root
// first (mirrors lib/queries.ts). Needed before any db() call reads process.env.
loadEnv(resolve(process.cwd(), '..', '..'))
loadEnv()

/**
 * Server actions for the dashboard's backend-integration layer.
 *
 * Plane isolation: the read-plane vendor poll and the analysis run both live in
 * separate worker processes (already built). Nothing here runs those inline.
 * This module only revalidates rendered data and enqueues a video for the
 * analysis worker to pick up.
 */

// Every dashboard route that reads the DB, so a refresh re-fetches all of them.
const DASHBOARD_PATHS = [
  '/',
  '/accounts',
  '/trends',
  '/formats',
  '/publishing',
  '/attribution',
  '/creators',
] as const

/** Re-fetch server-rendered data for every dashboard page. */
export async function refreshData(): Promise<{ ok: true }> {
  for (const path of DASHBOARD_PATHS) revalidatePath(path)
  return { ok: true }
}

/**
 * Enqueue a video for the analysis worker. Idempotent: analysis_queue has one
 * row per video (video_id is unique), so a re-enqueue is ON CONFLICT DO NOTHING
 * rather than resetting an in-flight or completed job.
 */
export async function enqueueForAnalysis(videoId: number): Promise<{ ok: true }> {
  const client = db()
  const { error } = await client
    .from('analysis_queue')
    .upsert(
      { video_id: videoId, reason: 'manual', priority: 5 },
      { onConflict: 'video_id', ignoreDuplicates: true },
    )
  if (error) throw error
  revalidatePath('/formats')
  return { ok: true }
}
