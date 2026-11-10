# Phase 1 — See (weeks 3–6)

> Cross-links: [System architecture](../00-ARCHITECTURE.md) · [Dashboard UX](../UI-UX-DASHBOARD.md) · prev: [Phase 0 — Foundations](./PHASE-0-foundations.md) · next: [Phase 2 — Understand](./PHASE-2-understand.md)

**Status: mostly done — the read-plane spine is built, demo-proven, and running on `FixtureSource`.** Ingestion, age-adaptive polling, the age-matched robust z-score, the `z≥2.5 / age≤12h / views≥10k / α>0` alert rule, and the Next.js dashboard all exist and pass an end-to-end demo. What remains is **hardening and trust**: flip the source from fixture to the live vendor chosen in Phase 0, add the centralised Redis token bucket (currently absent), make alerts durable (currently `console.log`), wire the dead velocity-override code into the poll loop, close a dashboard filter gap, and — the empirical exit gate — **instrument the real poll count in week 1** and **measure the false-positive rate**. This document is the punch-list, not a from-scratch build.

---

## Goal & definition of done

Turn the demo-proven read plane into a **trustworthy** competitor-outperformance detector running on real vendor data, with durable alerts and a global egress control plane.

**Definition of done (spec §15 exit criteria):**
- Competitor outperformance **alerts fire within 15 minutes of detection** (15-min hot-tier cadence + queue lag), delivered through a durable sink — not a console line.
- A **measured false-positive rate** exists (you cannot tune thresholds you have not measured).
- The **real poll count is instrumented in week 1** and the data budget is re-derived from it, not from §4.3's unreconciled arithmetic.

---

## Current state (what already exists in the codebase for this phase)

The scoring math is the strongest module in the repo and needs **no** new work; the ingestion worker needs targeted hardening.

| Phase-1 capability | State | Where |
|---|---|---|
| Robust outperformance math | **Built + unit-tested** | `packages/scoring` (390 src + 213 test). `median`, `mad`, `stddev`, `modifiedZ` (Iglewicz–Hoaglin, **0.6745** constant — test at line 36 explicitly guards the 1.4826 inversion), `OUTLIER_THRESHOLD = 3.5` |
| Age-grid interpolation, velocity, acceleration | **Built** | `AGE_GRID = [1,2,3,6,12,24,48,72,168]`, `viewsAtAge` (no extrapolation), `velocity`, `acceleration`, `localWindow` (strictly causal — the load-bearing §5 choice) |
| Scoring + alert rule | **Built** | `scoreVideo` (log-space z, returns `null` under `MIN_BASELINE_N = 8`), `DEFAULT_ALERT = { minZ: 2.5, maxAgeHours: 12, minViews: 10_000, requireAccelerating: true }`, `shouldAlert` |
| Poll tiers | **Built** | `POLL_TIERS` (7 tiers, 5min→weekly), `tierForAge`, `adjustTier` (velocity promotion), `nextDueAt` |
| Trend classification | **Built** | `classifyTrend` (velocity/accel sign-pair → rising/peaked/decaying/bottoming), `BREAKOUT_GROWTH_RATIO = 50`, `MIN_TREND_VOLUME = 500`, `isActionableTrend` |
| Ingestion pipeline | **Built** | `apps/worker-read/pipeline.ts` (237): `slotFloor` (5-min idempotency), `accountsDue`, `persistListing` (upsert videos → snapshot → per-video tier/`due_at` → `vendor_last_synced_at`), `loadSnapshots` (chunked `.in()` by 40), `scoreAccount` (age-matched cross-video baselines → `video_score`, emits alert strings) |
| 60s tick loop | **Built** | `apps/worker-read/tick.ts` (58): `setInterval`, `--once` |
| Keyword/hashtag trend series | **Built** | `apps/worker-read/trends.ts` (173): term registry + `keyword_trend` series + classification |
| End-to-end proof | **Built** | `apps/worker-read/demo.ts` (167): logistic breakout backfill — the pipeline's only end-to-end proof today |
| Dashboard | **Built (4 pages)** | `apps/dashboard`: `page.tsx` (alerts), `trends`, `accounts`, `formats`, `lib/queries.ts` (271, all server components, `force-dynamic`, service-role) |
| Read-plane schema | **Built (migrated)** | `competitor_account`, `tracked_video` (`due_at WHERE tracking_active`), `video_metric_snapshot` (monthly range partitions, `pg_cron` keeps 3 months ahead), `video_score`, `keyword_trend` |

