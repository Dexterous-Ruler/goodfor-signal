'use server'

/**
 * Live "test connection" checks. Makes a lightweight real API call with the
 * configured key and reports ok/detail. Never returns the key itself.
 */
import { resolve } from 'node:path'
import { loadEnv } from '@goodfor/db'
import { INTEGRATIONS } from './connections.js'

loadEnv(resolve(process.cwd(), '..', '..'))
loadEnv()

export interface TestResult { ok: boolean; detail: string }

async function ping(url: string, headers: Record<string, string> = {}): Promise<TestResult> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 8000)
  try {
    const r = await fetch(url, { headers, signal: ctl.signal })
    if (r.ok) return { ok: true, detail: 'connected' }
    if (r.status === 401 || r.status === 403) return { ok: false, detail: 'key rejected (401/403)' }
    return { ok: false, detail: `HTTP ${r.status}` }
  } catch {
    return { ok: false, detail: 'unreachable / timed out' }
  } finally {
    clearTimeout(t)
  }
}

export async function testConnection(id: string): Promise<TestResult> {
  const it = INTEGRATIONS.find((x) => x.id === id)
  if (!it) return { ok: false, detail: 'unknown integration' }
  const missing = it.envVars.filter((v) => !process.env[v]?.trim())
  if (missing.length) return { ok: false, detail: 'not configured' }

  switch (id) {
    case 'groq':
      return ping('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${process.env.GROQ_API_KEY}` })
    case 'openai':
      return ping('https://api.openai.com/v1/models', { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` })
    case 'gemini':
      return ping(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`)
    case 'ensembledata':
      return ping(`https://ensembledata.com/apis/customer/get-used-units?token=${process.env.ENSEMBLEDATA_TOKEN}`)
    default:
      // Non-pingable here (OAuth / signed JWT / paid vendors) — verified on first live use.
      return { ok: false, detail: 'configured — verified on first live call' }
  }
}
