# Phase 2 — Understand (weeks 7–10)

> Cross-links: [System architecture](../00-ARCHITECTURE.md) · [Dashboard UX](../UI-UX-DASHBOARD.md) · prev: [Phase 1 — See](./PHASE-1-see.md) · next: [Phase 3 — Act](./PHASE-3-act-publishing.md)

**Status: BUILT — code-complete as of 2026-08-16.** All five providers (`media`, `asr`, `vision`, `embeddings`, `clustering` + Python sidecars), the `apps/worker-analyse` orchestrator, and the `worker-read → analysis_queue` enqueue wiring are implemented with **124 passing unit tests** and a **clean `tsc` build**. Before this runs in production: add live API keys (Groq / Gemini / OpenAI), close read-plane gap #1 (a playable competitor video URL — `resolvePlayableUrl` returns `null` on fixtures), **apply** the `vision_batch` migration, install the Python ML wheels under Python 3.11–3.12 (3.14 lacks wheels), and verify the Gemini/Groq/OpenAI request-and-response shapes against live APIs (every unverified boundary is flagged `UNVERIFIED` in code, same posture as `mapEnsembleVideo`).

The content-intelligence layer. Phase 1 tells you *which* competitor video is outperforming; Phase 2 tells you *why* — what the hook is, what format it belongs to, whether it is a genuine novel format or the fourth repost of one you already saw. It turns the alert queue into a **format taxonomy + hook-type distribution with measured per-type performance**, which is the raw material every brief in [Phase 3](./PHASE-3-act-publishing.md) is generated from.

This entire phase lives in the **READ plane**. The AI vendor calls here (Groq, Gemini, OpenAI embeddings) carry competitor video, audio, and transcript text — so they run on read-plane credentials and egress, never write-plane. Only **structured findings** (hook_type, format labels, cluster stats) ever cross the dashed boundary into brief generation. Never a competitor video file, audio, or verbatim transcript. See [../00-ARCHITECTURE.md](../00-ARCHITECTURE.md).

> Grounding: master spec [`completion.md`](../../completion.md) §6 (lines 429–536); schema in `supabase/migrations/20260815000001_init_tiktok_core.sql` (video_analysis) and `20260815000004_analysis.sql` (format_cluster, analysis_queue); contracts in `packages/contracts/src/index.ts`.

---

## Goal & definition of done

Take every video worth spending money on — alert-clearing videos synchronously, the rest of the corpus in a cheap batch lane — and produce:

1. A **transcript** with word timestamps (Groq ASR).
2. A **structured vision analysis**: `hook_type` (constrained enum), `hook_text_sequence[]`, `spoken_hook`, `face_present`, `face_screen_fraction`, `cut_count_first_3s`, `caption_style`, `audio_type`, `format_summary` (Gemini native video).
3. A **text embedding** of the transcript + format summary → `video_analysis.embedding halfvec(1536)`.
4. A **format cluster assignment** (weekly BERTopic re-fit, daily `approximate_predict`), with HDBSCAN's `-1` outliers surfaced as the **novel-format alert queue**.
5. A **near-duplicate verdict** (vPDQ at Hamming distance D≈20) so "same creator reposting" collapses but "different creator recreating the format" stays distinct.

**Done when:** the dashboard *Formats & hooks* page (`apps/dashboard/app/formats/page.tsx`, already built) renders a real hook-type distribution with median-z per type and a real cluster table — i.e. `getFormats`, `getHookPerformance`, `getAnalysisProgress` return non-empty — and per-video `cost_usd` is logged and inside the optimised-lane budget. This is the §15 exit criterion: *"format taxonomy + hook-type distribution with per-type performance."*

---

## Current state (what already exists in the codebase for this phase)