**Load-bearing caveat: it all runs on `FixtureSource`.** Until Phase 0's `mapEnsembleVideo()` verification lands and `createSource()` is flipped to the live vendor, every score is synthetic.

### Known gaps confirmed by the code audit (this phase closes them)
1. **No centralised Redis token bucket.** grep finds no redis/rate-limit anywhere; polling is a bare `setInterval` with no global egress throttle (§3/§4.4 requires it).
2. **Alerts are ephemeral `console.log`.** No alert-queue table, no notification sink — so "alerts within 15 min" has no delivery mechanism beyond a derived dashboard query.
3. **`adjustTier` velocity-override is dead code.** `persistListing` uses plain `tierForAge` only, so hot videos are never promoted to a tighter cadence — the exact behavior "replicate within hours" depends on.
4. **Dashboard `minViews` filter gap.** `getAlerts` filters `z≥2.5`, `age≤12`, `acceleration>0` but **omits the `minViews ≥ 10,000` floor** that `shouldAlert` enforces — the dashboard "live alerts" set is looser than what the worker would actually alert on.

---

## Prerequisites (which prior-phase outputs are required)

From [Phase 0](./PHASE-0-foundations.md):
- **A chosen primary vendor with measured accuracy** and a nominated failover (drives the circuit-breaker target).
- **`mapEnsembleVideo()` verified against a live response** — the gate that lets `createSource()` be flipped off `FixtureSource`.
- **EnsembleData Bronze active** ($200/mo) and a live `ENSEMBLEDATA_TOKEN`; ScrapeCreators credits provisioned as failover.
- Confirmation (or not) of **unit rollover**, which decides whether polling may be burst-shaped or must be smoothed across the day.

---

## Tech & tools introduced in this phase (exact technologies/versions)

| Tool | Role | Cost/mo |
|---|---|---|
| **EnsembleData Bronze** (from Phase 0) | Live source: 5,000 units/day @ $200; the workload targets ~1,400 units/day via listing-derived metrics | $200 |
| **ScrapeCreators** (from Phase 0) | Circuit-breaker failover after 5 consecutive 429/5xx | ~$0 carrying |
| **Redis** (Cloudflare / Upstash / local) | Atomic **Lua token bucket** across workers (§4.4); also the natural home for the alert notification fan-out | ~$7–20 |
| **Node/TypeScript worker** on Fly or Railway | Host `apps/worker-read` with the 60s tick + control plane | ~$80 |
| **Next.js + Recharts dashboard** | Already built; add the alert-queue view + close the filter gap | $0–80 |

Queue choice stays **Cloudflare Queues or BullMQ+Redis** ($7 vs $531 for durable-execution platforms). **No Temporal/Inngest for polling** — at 2.07M polls/mo Temporal ≈ $531 and Inngest blows its Pro tier 8–12×; durable execution is right for *publishing* (Phase 3), wrong for high-volume low-value polling.

---

## Work breakdown — ordered, concrete tasks

Ordered so measurement (poll count, false-positive rate) starts the moment real data flows.

1. **(Week 3) Flip `createSource()` to the live vendor.** With Phase 0's verification done, set `ENSEMBLEDATA_TOKEN` (or `VENDOR=…`) so the factory stops falling back to `FixtureSource`. Seed a real competitor set via `apps/worker-read/seed.ts` and cache each account's `secUid` at onboarding (so `getUserPosts` uses the `depth`-cost secUid path, saving 300 units/day). *Files: `packages/tiktok-source/src/*`, `apps/worker-read/seed.ts`.*

2. **(Week 3, day 1 of live data) Instrument the real poll count.** Add a counter/log around the tick's due-row selection and the vendor call in `persistListing`, and emit per-tier poll counts + units consumed per day. **Re-derive the data budget from measured polls**, not from §4.3's ~69,000/day figure (which "does not reconcile with its own tier table"). This is an explicit spec §15 mandate for week 1 of this phase. *Files: `apps/worker-read/tick.ts`, `pipeline.ts`; a lightweight metrics sink.*

