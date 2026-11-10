import { resolve } from 'node:path'
import { db, loadEnv } from '@goodfor/db'

// Next only reads .env.local from the app directory, but in this monorepo it
// lives at the repo root. Load both, root first. (Mirrors lib/queries.ts.)
loadEnv(resolve(process.cwd(), '..', '..'))
loadEnv()

/**
 * Server-only. Uses the service-role client, which bypasses RLS — never import
 * this from a client component.
 */

export interface SearchAccount {
  id: number
  username: string
  displayName: string | null
  followerCount: number | null
}

export interface SearchVideo {
  id: number
  platformVideoId: string
  description: string | null
  username: string
  postedAt: string
}

export interface SearchCreator {
  id: number
  username: string | null
  platform: string
  url: string | null
  followers: number | null
}

export interface SearchResults {
  accounts: SearchAccount[]
  videos: SearchVideo[]
  creators: SearchCreator[]
}

const CAP = 10
const empty = (): SearchResults => ({ accounts: [], videos: [], creators: [] })

/**
 * Global search across the read plane (competitor accounts + tracked videos)
 * and the creator CRM. Returns small, grouped, capped result sets.
 */
export async function searchAll(q: string): Promise<SearchResults> {
  const term = (q ?? '').trim()
  if (!term) return empty()

  // Strip characters that are structural inside a PostgREST .or() filter and
  // the ilike pattern (comma/paren separate clauses; %, _ and * are wildcards)
  // so a stray character can neither break the filter nor widen the match.
  const safe = term.replace(/[%_,()\\*]/g, ' ').trim()
  if (!safe) return empty()
  const pat = `%${safe}%`

  const client = db()
  const [accRes, vidRes, creRes] = await Promise.all([
    client
      .from('competitor_account')
      .select('id, username, display_name, follower_count')
      .or(`username.ilike.${pat},display_name.ilike.${pat}`)
      .order('follower_count', { ascending: false, nullsFirst: false })
      .limit(CAP),
    client
      .from('tracked_video')
      .select('id, platform_video_id, description, created_at_tiktok, competitor_account!inner ( username )')
      .ilike('description', pat)
      .order('created_at_tiktok', { ascending: false })
      .limit(CAP),
    client
      .from('creator_account')
      .select('id, username, platform, url, followers')
      .ilike('username', pat)
      .order('followers', { ascending: false, nullsFirst: false })
      .limit(CAP),
  ])

  if (accRes.error) throw accRes.error
  if (vidRes.error) throw vidRes.error
  if (creRes.error) throw creRes.error

  const accounts: SearchAccount[] = (accRes.data ?? []).map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    followerCount: r.follower_count === null ? null : Number(r.follower_count),
  }))

  const videos: SearchVideo[] = (vidRes.data ?? []).map((r) => {
    const a = r.competitor_account as unknown as { username: string }
    return {
      id: r.id,
      platformVideoId: r.platform_video_id,
      description: r.description,
      username: a.username,
      postedAt: r.created_at_tiktok,
    }
  })

  const creators: SearchCreator[] = (creRes.data ?? []).map((r) => ({
    id: r.id,
    username: r.username,
    platform: r.platform,
    url: r.url,
    followers: r.followers === null ? null : Number(r.followers),
  }))

  return { accounts, videos, creators }
}
