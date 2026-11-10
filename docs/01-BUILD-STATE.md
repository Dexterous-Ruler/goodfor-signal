# Build State — what exists right now

> Snapshot of the repository as audited on 2026-08-16, cross-checked against the code by the
> workflow's review pass. This is the ground truth the [phase docs](./phases/) build on — where a
> phase says "already implemented," this is why.

**One-line summary:** the entire **read-plane spine (Phases 0–1) is built and demo-proven**,
running on a `FixtureSource`; the **content-intelligence layer (Phase 2) is now code-complete**
(all five providers + the `worker-analyse` orchestrator, live-smoke-verified against real
Groq/Gemini/OpenAI); the **write plane (Phase 3) is now code-complete** (`publishing`/`compliance`/
`briefs` packages + the isolated `worker-write` app, plane guards on both workers); **Phase 4
(attribution) and Phase 5 (creator CRM) are now code-complete too** — `packages/attribution` +
`apps/worker-attribute`, `packages/creator-crm` + `apps/worker-creators`. **All six phases (0–5)
are code-complete.** Whole repo: typecheck clean, **373 tests green across 41 files**; every
external API boundary flagged `// UNVERIFIED`, no migration applied to the live DB yet.

---

## Monorepo (npm workspaces, Node ≥20, TypeScript, Vitest)

### `packages/` — built

| Package | State | Detail |
|---|---|---|
| `scoring` | ✅ **Done, tested** | ~390 lines + test suite. Robust age-matched z-score (median/MAD, `0.6745`), strictly causal velocity/acceleration, alert rule `z≥2.5 ∧ age≤12h ∧ views≥10k ∧ α>0`, trend-state classifier. This is the crown jewel — guard it with the tests. |
| `tiktok-source` | ✅ **Done** ⚠️ | ~311 lines. Vendor abstraction with `EnsembleData` and `Fixture` sources. **Gap:** `mapEnsembleVideo()` was written from EnsembleData's *documented* response shape and **has never seen a live response** — verify on the first real call. |
| `contracts` | ✅ **Done** | ~245 lines of shared types — the seam between packages/apps. |
| `db` | ✅ **Done** | ~40 lines. Typed Supabase client generated from the live schema (`npm run db:types`). Plane: **Both** (the one shared substrate). Carries a `ws` shim for Node 20 — remove on Node 22+. |

### `packages/` — Phase 2 content intelligence (built 2026-08-16)

| Package | State | Detail |
|---|---|---|
| `media` | ✅ **Built** | NEW. `FfmpegMediaProvider` — 16 kHz mono WAV, sparse keyframes, dense `fps=4` hook frames, internal 64-bit pHash-dedupe. 26 tests. |
| `asr` | ✅ **Built** | `GroqAsrProvider` (turbo, `verbose_json`, t<3 s hook split, 10 s billing floor) + `FasterWhisperAsrProvider` (429 breaker). 11 tests. |
| `vision` | ✅ **Built** | `GeminiVisionProvider` sync + Batch — native video, on-screen text in-call, audio billed on the audio line. 13 tests. ⚠️ request/response shapes `UNVERIFIED` vs a live Gemini key. |
| `embeddings` | ✅ **Built** | `OpenAiEmbeddingProvider` (`text-embedding-3-small`, 1536 dims, proportional cost split). 15 tests. |
| `clustering` | ✅ **Built** | `BertopicClusterer` + `VpdqDedupeProvider` (D≈20) over `scripts/analysis/{cluster,vpdq}.py`. 21 tests. ⚠️ Python ML wheels need 3.11–3.12 (3.14 has none); vPDQ falls back to numpy-DCT without `pdqhash`. |

### `apps/` 