| Piece | State | Evidence |
|---|---|---|
| Analysis **contracts** (all 5 provider interfaces) | **Fully specified** | `packages/contracts/src/index.ts` — `MediaProvider`, `AsrProvider`, `VisionProvider`, `EmbeddingProvider`, `DedupeProvider`, `AnalysisResult`, `ProviderError`; constrained enums `HOOK_TYPES` (13), `CAPTION_STYLES`, `AUDIO_TYPES`; `toPgVector`; `DEFAULT_HAMMING_DISTANCE = 20`, `DEFAULT_MIN_MATCH_FRACTION = 0.8` |
| `video_analysis` **table + HNSW index** | **Live** | init migration lines 136–159: `embedding halfvec(1536)`, `hnsw (halfvec_cosine_ops) m=16 ef_construction=64`, all hook columns, `phash_frames bytea` |
| `format_cluster`, `analysis_queue` | **Live** | `20260815000004_analysis.sql`: cluster table (`id = -1` outlier bucket), work queue with `priority`/`reason`/`attempts`; adds `format_summary`, `spoken_hook_words`, `cost_usd`, `duplicate_of_video_id`, `analysis_errors` to `video_analysis` |
| Dashboard **read side** | **Built** | `getFormats`, `getHookPerformance`, `getAnalysisProgress` in `apps/dashboard/lib/queries.ts`; `formats/page.tsx` renders hooks + clusters + progress + spend |
| `packages/asr`, `packages/clustering` | **Empty shells** | `package.json` only; `main`/`types` point at a `src/index.ts` **that does not exist** — unresolvable workspace references |
| `packages/embeddings`, `packages/vision` | **Orphan probes** | **No `package.json`** → not registered workspaces; only 2-line compile probes (`embeddings/src/probe.ts`, `vision/src/__probe.ts`), vision importing contracts via a relative `../../contracts/src/index.js` path precisely because it isn't a package |
| `apps/worker-analyse` (the orchestrator) | **Missing** | `formats/page.tsx` line 66 already instructs `npx tsx apps/worker-analyse/src/run.ts --enqueue` — the app it names **does not exist**. Building it resolves the dangling reference the audit flagged. |

**Net:** the schema, the contract surface, and the entire dashboard read-side are done. **Everything that spends compute is unbuilt.** Zero code imports the contracts; the four packages are shells/probes; there is no analysis worker.

---

## Prerequisites (which prior-phase outputs are required)

From [Phase 1 — See](./PHASE-1-see.md):

- **A populated `tracked_video` / `video_metric_snapshot` corpus** — clustering needs 5k–15k analysed videos before `min_cluster_size` math is meaningful (§6.4). Analysis can start on day one but the taxonomy is noise until the corpus is large.
- **A working alert path** — Phase 2's sync lane is fed by alert-clearing videos (`shouldAlert`, z≥2.5 / age≤12h / views≥10k / α>0). The enqueue hook is added to `scoreAccount` here.
- **A live vendor key** — analysis needs the actual video URL to `ffmpeg`. On `FixtureSource` there is no downloadable media, so README gap #1 (wire `mapEnsembleVideo` to a live EnsembleData response) must be closed first, or analysis runs only on the demo backfill.
- **Read-plane isolation already provisioned** (Phase 0) — the Groq/Gemini/OpenAI keys and their egress belong to that isolated account.

From [Phase 0](./PHASE-0-foundations.md): the vendor bake-off (§4.5) should have settled which vendor's payloads you trust, because a video URL that 404s wastes an analysis spend.

---

## Tech & tools introduced in this phase (exact technologies/versions)

