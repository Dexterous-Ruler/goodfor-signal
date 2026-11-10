/**
 * Live provider smoke test — validates each Phase 2 provider against the REAL
 * external tool/API, one at a time, and prints a status table. Run:
 *
 *   npm run smoke
 *
 * It needs no database. Each check runs a live call ONLY if its prerequisite
 * (an API key, or ffmpeg/python on PATH) is present, otherwise it SKIPs with a
 * reason. As you add keys to .env.local the row flips from SKIP to PASS/FAIL,
 * so you can validate the pipeline provider-by-provider.
 *
 *   media       — real ffmpeg/ffprobe (generates a test clip, probes, extracts)
 *   embeddings  — real OpenAI call            (needs OPENAI_API_KEY)
 *   asr         — real Groq transcription     (needs GROQ_API_KEY)
 *   vision      — real Gemini native-video    (needs GEMINI_API_KEY / GOOGLE_API_KEY)
 *   dedupe      — real vpdq.py fingerprint     (needs python + numpy; pdqhash optional)
 *   clustering  — real cluster.py refit        (needs python + bertopic/umap/hdbscan)
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadEnv } from '@goodfor/db'
import type { MediaBundle, Transcript } from '@goodfor/contracts'
import { FfmpegMediaProvider } from '@goodfor/media'
import { GroqAsrProvider } from '@goodfor/asr'
import { GeminiVisionProvider } from '@goodfor/vision'
import { OpenAiEmbeddingProvider } from '@goodfor/embeddings'
import { BertopicClusterer, VpdqDedupeProvider } from '@goodfor/clustering'

// Load .env.local from the repo root (two levels up from apps/worker-analyse) and cwd.
loadEnv(resolve(process.cwd(), '..', '..'))
loadEnv()

type Status = 'PASS' | 'FAIL' | 'SKIP'
interface Row {
  name: string
  status: Status
  ms: number
  detail: string
}
const rows: Row[] = []

async function check(
  name: string,
  prereq: { ok: boolean; skip?: string },
  fn: () => Promise<string>
): Promise<void> {
  if (!prereq.ok) {
    rows.push({ name, status: 'SKIP', ms: 0, detail: prereq.skip ?? 'prerequisite missing' })
    return
  }
  const t0 = Date.now()
  try {
    const detail = await fn()
    rows.push({ name, status: 'PASS', ms: Date.now() - t0, detail })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    rows.push({ name, status: 'FAIL', ms: Date.now() - t0, detail: msg.replace(/\s+/g, ' ').slice(0, 160) })
  }
}

/** Minimal spawn wrapper — used only to generate the test clip and detect python. */
function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const c = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    c.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    c.on('error', () => res({ code: -1, stdout, stderr: stderr || 'spawn error' }))
    c.on('close', (code) => res({ code: code ?? 0, stdout, stderr }))
  })
}

async function detectPython(): Promise<string | null> {
  for (const bin of [process.env.PYTHON_BIN, 'python', 'python3', 'py'].filter(Boolean) as string[]) {
    const r = await run(bin, ['--version'])
    if (r.code === 0) return bin
  }
  return null
}

