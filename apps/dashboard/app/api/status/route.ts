import { resolve } from 'node:path'
import { NextResponse } from 'next/server'
import { db, loadEnv } from '@goodfor/db'

// Next only reads .env.local from the app directory, but in this monorepo it
// lives at the repo root. Load both, root first (mirrors lib/queries.ts).
loadEnv(resolve(process.cwd(), '..', '..'))
loadEnv()

export const dynamic = 'force-dynamic'

/**
 * Health + counts probe for the whole data layer. Read-only: head counts only,
 * so it is cheap enough to poll. Surfaces both planes (read plane = the vendor
 * poll's output; write plane = publishing) plus analysis progress. The actual
 * ingestion and analysis run as separate worker processes — this only reports.
 */
export async function GET() {
  try {
    const client = db()

    const head = async (
      table:
        | 'competitor_account'
        | 'tracked_video'
        | 'video_metric_snapshot'
        | 'video_analysis'
        | 'owned_account'
        | 'scheduled_post',
    ): Promise<number> => {
      const { count, error } = await client
        .from(table)
        .select('*', { count: 'exact', head: true })
      if (error) throw error
      return count ?? 0
    }

    const [accounts, videos, snapshots, analysed, ownedAccounts, scheduledPosts] =
      await Promise.all([
        head('competitor_account'),
        head('tracked_video'),
        head('video_metric_snapshot'),
        head('video_analysis'),
        head('owned_account'),
        head('scheduled_post'),
      ])

    const { count: pending, error: pendingError } = await client
      .from('analysis_queue')
      .select('*', { count: 'exact', head: true })
      .is('completed_at', null)
    if (pendingError) throw pendingError

    return NextResponse.json({
      db: 'ok',
      readPlane: { accounts, videos, snapshots },
      analysis: { analysed, pending: pending ?? 0 },
      writePlane: { ownedAccounts, scheduledPosts },
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