| Concern | Choice | Exact config / cost | Why (one reason) |
|---|---|---|---|
| Media prep | **ffmpeg** | audio → 16 kHz mono WAV; sparse keyframes; dense hook frames `ffmpeg -ss 0 -t 3 -vf fps=4` | Everything downstream wants extracted audio + frames, not a container |
| ASR | **Groq `whisper-large-v3-turbo`** | **$0.04/audio-hour**, `response_format=verbose_json`, min billed **10 s**, free tier 25 MB / Dev 100 MB | 9.0× cheaper than OpenAI Whisper ($0.36); word timestamps split the t<3.0 s hook |
| ASR fallback | **`faster-whisper` container** | same `AsrProvider` interface, **429 circuit-breaker only** | Self-hosting is a 2% saving that isn't worth it — keep it purely as a breaker |
| Vision | **Gemini (2.5 Flash / 3.1 Flash-Lite)** | 1 FPS, **258 tok/frame** (2.5 default) / 66 (2.5 low), **32 tok/audio-s**; audio billed on the **$1.00/M audio line** | Only Google of {OpenAI, Anthropic, Google} takes **native video**; Claude is first-frame-only |
| Vision batch | **Gemini Batch API** | **50% off**, jobs **expire after 48 h** | The ~420–450/day corpus feed is not latency-sensitive |
| Embeddings | **OpenAI `text-embedding-3-small`** | $0.02/M ≈ **$1.20/year**, 1536 dims → `halfvec(1536)` | A rounding error; choose on dimension, not price |
| Clustering | **BERTopic** (UMAP + HDBSCAN) | `UMAP(n_neighbors=15, n_components=5, min_dist=0.0, metric='cosine', random_state=42)` → `HDBSCAN(min_cluster_size=N, metric='euclidean', cluster_selection_method='eom', prediction_data=True)` | `prediction_data=True` → re-fit weekly, assign daily in ms |
| Cluster labels | **Gemini 2.5 Flash** | ~50 clusters × ~4k tok weekly ≈ **$0.05/week** | Cheap to relabel the whole taxonomy every week |
| Near-dup | **vPDQ** (+ FAISS binary index) | ~30 hashes/video as `bytea`; match distance **D≈20** (not the reference 31) | Variable-length hash matches trimmed/cropped/re-captioned reposts |