async function main(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'goodfor-smoke-'))
  const clip = join(work, 'clip.mp4')
  const pythonBin = await detectPython()
  if (pythonBin) process.env.PYTHON_BIN = pythonBin

  const hasOpenAi = !!process.env.OPENAI_API_KEY
  const hasGroq = !!process.env.GROQ_API_KEY
  const hasGemini = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)

  // Generate a 4s test clip (colour bars + 440Hz tone) so media/asr/vision/dedupe
  // have something real to chew on without a live TikTok URL.
  const gen = await run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-shortest', '-pix_fmt', 'yuv420p', clip,
  ])
  const clipOk = gen.code === 0

  const media = new FfmpegMediaProvider()
  // Holder object, not a bare `let` — the reassignment happens inside the media
  // check's callback, which TS control-flow won't propagate to the outer scope,
  // so a bare local would narrow to `never` in the later checks. A property read
  // keeps the `MediaBundle | null` type honest.
  const state: { bundle: MediaBundle | null } = { bundle: null }

  // 1. media — real ffmpeg/ffprobe
  await check('media (ffmpeg)', { ok: clipOk, skip: 'ffmpeg not on PATH / clip gen failed' }, async () => {
    const probe = await media.probe(clip)
    const b = await media.extract(clip, 1, join(work, 'bundle'))
    state.bundle = b
    return `probe ${probe.width}x${probe.height} ${probe.durationS.toFixed(1)}s audio=${probe.hasAudio}; ` +
      `wav=${b.audioPath ? 'yes' : 'no'} keyframes=${b.keyframes.length} hookFrames=${b.hookFrames.length}`
  })

  // 2. embeddings — real OpenAI call
  await check('embeddings (OpenAI)', { ok: hasOpenAi, skip: 'set OPENAI_API_KEY' }, async () => {
    const p = new OpenAiEmbeddingProvider()
    const [r] = await p.embed(['hook: wait, before you scroll — watch this'])
    if (!r) throw new Error('no embedding returned')
    if (r.dims !== 1536 || r.vector.length !== 1536) throw new Error(`expected 1536 dims, got ${r.vector.length}`)
    return `${r.model} dims=${r.vector.length} cost=$${r.costUsd.toFixed(6)}`
  })

  // 3. asr — real Groq transcription (of the test tone; validates the API + cost path)
  await check('asr (Groq)', { ok: hasGroq && !!(state.bundle && state.bundle.audioPath), skip: hasGroq ? 'no audio bundle' : 'set GROQ_API_KEY' }, async () => {
    const p = new GroqAsrProvider()
    const t = await p.transcribe(state.bundle!.audioPath as string)
    return `lang=${t.language ?? '?'} words=${t.words.length} hook="${t.hookText.slice(0, 40)}" cost=$${t.costUsd.toFixed(6)}`
  })

  // 4. vision — real Gemini native-video analysis
  await check('vision (Gemini)', { ok: hasGemini && !!state.bundle, skip: hasGemini ? 'no media bundle' : 'set GEMINI_API_KEY' }, async () => {
    const p = new GeminiVisionProvider()
    const v = await p.analyse(state.bundle!, null as Transcript | null)
    return `hook=${v.hookType} caption=${v.captionStyle} cuts=${v.cutCountFirst3s} model=${v.modelVersion} cost=$${v.costUsd.toFixed(6)}`
  })

  // 5. dedupe — real vpdq.py fingerprint
  await check('dedupe (vpdq.py)', { ok: !!pythonBin && !!state.bundle, skip: pythonBin ? 'no media bundle' : 'python not found' }, async () => {
    const p = new VpdqDedupeProvider({ pythonPath: pythonBin as string })
    const fp = await p.fingerprint(state.bundle!)
    return `frames=${fp.frames.length} hashBits≈${(fp.frames[0]?.hash.length ?? 0) * 4}`
  })

  // 6. clustering — real cluster.py refit over synthetic embeddings
  await check('clustering (cluster.py)', { ok: !!pythonBin, skip: 'python not found' }, async () => {
    const c = new BertopicClusterer({ pythonPath: pythonBin as string })
    // Two rough groups of 30 so UMAP (n_neighbors=15) has enough training points
    // and HDBSCAN (min_cluster_size≈25) can actually form clusters. The first run
    // pays a one-time ~60s numba JIT compile.
    const items = Array.from({ length: 60 }, (_, i) => {
      const groupA = i < 30
      return {
        videoId: i + 1,
        embedding: Array.from({ length: 1536 }, (_, j) =>
          (groupA ? Math.sin(j * 0.01) : Math.cos(j * 0.01)) + Math.sin(i * 7.3 + j) * 0.02
        ),
      }
    })
    const res = await c.refit(items)
    return `clusters=${res.clusters.length} assignments=${res.assignments.length}`
  })

  await rm(work, { recursive: true, force: true }).catch(() => {})

  // ---- report ----
  const pad = (s: string, n: number) => s.padEnd(n)
  const icon = (s: Status) => (s === 'PASS' ? '✅' : s === 'FAIL' ? '❌' : '⚪')
  console.log('\n  Goodfor Phase 2 — live provider smoke test')
  console.log('  ' + '─'.repeat(78))
  console.log(`  ${pad('PROVIDER', 22)} ${pad('STATUS', 8)} ${pad('TIME', 8)} DETAIL`)
  console.log('  ' + '─'.repeat(78))
  for (const r of rows) {
    console.log(`  ${pad(r.name, 22)} ${icon(r.status)} ${pad(r.status, 5)} ${pad(r.ms ? r.ms + 'ms' : '-', 8)} ${r.detail}`)
  }
  console.log('  ' + '─'.repeat(78))
  const pass = rows.filter((r) => r.status === 'PASS').length
  const fail = rows.filter((r) => r.status === 'FAIL').length
  const skip = rows.filter((r) => r.status === 'SKIP').length
  console.log(`  ${pass} passed · ${fail} failed · ${skip} skipped`)
  if (skip) console.log('  Skipped rows just need their key/tool — add it to .env.local and re-run `npm run smoke`.')
  console.log('')
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