3. **(Week 3–4) Add the centralised Redis Lua token bucket (§4.4).** Atomic across workers. **Rate 10/sec** (from the verified 600/min), **capacity 300 not 600** so a cold-start burst cannot consume the whole window and starve the publishing path later. **One bucket per `client_key`, a second per data vendor.** Every vendor call in `persistListing` (and `trends.ts`) acquires a token first. *New: `apps/worker-read/rate-limit.ts` (Redis Lua) + a `client_key`/vendor bucket config.*

4. **(Week 4) Add the retry + failover + backpressure control plane (§4.4).**
   - **Retry with AWS full jitter:** `sleep = uniform(0, min(300s, 1s × 2^attempt))`, **max 6 attempts**, honour `Retry-After` as a floor. Size it against Apify's measured 6.68% failure (≈1 in 15).
   - **Circuit breaker** after **5 consecutive 429/5xx** from the primary vendor → fail over to ScrapeCreators (dedupe on video ID; TikTok can return duplicates).
   - **Backpressure:** bound the ready queue; when overdue polls back up, **drop from the *cool* tier, never the hot tier** (a 3-day-old video missing a daily snapshot costs nothing; a viral video missing its 15-min snapshot costs the product).
   *Files: `apps/worker-read/rate-limit.ts`, `pipeline.ts`.*

5. **(Week 4) Wire the velocity override into the poll loop.** `persistListing` currently calls `tierForAge` only; call **`adjustTier`** so a video is **promoted one tier when Δviews in the last window > 3× Δviews in the prior window** and **demoted after two consecutive polls with Δviews/views < 0.005**, capped at the 5-min floor. This makes the age-adaptive promotion of hot videos live instead of dead code. *File: `apps/worker-read/pipeline.ts`.*

6. **(Week 4–5) Make alerts durable — add an alert queue + notification sink.** Replace the ephemeral `console.log` in `scoreAccount` with a persisted `alert` row and a fan-out (Redis pub/sub → Slack/webhook, or a durable queue). The dashboard reads this table instead of deriving alerts on the fly. *New migration + a `notify` step in `pipeline.ts`.*

7. **(Week 5) Close the dashboard `minViews` filter gap.** In `apps/dashboard/lib/queries.ts`, add `view_count ≥ 10,000` to `getAlerts` so the dashboard's "live alerts" set matches `shouldAlert` exactly (`z≥2.5 AND age≤12h AND views≥10k AND α>0`). Point the alerts page at the new alert table (task 6). *File: `apps/dashboard/lib/queries.ts`.*

8. **(Week 5–6) Measure the false-positive rate.** With alerts durable, sample fired alerts and hand-label each as true outperformer vs noise. Report the FP rate and tune only the *config-exposed* knobs (never the core constants). This is the second exit gate. *Analysis + a labeling view in the dashboard.*

9. **(Week 6) Cold-start / confidence handling.** Confirm `scoreVideo` honours `MIN_BASELINE_N = 8` (refuse to score when `|B_c(a)| < 8`) and that no score is published before **3 same-age observations** — emit a confidence band instead. Wire empirical-Bayes shrink toward the tier prior (`w = n/(n+k)`, `k ≈ 5–10`) for thin cohorts. *File: `packages/scoring` (confirm/extend), `pipeline.ts`.*

---

## Data model changes (tables/columns/migrations, SQL sketch where useful)