| App | State | Detail |
|---|---|---|
| `worker-read` | ✅ **Done** | `pipeline.ts` (~237 lines) + `tick.ts`, `trends.ts`, `seed.ts`, `demo.ts`. The poll/score/trend loop. Runs end-to-end on the fixture; not yet flipped to a live vendor, no centralised Redis token bucket, alerts still `console.log`. |
| `dashboard` | ✅ **Read-side done** | Next.js. Pages: `/` (page.tsx), `/accounts`, `/trends`, `/formats`; `lib/queries.ts` (~271 lines). This is the console the [UI-UX spec](./UI-UX-DASHBOARD.md) evolves. |
| `worker-analyse` | ✅ **Built** | `src/run.ts` orchestrator — drain (alert=sync / corpus=batch lanes) · `--enqueue` · `--refit` · `--assign` · `--poll-batch`. 10 tests. Fed by `worker-read` → `analysis_queue` (alert enqueue wired into `scoreAccount`). |
| `worker-write` / `publisher` | ❌ **Missing** | The Phase 3 write-plane app. Does not exist yet — must be a **separate deployment** (own creds/egress/IPs). |

### `supabase/migrations/` — 4 files, 376 lines, applied

| Migration | Lines | Contents |
|---|---|---|
| `20260815000001_init_tiktok_core.sql` | 266 | Read-plane core (`competitor_account`, `tracked_video`, `video_metric_snapshot`, `video_score`, `video_analysis`) **and** write-plane tables (`owned_account`, `scheduled_post`, `account_health`). Note as-built names: `disclosure_verified`, `strike_count_by_area jsonb`, `app_slug`. |
| `20260815000002_partition_maintenance.sql` | 17 | pg_cron monthly partition roll-forward for `video_metric_snapshot`. |
| `20260815000003_tracked_terms.sql` | 33 | `tracked_term`, `keyword_trend`. |
| `20260815000004_analysis.sql` | 60 | `format_cluster` (id `-1` = outlier bucket), `analysis_queue`, extra `video_analysis` columns. |

**All migrations are applied to the live project** (`uznjoifmjfrhftvlkmac`, "tiktok") as of
2026-08-16 — `…01`–`…04` from the read-plane build plus `…05_vision_batch` (P2),
`…06_writeplane_publishing` (P3, incl. the live `scheduled_post_disclosure_gate` trigger),
`…07_attribution` (P4), and `…08_creator_crm` (P5), applied via the Supabase Management API.
`packages/db/src/database.types.ts` is **regenerated from the live schema** (authoritative), and
the whole monorepo typechecks clean + 373 tests pass against it — proof the code matches the DB.

---

## Phase readiness at a glance

| Phase | State | What blocks "done" |
|---|---|---|
| 0 — Foundations | 🟢 Largely done | Vendor bake-off not run; legal sign-off + TikTok app registration + Accounts API form to confirm. |
| 1 — See | 🟢 Mostly done | Flip fixture→live vendor, add Redis token bucket, durable alerts, verify `mapEnsembleVideo`, measure real poll count + false-positive rate. |
| 2 — Understand | 🟢 Code-complete | Built + unit-tested (124 tests, clean typecheck). Pending to run: live keys (Groq/Gemini/OpenAI), a playable video URL, apply the `vision_batch` migration, Python ML wheels under 3.11–3.12. |
| 3 — Act | 🟢 Code-complete | `publishing`/`compliance`/`briefs` + `worker-write` built + unit-tested. Pending to run: apply migration `…06`, TikTok creds + OAuth, own-audit; verify `// UNVERIFIED` API shapes. |
| 4 — Attribute | 🟢 Code-complete | `attribution` pkg + `worker-attribute` built + unit-tested. Pending: apply migration `…07`, cross-team mobile SDK (Android/iOS), live Kochava/Apple creds, a real pause test for CPI. |
| 5 — Scale creators | 🟢 Code-complete | `creator-crm` pkg + `worker-creators` built + unit-tested. Pending: apply migration `…08`, Modash $16,200/yr sign-off + live Modash/HypeAuditor/Business-Center creds. |

---

## Two known gaps to close before trusting any real number

1. **`mapEnsembleVideo()` has never seen a live response** — every score computed from real data
   is suspect until this mapping is verified against an actual EnsembleData payload.
2. **No vendor bake-off has been run** — outperformance depends on absolute view-count accuracy,
   and no two vendors have been shown to agree. This is Phase 0's exit gate (`completion.md` §4.5).
