/**
 * Integration registry + configuration status for the Connections hub.
 * Server-only. Reads process.env to report which credentials are set —
 * values are ALWAYS masked; full secrets are never returned.
 */
import { resolve } from 'node:path'
import { loadEnv } from '@goodfor/db'

loadEnv(resolve(process.cwd(), '..', '..'))
loadEnv()

export type Plane = 'read' | 'ai' | 'write' | 'attribution' | 'creators'

export interface Integration {
  id: string
  name: string
  envVars: string[]
  plane: Plane
  unlocks: string
  signupUrl: string
  note: string
  testable: boolean
}

export const PLANE_LABEL: Record<Plane, { title: string; note: string }> = {
  read: { title: 'Read plane', note: 'Competitor intelligence — the highest-value unlock' },
  ai: { title: 'AI analysis', note: 'Transcription, vision, embeddings (already configured)' },
  write: { title: 'Write plane', note: 'Publishing to your own accounts' },
  attribution: { title: 'Attribution', note: 'Install → subscription measurement' },
  creators: { title: 'Creators', note: 'UGC creator discovery & CRM' },
}

export const INTEGRATIONS: Integration[] = [
  { id: 'ensembledata', name: 'EnsembleData', envVars: ['ENSEMBLEDATA_TOKEN'], plane: 'read', unlocks: 'C6', signupUrl: 'https://ensembledata.com', note: 'Primary competitor-data vendor — lights up the entire read plane.', testable: true },
  { id: 'scrapecreators', name: 'ScrapeCreators', envVars: ['SCRAPECREATORS_API_KEY'], plane: 'read', unlocks: 'C6', signupUrl: 'https://scrapecreators.com', note: 'Optional failover vendor. Not required to start.', testable: false },
  { id: 'groq', name: 'Groq · ASR', envVars: ['GROQ_API_KEY'], plane: 'ai', unlocks: 'C7', signupUrl: 'https://console.groq.com/keys', note: 'whisper-large-v3-turbo transcription.', testable: true },
  { id: 'gemini', name: 'Gemini · vision', envVars: ['GEMINI_API_KEY'], plane: 'ai', unlocks: 'C7', signupUrl: 'https://aistudio.google.com/apikey', note: 'Native-video hook & format analysis.', testable: true },
  { id: 'openai', name: 'OpenAI · embeddings', envVars: ['OPENAI_API_KEY'], plane: 'ai', unlocks: 'C7', signupUrl: 'https://platform.openai.com/api-keys', note: 'text-embedding-3-small for clustering.', testable: true },
  { id: 'tiktok', name: 'TikTok app', envVars: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'], plane: 'write', unlocks: 'C8', signupUrl: 'https://developers.tiktok.com', note: 'Draft/inbox publishing (scope video.upload — never video.publish).', testable: false },
  { id: 'tiktokbiz', name: 'TikTok Business', envVars: ['TIKTOK_BUSINESS_APP_ID', 'TIKTOK_BUSINESS_SECRET'], plane: 'write', unlocks: 'C8', signupUrl: 'https://business-api.tiktok.com', note: 'Own-account insights + Spark Ads linking.', testable: false },
  { id: 'kochava', name: 'Kochava · MMP', envVars: ['KOCHAVA_API_KEY', 'KOCHAVA_APP_GUID'], plane: 'attribution', unlocks: 'C9', signupUrl: 'https://www.kochava.com', note: 'Free-tier owned-media attribution.', testable: false },
  { id: 'apple', name: 'Apple App Store Connect', envVars: ['APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID', 'APP_STORE_CONNECT_PRIVATE_KEY'], plane: 'attribution', unlocks: 'C9', signupUrl: 'https://appstoreconnect.apple.com', note: 'iOS channel control-total (Analytics Reports API).', testable: false },
  { id: 'modash', name: 'Modash', envVars: ['MODASH_API_KEY'], plane: 'creators', unlocks: 'C9', signupUrl: 'https://www.modash.io', note: 'Creator discovery. $16,200/yr floor — sign off first.', testable: false },
  { id: 'hypeauditor', name: 'HypeAuditor', envVars: ['HYPEAUDITOR_API_TOKEN'], plane: 'creators', unlocks: 'C9', signupUrl: 'https://hypeauditor.com', note: 'Audience quality score (free sandbox).', testable: false },
]

function mask(v: string): string {
  if (v.length <= 8) return '••••'
  return v.slice(0, 3) + '…' + v.slice(-4)
}

export interface ConnStatus {
  id: string
  configured: boolean
  present: { name: string; masked: string }[]
  missing: string[]
}

export function getConnectionStatus(): ConnStatus[] {
  return INTEGRATIONS.map((it) => {
    const present: { name: string; masked: string }[] = []
    const missing: string[] = []
    for (const v of it.envVars) {
      const val = process.env[v]
      if (val && val.trim()) present.push({ name: v, masked: mask(val.trim()) })
      else missing.push(v)
    }
    return { id: it.id, configured: missing.length === 0, present, missing }
  })
}