Python is unavoidable for BERTopic/UMAP/HDBSCAN and the vPDQ/FAISS path — those have no first-class Node equivalent. The clustering/dedupe packages are therefore **thin Node clients that shell out to a Python sidecar**; embeddings are computed in Node (OpenAI) and handed to Python as vectors, so UMAP re-runs over fixed embeddings (the spec's "compute embeddings once, re-run BERTopic over them", §6.4).

---

## Work breakdown — ordered, concrete tasks

### 1. Turn the four shells/probes into real packages

- **`packages/media`** (NEW — `MediaProvider` has no home today). `FfmpegMediaProvider`: `probe()`, `fetch(url, destDir)`, `extract()` → `MediaBundle` (16 kHz mono WAV; sparse keyframes; **dense `hookFrames` from the first 3 s at `fps=4`, pHash-deduped, sampled regardless of scene scores** — the contract already documents why: a talking-head whose text swaps every 0.8 s yields one scene keyframe and loses the hook sequence), `cleanup()`.
- **`packages/asr`** — replace the empty shell with `src/index.ts`. `GroqAsrProvider` (turbo, `verbose_json`, split `hookText` at t<3.0 s from word timestamps, report `costUsd`) + `FasterWhisperAsrProvider` (429 breaker, same interface).
- **`packages/vision`** — add a **`package.json`** (it is currently not a workspace) and a real `src/index.ts`. `GeminiVisionProvider` with two entry points: `analyse()` (sync) and `submitBatch()` / `fetchBatch()` (Batch API). Emits exactly `VisionAnalysis`; **reads on-screen text inside the same call** (no separate OCR).
- **`packages/embeddings`** — add a `package.json` and `src/index.ts`. `OpenAiEmbeddingProvider` (`text-embedding-3-small`, `dims = 1536`, batches, `toPgVector` on write).
- **`packages/clustering`** — replace the shell. Node client (`BertopicClusterer` implementing a refit/assign surface + `VpdqDedupeProvider` implementing `DedupeProvider`) that invokes a Python sidecar (see task 4).

Match the repo convention: `main`/`types` → `src/index.ts`, `"type": "module"`, run under `tsx`/`vitest` (`package.json` root scripts). Each package imports **only** `@goodfor/contracts` — no analysis package imports another (the contracts file header rule).

### 2. `apps/worker-analyse` — the orchestrator (NEW app)

Create `apps/worker-analyse/src/run.ts` — **the exact path the dashboard already references** (`formats/page.tsx` line 66). This is the read-plane analysis worker; it does not touch the write plane.

- `run.ts --enqueue` — the corpus feeder: enqueue analysed-worthy videos into `analysis_queue` with `reason='corpus'`, `priority=5`.
- `run.ts` (drain) — pull `analysis_queue` by `(priority, enqueued_at) WHERE completed_at IS NULL` (the partial index is already there), then per video:
  `MediaProvider.extract` → `AsrProvider.transcribe` → `VisionProvider.analyse` → `EmbeddingProvider.embed` → `DedupeProvider.fingerprint`/`findDuplicates` → write `video_analysis` (+ `cost_usd = Σ provider.costUsd`, `analysis_errors`, `duplicate_of_video_id`) → mark `analysis_queue.completed_at`, bump `attempts`/`last_error` on failure.
- **Two lanes, keyed on `analysis_queue.reason`:** `reason='alert'` → sync Gemini (`analyse`), cleared in minutes (~50–80/day). `reason='corpus'` → Gemini Batch (`submitBatch`, ~420–450/day, 50% off).
- `run.ts --refit` (weekly) and `run.ts --assign` (daily) — the clustering commands (task 4).
- `run.ts --poll-batch` — reconcile Gemini batch jobs and **re-submit expired ones** (48 h).

Model the drain like `apps/worker-read/tick.ts`: a `--once` mode plus a loop; `loadEnv()` first, `db()` service client, providers constructed once.

### 3. Wire `worker-read` → `analysis_queue` (this is how the read pipeline "invokes" analysis)

worker-read must **not** call the AI providers inline — that would stall the 60 s poll loop behind minutes of ffmpeg + LLM latency. Instead it **enqueues**, and `worker-analyse` drains asynchronously.

- In `apps/worker-read/src/pipeline.ts` `scoreAccount`, at the point where an alert is pushed (line ~222, `if (shouldAlert(...))`), also `INSERT INTO analysis_queue (video_id, priority, reason) VALUES ($1, 0, 'alert') ON CONFLICT (video_id) DO NOTHING`. Priority 0 = highest, so alert videos jump the corpus.
- Keep the corpus feeder (`--enqueue`) in `worker-analyse`, not `worker-read`, so the polling app stays single-purpose.

This keeps the read plane's collection loop fast and makes the alert→analysis handoff a durable row, not an in-memory call.

### 4. Python clustering + vPDQ sidecar

- `scripts/analysis/cluster.py` — BERTopic over the fixed embeddings pulled from `video_analysis.embedding`. `--refit` fits UMAP+HDBSCAN with the exact params above and writes `format_cluster` rows (label via Gemini from the 15–20 highest-probability members; `-1` written as the outlier bucket). `--assign` runs `approximate_predict()` and updates `video_analysis.format_cluster_id`.
- `scripts/analysis/vpdq.py` — PDQ-hash 1 frame/sec (≈30 × 256-bit hashes/video), serialise to `phash_frames bytea`, and expose a FAISS **binary** index for corpus matching. TS `DedupeProvider.findDuplicates` does the Hamming compare at `maxDistance = DEFAULT_HAMMING_DISTANCE (20)`, `minMatchFraction = DEFAULT_MIN_MATCH_FRACTION (0.8)`.
- Node ↔ Python boundary: child-process invocation with JSON on stdio (embeddings and hashes are small). Pin `random_state=42` so UMAP is reproducible across refits.

### 5. Migration + contract reconciliation (task 6 / Data model below)

Add `vision_batch_job` (batch re-submit path) and fix the `FrameHash` bit-width in contracts before locking dedupe.

---

## Data model changes

The Phase-2 schema is **already almost entirely present** (init + analysis migrations). Two genuine additions/fixes:

### New: `vision_batch_job` — the Batch re-submit path

Gemini Batch jobs *"expire after 48 hours and results are unrecoverable — build a re-submit path, not just a poll"* (§6.3). Nothing tracks that today. New migration `supabase/migrations/20260815000005_vision_batch.sql`:

```sql
create table if not exists vision_batch_job (
  id            text primary key,           -- Gemini batch job id
  video_ids     bigint[]    not null,        -- videos in this batch
  submitted_at  timestamptz not null default now(),
  expires_at    timestamptz not null,        -- submitted_at + 48h
  status        text        not null default 'pending'
                  check (status in ('pending','succeeded','expired','failed','resubmitted')),
  resubmit_of   text references vision_batch_job(id),
  cost_usd      numeric(10,6)
);
create index if not exists vision_batch_pending_idx
  on vision_batch_job (expires_at) where status = 'pending';
alter table vision_batch_job enable row level security;
```

`run.ts --poll-batch` scans `WHERE status='pending' AND expires_at < now()`, marks them `expired`, and re-submits the still-unanalysed `video_ids` as a fresh job with `resubmit_of` set.

### Fix: `FrameHash` bit-width (code, not migration)

`packages/contracts/src/index.ts` documents `FrameHash.hash` as *"64-bit perceptual hash as a hex string"* — correct for **pHash hook-frame dedupe** but **wrong for vPDQ near-duplicate detection**, which uses **256-bit PDQ** hashes. Reconcile before locking dedupe: either widen `FrameHash` to 256-bit for the `DedupeProvider` path (keeping 64-bit pHash internal to `MediaProvider.extract` hook-frame dedup), or split into two types. `phash_frames bytea` is an opaque blob and needs no schema change either way.

### Already present (do not re-create)

- `video_analysis`: all hook columns, `embedding halfvec(1536)` + HNSW `m=16 ef_construction=64`, `phash_frames bytea`, `format_cluster_id` FK, plus `format_summary` / `spoken_hook_words` / `cost_usd` / `duplicate_of_video_id` / `analysis_errors` (analysis migration).
- `format_cluster` with `id = -1` outlier bucket, `member_count`, `median_views`, `median_z`.
- `analysis_queue` with `priority`, `reason ∈ alert|corpus|manual`, `attempts`, partial pending index.

---

## Key algorithms & decisions (with the spec's exact thresholds/costs)

**The pipeline (§6.1):**
`video → ffmpeg (audio + keyframes) → { Groq Whisper → transcript+word ts ; Gemini native video → structured analysis }; transcript → embedding → pgvector → UMAP → HDBSCAN → LLM labels → format taxonomy + hook classification.`

**ASR — Groq, decisively (§6.2).** `whisper-large-v3-turbo` at **$0.04/audio-hour** (the non-turbo `whisper-large-v3` is $0.111; OpenAI Whisper is $0.36 — turbo is exactly **9.0× cheaper**). At **500 videos/day × 30 s = 4.17 audio-hours/day → $5.00/month**. Rate headroom is 3 orders of magnitude, so no rate-limit engineering. Constraints: **min billed length 10 s** (batch the hook audio into the full-clip call — a 3 s hook pays a 3.3× markup otherwise), free tier caps at **25 MB** / Dev at 100 MB. `response_format=verbose_json` for the word timestamps that split t<3.0 s. **Don't self-host** — one RTX 4090 GPU-hour beats two days of Groq by 2%; keep `faster-whisper` only as a 429 breaker.

**Vision — Gemini only (§6.3).** Only Google (of OpenAI/Anthropic/Google) accepts native video; Claude is JPEG/PNG/GIF/WebP, first frame only for animations. Mechanics: 1 FPS, **258 tok/frame** (2.5 default) / 66 (low), **32 tok/audio-second**. A 30 s clip on 2.5 default = 7,740 video + 960 audio = **8,700 tokens**. **Bill audio on the audio line** ($1.00/M vs $0.30/M) — conflating understates cost 22–26%.

| Config | /video | /month @ 500/day |
|---|---|---|
| Gemini 2.5 Flash, default | $0.00453 | **$68** |
| Gemini 2.5 Flash-Lite, default | $0.00126 | **$19** |
| Gemini 3.1 Flash-Lite, default | $0.00176 | $26 |
| Claude Opus 5, 8 frames | $0.1076 | **~$1,615** |

Corrections that flip intuitions: **Gemini 3 already defaults to 70 tok/frame** (the low-equivalent) — `media_resolution_low` saves **nothing** there, and the "12 hook frames at high" hybrid is a **2.1× cost increase** to book as deliberate spend, not an optimisation; **never pick `medium` for video** (identical to low, 70 each). On 2.5 the 258→66 lever is a real 3.9× cut. **Don't buy separate OCR** — Cloud Vision at $270/month is 17× Flash-Lite for narrower output; read on-screen text inside the Gemini call. **Two lanes:** sync for alert-clearers (~50–80/day), Batch API at **50% off** for the corpus (~420–450/day). Reach Gemini **Tier 2** ($100 paid + 3 days) before any backfill or the $10/10-min Tier 1 cap throttles it.

**Clustering & dedupe (§6.4).** Embeddings are a **rounding error** ($1.20/year) — choose on dimension, not price; the clustering input is the **transcript + `format_summary` text embedding**, which sidesteps the frame-averaged-vs-video-embedder question entirely (that only matters if/when you add "find similar videos" retrieval, and that benchmark is `[UNVERIFIED]` on Pexels stock — re-run on Goodfor-labelled video first). BERTopic with the exact UMAP→HDBSCAN params above. There is **no `n_topics` knob**; `min_cluster_size` is **0.5–1% of corpus (25–75 at 5k–15k videos)** — the default **150** would collapse a 15k corpus into 5–8 mega-clusters. `prediction_data=True` → **re-fit weekly, assign daily in ms**. Label ~50 clusters weekly on 2.5 Flash ≈ **$0.05/week**. **HDBSCAN's `-1` outliers are the "novel format" alert queue — the outliers are the product** (already stored as `format_cluster.id = -1` and rendered as the "novel / unclustered" pill on the dashboard).

Near-dup: **vPDQ, not TMK** — variable-length hash matches trimmed/cropped/re-captioned reposts; ~30 hashes/video as `bytea`, FAISS binary index (0.25 ms/query vs 684 ms brute force at 2,000×500 frames). **Tighten D to ~20** (reference default 31 can't separate "same creator reposting" — dedupe it — from "different creator recreating the format" — *that is the signal*). `DEFAULT_HAMMING_DISTANCE = 20` is already the contract default.

**Hook analysis (§6.5).** The only grounded constant is TikTok's **5-second** boundary (Creator Rewards). Every 3-second retention benchmark is `[REFUTED]` as unshippable; so are "optimal 21–34 s" and "best time to post". **Instrument at 5 s, derive the rest in-house.** Extract 12 frames from the first 3 s (`ffmpeg -ss 0 -t 3 -vf fps=4`), pHash-dedupe, pass to Gemini with ASR filtered to t<3.0 s, emit the constrained `hook_type` enum plus `hook_text_sequence[]`, `spoken_hook`, `face_present`, `face_screen_fraction`, `cut_count_first_3s`, `caption_style`, `audio_type`. **Dense-sample the hook regardless of scene scores** — scene detection is a pixel-difference metric and a text-swapping talking head yields one keyframe (the contract's `MediaBundle.hookFrames` already encodes this). The ffmpeg scene thresholds in tutorials (0.1–0.7) appear in no ffmpeg docs — `[REFUTED]` folklore. Then regress Goodfor's own retention curves against `hook_type` and `cut_count_first_3s` for an internal benchmark grounded in your own audience.

**All-in analysis cost (§6.6):** Quality (2.5 Flash, sync) **~$120/mo**; Optimised (3.1 Flash-Lite, 85% batched) **~$56/mo**; Naive (Opus 5 on frames) **~$1,615**. The **~30× spread is entirely model + batching choices** — a day's work to get right. Target the optimised lane; keep 2.5 Flash sync for the alert lane where latency matters.

---

## External dependencies & monthly cost

| Dependency | Plane | Monthly cost | Notes |
|---|---|---|---|
| Groq ASR (`whisper-large-v3-turbo`) | READ | **$5** | 4.17 audio-hr/day; Dev tier for 100 MB cap |
| Gemini vision (2.5 Flash sync + 3.1 Flash-Lite batch) | READ | **~$56 (optimised) – $120 (quality)** | Batch 50% off; reach Tier 2 before backfill |
| OpenAI `text-embedding-3-small` | READ | **~$0.10** | $1.20/year — a rounding error |
| Gemini cluster labelling (2.5 Flash, weekly) | READ | **~$0.20** | ~$0.05/week for ~50 clusters |
| Compute: ffmpeg + Python (BERTopic/UMAP/HDBSCAN/FAISS) sidecar | READ | within existing Fly/Railway worker | no new host if it shares the read-plane worker box |

Phase-2 **AI line ≈ $61–$125/mo**. The §15 phase budget of **~$500/mo** is dominated, as in every phase, by **data acquisition** (EnsembleData Bronze $200) carried over from Phase 1 — analysis compute is the small part. Never let it become the naive $1,615 lane.

---

## Risks & guardrails

- **Cost blowup (the headline risk).** ~30× spread between sensible and naive. Guardrails: never Opus 5 on frames; never `medium`/`high` resolution for video by default (book the 12-frames-at-high hook pass as *deliberate* 2.1× spend if you want it); **always bill audio on the audio line**; assert per-video `cost_usd` and alarm if it drifts toward the quality lane on the corpus feed.
- **Gemini Batch 48 h expiry** → `vision_batch_job` + `--poll-batch` re-submit path (not just a poll). Reach **Tier 2** ($100 paid + 3 days) before backfill or Tier 1's $10/10-min cap throttles it.
- **Groq 25 MB free-tier cap** → Dev tier (100 MB) or downsample audio; **10 s min billing** → batch hook audio into the full call.
- **`min_cluster_size` default 150 collapses the corpus** → use 0.5–1% (25–75). **UMAP is stochastic** → `random_state=42`, compute embeddings once, re-run BERTopic over them.
- **vPDQ D=31 destroys the product** → D≈20, so recreations survive as distinct rows. Seed-test both directions (below).
- **Scene detection loses text-swap hooks** → dense-sample the hook regardless of scene scores (contract already mandates it).
- **`FrameHash` bit-width mismatch** (64-bit documented vs 256-bit PDQ needed) → reconcile before locking dedupe.
- **Plane bleed** → the AI vendors see competitor media; that is fine *in the read plane*. Guardrail: only structured findings (hook_type, cluster labels, format stats) may cross into brief generation — never a competitor video, audio, or verbatim transcript/on-screen text (which is also the [Phase 3](./PHASE-3-act-publishing.md) §7 replication rule).
- **Don't self-host Whisper / don't buy separate OCR** — both are net-negative; `faster-whisper` stays a 429 breaker only.

---

## Acceptance criteria / test plan

1. **End-to-end sync lane:** enqueue 50 alert videos (`reason='alert'`), run `worker-analyse` once; every `video_analysis` row has a `hook_type` in the enum, non-null `format_summary`, an `embedding`, and a logged `cost_usd`; total spend ≤ sync-lane budget.
2. **Batch lane + expiry:** submit ~400 corpus videos to Gemini Batch; results land within 48 h; **simulate an expired job** and confirm `--poll-batch` re-submits it with `resubmit_of` set and no double-charge on already-analysed videos.
3. **Clustering:** on ≥5k analysed videos, `--refit` produces ~30–75 clusters at `min_cluster_size` = 0.5–1% of corpus (not 5–8 mega-clusters), each with an LLM label; the `-1` bucket is populated; `--assign` labels new videos in ms via `approximate_predict`.
4. **Dedupe both directions:** a seeded trimmed/cropped repost of a known video matches at D≈20 (`matchFraction ≥ 0.8`) and gets `duplicate_of_video_id` set; a seeded *different-creator recreation* of the same format does **not** match and stays a distinct row.
5. **Hook regression seed:** `getHookPerformance()` returns a non-empty distribution with median-z per `hook_type`; the *Formats & hooks* page renders it (the dangling `apps/worker-analyse/src/run.ts` reference now resolves).
6. **Cost logged:** `getAnalysisProgress().totalCost` reflects summed `cost_usd`; the monthly projection sits in the optimised (~$56) to quality (~$120) band.

**Exit (§15):** a format taxonomy + hook-type distribution with measured per-type performance, live on the dashboard.

---

## Done checklist

Legend: `[x]` built + unit-tested · `[~]` code-complete, needs live keys/DB/corpus to exercise · `[ ]` operational, not yet done.

- [x] `packages/media` created — `FfmpegMediaProvider` (16 kHz WAV, sparse keyframes, dense `fps=4` hook frames, internal 64-bit pHash-dedupe) — 26 tests
- [x] `packages/asr` real — `GroqAsrProvider` (turbo, `verbose_json`, t<3.0 s hook split, 10 s billing floor) + `FasterWhisperAsrProvider` (429 breaker) — 11 tests
- [x] `packages/vision` given a `package.json` + real `src/index.ts` — `GeminiVisionProvider` sync + Batch, on-screen text in-call, audio billed on the audio line — 13 tests
- [x] `packages/embeddings` given a `package.json` + `OpenAiEmbeddingProvider` (`text-embedding-3-small`, 1536, proportional cost split) — 15 tests
- [x] `packages/clustering` real — `BertopicClusterer` + `VpdqDedupeProvider` (D≈20) over the Python sidecar — 21 tests
- [x] `scripts/analysis/cluster.py` (BERTopic refit/assign, `random_state=42`, model persisted to `--model-path`) + `scripts/analysis/vpdq.py` (PDQ, numpy-DCT fallback when `pdqhash` absent) — both byte-compile; error paths return structured JSON
- [x] `apps/worker-analyse/src/run.ts` created — drain / `--enqueue` / `--refit` / `--assign` / `--poll-batch`; two lanes keyed on `analysis_queue.reason` — 10 tests
- [x] `worker-read` `scoreAccount` enqueues alert videos into `analysis_queue` (`reason='alert'`, priority 0, upsert `ignoreDuplicates`, de-duped per tick)
- [~] Migration `20260815000005_vision_batch.sql` — **file written; NOT applied** (production DB write was blocked in-session). Type added to `database.types.ts` locally so code compiles; apply with `supabase db push --linked`.
- [x] `FrameHash` reconciled to 256-bit PDQ for the `DedupeProvider` path (64-bit pHash kept internal to `media`)
- [~] Cost guardrail: per-video `cost_usd` computed + asserted in unit tests (10 s ASR floor, 50 % batch discount, audio-line split); the runtime drift **alarm** still needs a live run to wire
- [ ] Gemini account at Tier 2 before any historical backfill (operational)
- [~] Dashboard *Formats & hooks* — the dangling `run.ts` reference now resolves and `getFormats`/`getHookPerformance`/`getAnalysisProgress` typecheck against the schema; a **non-empty** render needs a populated `video_analysis` DB + running app
- [~] Dedupe seed-test passes **both directions** (test-verified: trimmed/cropped repost matches at D≈20 ≥0.8; different-creator recreation stays distinct); clustering cluster-count + full exit criterion need the Python env + a ≥5k-vector corpus
