import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import type { Database } from './database.types.js'

export { loadEnv } from './env.js'
export type { Database }
export type Db = SupabaseClient<Database>

export type TrackedVideo = Database['public']['Tables']['tracked_video']['Row']
export type CompetitorAccount = Database['public']['Tables']['competitor_account']['Row']
export type MetricSnapshot = Database['public']['Tables']['video_metric_snapshot']['Row']
export type VideoScore = Database['public']['Tables']['video_score']['Row']

let client: Db | undefined

/**
 * Service-role client. Server-side only — this key bypasses RLS.
 * Never import this package into anything that ships to a browser.
 */
export function db(): Db {
  if (client) return client

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Copy .env.example to .env.local.'
    )
  }

  client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // createClient eagerly constructs a realtime client, which looks for a
    // native WebSocket. That only exists from Node 22. We never use realtime,
    // but the constructor throws regardless, so hand it an implementation.
    // Remove once every runtime is on Node 22+.
    realtime: { transport: WebSocket as unknown as never },
  })
  return client
}
