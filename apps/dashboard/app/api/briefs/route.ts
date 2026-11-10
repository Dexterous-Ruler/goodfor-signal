import { db, readJson } from '../../../lib/write'
import { buildBrief, type BuildBriefInput, type AccountType } from '@goodfor/briefs'
import type { HookType } from '@goodfor/contracts'
import type { Database } from '@goodfor/db'

type BriefInsert = Database['public']['Tables']['brief']['Insert']

// Content briefs. Read-plane CRM write (no TikTok, no write-plane secret).
// POST /api/briefs  -> validate with @goodfor/briefs.buildBrief, then insert.
// GET  /api/briefs  -> list the most recent briefs.
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const b = await readJson(req)

  const input: BuildBriefInput = {
    appSlug: typeof b.appSlug === 'string' && b.appSlug ? b.appSlug : 'goodfor',
    hookType: (typeof b.hookType === 'string' ? b.hookType : 'unknown') as HookType,
    targetAccount: { accountType: (b.accountType === 'business' ? 'business' : 'creator') as AccountType },
    sound: {
      soundId: typeof b.soundId === 'string' ? b.soundId : null,
      soundIsCml: b.soundIsCml === true,
    },
    competitorInspirationId: typeof b.competitorInspirationId === 'number' ? b.competitorInspirationId : null,
    formatClusterId: typeof b.formatClusterId === 'number' ? b.formatClusterId : null,
    competitorClaims: Array.isArray(b.competitorClaims) ? (b.competitorClaims as BuildBriefInput['competitorClaims']) : [],
  }

  // buildBrief is a pure validator: it returns a persist-ready row (snake_case)
  // and any blocking errors (which keep status at 'draft', e.g. the CML sound gate).
  const { brief, errors } = buildBrief(input)

  const client = db()
  const { data, error } = await client
    .from('brief')
    .insert(brief as unknown as BriefInsert)
    .select('id, status')
    .single()
  if (error) return Response.json({ error: error.message, validation: errors }, { status: 500 })

  return Response.json({ ok: true, id: data.id, status: data.status, warnings: errors })
}

export async function GET() {
  const client = db()
  const { data, error } = await client
    .from('brief')
    .select('id, app_slug, hook_type, target_account_type, status, created_at')
    .order('created_at', { ascending: false })
    .limit(25)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ briefs: data ?? [] })
}