Most of the read-plane schema is already migrated. Phase 1 adds **one** durable-alert table (closing audit gap #2) and confirms the existing partition/index shape.

```sql
-- NEW: durable alert queue (replaces console.log fan-out)
alert (
  id             bigserial primary key,
  video_id       bigint not null,
  fired_at       timestamptz not null default now(),
  age_hours      numeric not null,          -- must satisfy age ≤ 12
  z_score        numeric not null,          -- must satisfy z ≥ 2.5
  multiplier_vs_median numeric not null,    -- human-facing × median
  view_count     bigint not null,           -- must satisfy ≥ 10,000 noise floor
  acceleration   numeric not null,          -- must satisfy α > 0
  baseline_n     integer not null,          -- for audit: was baseline ≥ 8?
  status         text not null default 'fired',  -- fired | acknowledged | dismissed | labeled_fp | labeled_tp
  notified_at    timestamptz
)  [ (fired_at desc) ] [ (video_id) ]
```

Already migrated — **confirm, do not recreate:**
- `video_metric_snapshot` — **WIDE not EAV**, PK `(video_id, ts)`, `PARTITION BY RANGE (ts)` monthly, `view_count BIGINT` / like·comment·share `INTEGER`, `ts` floored to the slot for free idempotency (`INSERT … ON CONFLICT (video_id, ts) DO NOTHING`). Never UPDATE metrics in place — every signal is a time derivative.
- `tracked_video (due_at, tracking_active)` with the partial index `[due_at WHERE tracking_active]` — the scheduler's whole shape (single `due_at` column + 60s tick with `LIMIT`, **never one cron per video**).
- `video_score (z_score, multiplier_vs_median, velocity_vph, acceleration, computed_at, baseline_n)`.
- `pg_cron` partition maintenance keeps 3 months ahead (`ensure_metric_partitions()`).

Provenance stamp: `competitor_account.vendor_last_synced_at` is written by `persistListing` — keep it, it is the freshness audit.

---

## Key algorithms & decisions (with the spec's exact thresholds/costs)

- **Age-matched robust z-score in log space** (already implemented in `packages/scoring`):
  ```
  z_i(a) = 0.6745 × ( log(V_i(a)+1) − median(B_c(a)) ) / MAD(B_c(a)),   MAD = median(|x − median(x)|)
  ```
  Baseline `B_c(a)` over trailing **N=30** videos (50 for high-volume), `j ≠ i`; **refuse to score when |B_c(a)| < 8**; fall back to classical z when MAD=0; flag at **|z| > 3.5** (Iglewicz–Hoaglin). **0.6745 = Φ⁻¹(0.75), NOT the 1.4826 consistency constant** — swapping them inverts the scale ~4.9× (the scoring test explicitly guards this). Log space because view distributions are heavy-tailed (fitted Pareto α ∈ [0.50, 4.36]; α<1 implies infinite mean, so any mean-based baseline misbehaves — this is why **median, not mean**: a mean baseline suffers *masking*, where an account's own virals inflate its mean until nothing registers).
- **Alert rule (already `DEFAULT_ALERT`):** `FIRE when z_i(a) ≥ 2.5 AND a ≤ 12h AND V_i(a) ≥ 10,000 AND α_i > 0`. Worst-case detection latency = 15 min (hot-tier cadence) + queue lag.
- **Velocity/acceleration (causal, two-window):** `v = (V(t₂)−V(t₁))/(t₂−t₁)` views/hr; `α = (v(t₂)−v(t₁))/(t₂−t₁)`.
- **Poll cadence (§4.3):** age tiers <1h→5min · 1–6h→15min · 6–24h→30min · 1–3d→2h · 3–7d→6h · 7–30d→24h · >30d→7d/evict, plus the velocity override (task 5). **Instrument the real poll count** rather than trusting the ~69,000/day derivation (which does not reconcile with the tier table).
- **Two numbers per video:** the human multiplier (× median) and the modified z. Threshold **Convention A: 2× noteworthy, 3× significant, 5× viral candidate, 10× exceptional** (expose the other convention as a config preset — never inherit both).
- **Cost dial:** the largest single dial is hot/warm-tier cadence × listing-derived metrics. Listing-derived snapshots keep the workload at ~1,400 units/day inside Bronze ($200) instead of the $800 Gold that per-video `Multiple Post Info` would force.

---

## External dependencies & monthly cost

| Item | Cost/mo |
|---|---|
| Data acquisition (EnsembleData Bronze, listing-derived) | **$200** |
| Compute + queue (worker on Fly/Railway + Redis) | ~$87–100 |
| Storage + DB (Supabase Postgres 16) | ~$25–70 |
| Dashboard (Next.js, self-hosted or Vercel hobby) | $0–80 |
| Observability | ~$18 |
| **Phase-1 run rate** | **~$400/mo** (matches spec §15) |

Data acquisition dominates every scenario and is controlled by the listing-derived-metrics choice + hot-tier cadence — the two levers already respected in `packages/tiktok-source` and (after task 5) the poll loop.

---

## Risks & guardrails

- **Scores run on `FixtureSource` (highest current risk):** no alert is trustworthy until `createSource()` is flipped to the Phase-0-verified live vendor. Task 1 is the unblock; treat any FixtureSource alert as demo-only.
- **Read/write plane separation (§14, high):** the worker, its egress IP, its Redis, and its Supabase project must stay isolated from anything that will publish in Phase 3. A scraping complaint must not be able to reach the authenticated API client. Do not co-locate.
- **Vendor view-count disagreement (§14, high):** already de-risked by the Phase-0 bake-off; keep the abstraction so a swap is a config change, not a rewrite.
- **Egress starvation:** the token bucket's **capacity 300 (not 600)** exists specifically so a cold-start read-plane burst cannot consume the whole 600/min window — do not raise it.
- **Backpressure direction:** drop **cool**-tier polls under load, never hot. Getting this backwards defeats the whole "detect within 15 min" premise.
- **Poll-count arithmetic caveat:** budget from **measured** polls (task 2), not §4.3's numbers.
- **Rollover `[UNVERIFIED]`:** if EnsembleData does not roll units over, smooth polling across the day rather than bursting near reset.
- **No controlled prior for TikTok view-velocity → virality:** time constants from Szabó–Huberman / Althoff do not transfer; calibrate thresholds on Goodfor's own data via the false-positive measurement (task 8).

---

## Acceptance criteria / test plan

- [ ] `createSource()` serves **live** vendor data; zero code paths silently fall back to `FixtureSource` in production.
- [ ] The **real poll count and daily units consumed are instrumented** and the data budget is re-derived from them (week 1 of the phase).
- [ ] The **Redis Lua token bucket** gates every vendor call, atomic across workers, rate 10/sec, capacity 300, per-`client_key` + per-vendor buckets.
- [ ] Retry (full jitter, ≤6 attempts, `Retry-After` floor), circuit-break → ScrapeCreators after 5 consecutive 429/5xx, and cool-tier backpressure all demonstrated under an induced-failure test.
- [ ] `adjustTier` is invoked in the poll loop; a synthetic fast-growing video is observably promoted toward the 5-min floor and demoted after two flat polls.
- [ ] Alerts are **persisted to the `alert` table and delivered to a sink**; an end-to-end run shows an alert row + notification within **15 minutes** of the crossing snapshot.
- [ ] Dashboard `getAlerts` includes the **`view_count ≥ 10,000`** floor and reads the `alert` table; its live-alert set equals `shouldAlert`.
- [ ] A **false-positive rate is measured** on hand-labeled fired alerts.
- [ ] Cold-start guard verified: no score below `MIN_BASELINE_N = 8` or fewer than 3 same-age observations; a confidence band is emitted instead.

---

## Done checklist

- [ ] `createSource()` flipped to live vendor; fixtures gone from the hot path
- [ ] Real poll count + daily units instrumented; budget re-derived from measurement
- [ ] Redis Lua token bucket added (10/sec, capacity 300, per-`client_key` + per-vendor)
- [ ] Full-jitter retry (≤6, `Retry-After` floor) implemented
- [ ] Circuit breaker → ScrapeCreators after 5 consecutive 429/5xx; ScrapeCreators dedupes on video ID
- [ ] Cool-tier backpressure implemented (never drop hot)
- [ ] `adjustTier` wired into `persistListing` (velocity promote 3×, demote <0.005 ×2, 5-min floor)
- [ ] `alert` table migrated; `scoreAccount` persists + notifies instead of `console.log`
- [ ] Dashboard `getAlerts` adds `view_count ≥ 10,000` and reads the `alert` table
- [ ] False-positive rate measured on labeled alerts
- [ ] Cold-start / confidence-band behavior confirmed (`MIN_BASELINE_N = 8`, ≥3 same-age obs, EB shrink `k≈5–10`)

**Exit gate:** alerts firing within 15 minutes of detection on live data, delivered durably, with a measured false-positive rate → proceed to [Phase 2 — Understand](./PHASE-2-understand.md).
