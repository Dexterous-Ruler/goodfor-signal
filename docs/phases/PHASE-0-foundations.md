# Phase 0 — Foundations (weeks 1–2)

> Cross-links: [System architecture](../00-ARCHITECTURE.md) · [Dashboard UX](../UI-UX-DASHBOARD.md) · next: [Phase 1 — See](./PHASE-1-see.md)

**Status: partially done — the code scaffolding exists, the exit criteria do not.** The vendor-abstraction layer that Phase 0 is supposed to produce (`packages/tiktok-source`) is already built as the ToS-risk mitigation, and the read-plane schema is already migrated. But every actual Phase 0 exit criterion is a **non-code, process-or-measurement gate** and none of them are met: no vendor bake-off has run, there is no named legal sign-off on §11, no TikTok developer app is registered, and the **Accounts API Access Application Form is not submitted** (blocking since 20 March 2026). This document is the checklist to close those gates, plus the one live-data hardening task (verify `mapEnsembleVideo()` against a real EnsembleData response) that every downstream z-score depends on.

---

## Goal & definition of done

Establish the legal, contractual and vendor-trust foundation so that Phase 1 can ingest **real** competitor data on a **chosen, measured** vendor without re-litigating the schema. Nothing in Phase 0 ships user-visible product; it de-risks everything after it.

**Definition of done (spec §15 exit criteria, verbatim intent):**
1. A **signed risk acceptance** on §11 with a named human owner.
2. A **chosen primary vendor** with *measured* view/like/comment/share accuracy from a head-to-head bake-off — not a docs-page assertion.
3. The **Accounts API Access Application Form submitted** (sequential to TikTok app submission; start week 1 because it blocks the entire write plane later).

Two engineering sub-goals fold in because they cannot wait for Phase 1 without invalidating it:
- `mapEnsembleVideo()` in `packages/tiktok-source` **verified against a live EnsembleData response** (README gap #1). Until this is done, every score in the system derives from `FixtureSource`.
- The bake-off must run **before the ingestion schema is treated as frozen** (§4.5): if two vendors disagree on view counts by ~10%, "every z-score is wrong" and the wide-snapshot field widths / vendor choice must be revisited first.

---

## Current state (what already exists in the codebase for this phase)

| Phase-0 concern | State | Evidence |
|---|---|---|
| Monorepo + workspaces | **Done** | npm workspaces; `packages/*`, `apps/*` all resolve except the empty Phase-2 shells |
| Vendor abstraction (the switchability mitigation for risk §14.1) | **Done** | `packages/tiktok-source` (311 lines): `TikTokSource` interface, `TikTokSourceError`, `EnsembleDataSource`, `FixtureSource`, `createSource()` factory that falls back to fixture when `ENSEMBLEDATA_TOKEN` is unset |
| Cost-discipline choices from §4.2 baked into the adapter | **Done** | `getUserPosts` returns videos-with-counts (no per-video metric method); secUid path (`/tt/user/posts`) preferred over username; 495/429/5xx handled |
| Read-plane + write-plane schema | **Done (migrated)** | `supabase/migrations/…_init_tiktok_core` (266 lines) already defines `competitor_account`, `tracked_video`, `video_metric_snapshot` (range-partitioned), `video_score`, `video_analysis`, `keyword_trend`, plus the write-plane `owned_account`/`scheduled_post`/`account_health` |
| `EnsembleData` field mapping | **Written but UNVERIFIED** | `mapEnsembleVideo()` (line ~198) written from documented shape, **never validated against a live response** — README gap #1 |
| ScrapeCreators / Apify adapters | **Absent** | only `EnsembleDataSource` + `FixtureSource` exist; the two named bake-off / failover targets have no adapter |
| Vendor bake-off (§4.5) | **Not started** | README gap #2, confirmed by audit |
| Legal §11 sign-off | **Not started** | non-code |
| TikTok app registration + Accounts API form | **Not started** | non-code, and the form has been blocking since 20 Mar 2026 |

**Bottom line:** the read-plane spine is real (~2,300 lines TS + 376 lines SQL) but it runs entirely on `FixtureSource`. Phase 0's job is to earn the right to switch it to a real vendor.

---

## Prerequisites (which prior-phase outputs are required)

None — this is the first phase. Two *external* inputs must be in hand before starting:
- The two load-bearing constraints from the master spec §2 are treated as **settled and not re-litigated**: (1) TikTok's Research API is categorically closed to commercial users, so all competitor intelligence runs on purchased third-party data (contract risk, not criminal); (2) "a utility tool to help upload contents to the account(s) you or your team manages" is a verbatim-prohibited TikTok app category, so the write plane routes through draft/inbox.
- A human must **re-verify the §2 TikTok quotes in a real browser before engineering time is committed** (spec §16 retrieval caveat: no §2 quote was read off a live page). This is the first item of week 1 and it gates the legal sign-off.

---

## Tech & tools introduced in this phase (exact technologies/versions)

| Tool | Role in Phase 0 | Commitment |
|---|---|---|
| **EnsembleData — Bronze tier** | Primary vendor candidate; **5,000 units/day @ $200/mo** (Gold is 25,000 @ $800). Flat monthly tiers, daily unit allowances, reset 00:00 UTC | Recurring $200/mo (start after bake-off confirms it) |
| **ScrapeCreators** | Failover vendor candidate; **$47 for 25,000 non-expiring credits** ($1.88/1k), 1 credit per *request*. Zero carrying cost | One-time $47 |
| **Apify `clockworks/tiktok-scraper`** | **Bake-off only — never the hot path.** Pay-per-event $1.70–$3.70/1k, actor-start latency unfit for 15-min polling. Its one useful contribution: the only empirical reliability figure in the space (93.32% success across 11,241,771 runs / 30 days ≈ 6.68% failure, ~1 in 15) — use it to size the retry layer | A few dollars for one bake-off pass |
| **TikTok for Developers** | Register the developer app (write plane); then submit the **Accounts API Access Application Form** — sequential to app submission, blocking since 20 Mar 2026 | $0 |
| **TikTok Business estate** | Register the Business account estate; decide the `account_type` split (business vs creator) | $0 |

**Do NOT** build on the Creative Center internal API — `creative_radar_api` returns `{"code":40101,"msg":"no permission"}` with an attributable `request_id` on every response (ToS breach with an audit trail). Manual browser cross-checks only, never on a cron.

---

## Work breakdown — ordered, concrete tasks

Ordered so the two form-submission clocks (Accounts API form; app review) start ticking on day one while the measurement work runs in parallel.

1. **(Week 1, day 1) Re-verify §2 quotes in a browser.** A human confirms Research-API commercial ineligibility, the unaudited-client restrictions, the 600/min rate table, and the Direct-Post error codes on live TikTok pages. Record the URLs and screenshots as the evidence base for the legal sign-off. *No file — this is a process gate.*

2. **(Week 1) Register the TikTok developer app**, then **submit the Accounts API Access Application Form immediately after** (it is sequential to app submission and has been blocking since 20 Mar 2026 — it is the long-pole for the entire write plane in Phase 3). Register the Business account estate in the same sitting.

3. **(Week 1) Build the two missing bake-off adapters** in `packages/tiktok-source`, behind the existing `TikTokSource` interface:
   - `ScrapeCreatorsSource` (implement `getUserPosts` / `getUserInfo`; **dedupe on video ID** — "TikTok can return duplicate results", never trust cursor ordering).
   - `ApifySource` (bake-off only; a thin wrapper over the `clockworks/tiktok-scraper` actor run — accept the actor-start latency, this adapter never enters the poll loop).
   - Extend `createSource()` so a `VENDOR` env selects among `ensembledata | scrapecreators | apify | fixture`.

4. **(Week 1) Run the vendor bake-off (§4.5).** Push **the same 100 videos** through EnsembleData, ScrapeCreators and Apify **within one hour**. For each vendor and video record `view/like/comment/share` and the fetch timestamp. Compute pairwise disagreement per metric and freshness lag against a **manually-checked ground truth** (open each video in a browser, read the counter). Write results to a throwaway `scripts/bakeoff` harness + a CSV; this is analysis, not product code. **Decision rule:** pick the vendor with the lowest view-count disagreement vs ground truth as primary; the runner-up becomes the circuit-breaker failover in Phase 1.

5. **(Week 1–2) Verify `mapEnsembleVideo()` against a live response** (README gap #1). Set a real `ENSEMBLEDATA_TOKEN`, call the live secUid endpoint for a handful of real accounts, and diff the parsed `TikTokSource` objects against the raw JSON. Confirm: `view_count` really is int64-sized, like/comment/share fit int32, `secUid` is present for the caching optimisation, unix-seconds timestamp parsing (`fromUnixSeconds`) is correct, and `extractHashtags` matches the payload. **This is also part of the bake-off** — the EnsembleData leg of step 4 *is* the live-response check. Fix any field drift before Phase 1 flips `createSource()` off fixture.

6. **(Week 2) Legal sign-off on §11** with a **named owner**. The owner accepts, in writing: third-party collection is a **contract risk with TikTok, not a criminal one**; the read/write plane separation is the primary control; logged-out-only collection; the abstraction layer exists for vendor swap. Attach the browser-verified §2 evidence from step 1.

7. **(Week 2) Decide the account-type split.** Choose, per owned account, `business` vs `creator` — this is a first-class schema field (`owned_account.account_type`) that **gates sound selection at brief-generation time** in Phase 3 (Business gets API publishing/ads but Commercial-Music-Library-only sound; Creator gets trending sounds + Creator Rewards but no API publishing — you cannot have both on one account). Record the decision; no code change yet.

8. **(Week 2) Confirm EnsembleData rollover in writing** (spec §4.1 marks unit rollover `[UNVERIFIED]`). If rollover does *not* happen, a burst-shaped ingestion design is unsafe and Phase 1 must smooth polls across the day. Ask before committing to a burst design.

---

## Data model changes (tables/columns/migrations, SQL sketch where useful)

**None new in Phase 0** — the read-plane schema is already migrated in `supabase/migrations/…_init_tiktok_core`. Phase 0's schema job is a **validation gate, not a migration**: the bake-off must confirm the already-chosen field widths survive contact with the real vendor payload before Phase 1 freezes them.

The two width decisions to re-confirm against the live EnsembleData response (already in the migration, do not change without evidence):

```sql
-- video_metric_snapshot (already migrated; verify against live payload)
view_count    bigint,   -- TikTok view_count is int64  → confirm a real high-view video does not overflow int32
like_count    integer,  -- int32 in TikTok's schema
comment_count integer,
share_count   integer,
favorites_count integer,
PRIMARY KEY (video_id, ts)   -- ts is the FLOORED slot → ON CONFLICT DO NOTHING gives free idempotency
```

If the bake-off shows a vendor returns a field the schema does not model (or a materially different value), **fix it here in Phase 0** — this is the last cheap moment to change the wide table.

---

## Key algorithms & decisions (with the spec's exact thresholds/costs)

- **The $200-vs-$800 rule (§4.2)** — the single most consequential data-layer decision, and it is already honored in the adapter. The dominant cost is repeated per-video snapshots: `Multiple Post Info` costs `2 × #posts`, so tracking 2,000 videos twice daily = 8,000 units/day → forces Gold at $800. But **profile-listing polls already return play/digg/comment/share for every video at zero extra unit cost.** Persisting raw listing payloads and diffing them yields ~9,000 samples/day for free at ~1,400 units/day — inside Bronze at $200. `packages/tiktok-source` already reflects this (no per-video metric method). Secondary saving: poll by cached `secUid` (`depth` units) not username (`1 + depth`) — saves 300 units/day; the adapter already prefers `/tt/user/posts`.
- **Vendor bake-off rationale (§4.5):** no third-party benchmark compares TikTok data vendors, and outperformance detection depends *entirely* on absolute view-count accuracy. "no rate limits" from both EnsembleData and ScrapeCreators are self-assertions on a docs page — measure, don't trust.
- **Retry sizing input:** Apify's 93.32% success / 6.68% failure (≈1 in 15) over 11.2M runs is the number to size Phase 1's retry layer against.
- **Vendor choice becomes the failover topology:** primary = lowest measured disagreement; the runner-up becomes the Phase 1 circuit-breaker target (fail over after 5 consecutive 429/5xx).

---

## External dependencies & monthly cost

| Item | Cost | Notes |
|---|---|---|
| EnsembleData Bronze | **$200/mo** | Start after the bake-off confirms it; primary vendor |
| ScrapeCreators | **$47 one-time** | 25,000 non-expiring credits; failover, ~$0 carrying cost |
| Apify (bake-off pass) | **~few $** | One-time; never on the hot path |
| TikTok developer app / Accounts API form / Business estate | **$0** | Time cost only, but the form is the long-pole for Phase 3 |
| **Phase-0 run rate** | **~$250/mo** | Matches spec §15 Phase-0 budget |

---

## Risks & guardrails

- **ToS/contract risk (§14, high):** third-party collection breaches TikTok ToS. Guardrails established here: logged-out-only collection, isolated read-plane infra (separate cloud account/egress IP/credentials from the write plane), named legal sign-off, and the vendor-swap abstraction (already built). **The read plane and write plane must never share infrastructure, credentials, egress IPs, or TikTok accounts** — this separation is cheap now and expensive to retrofit; Phase 0 is where it is locked in.
- **Vendor-disagreement risk (§14, high):** if vendors disagree ~10% on view counts, every z-score is invalid. Mitigation *is* the bake-off — it must complete before Phase 1 trusts real data.
- **Audit-rejection risk (§14, high):** the product is a named prohibited category. Guardrail starts here: the Accounts API form and any TikTok-facing description must **never describe the tool as a multi-account uploader.** Submit early (blocking since 20 Mar 2026).
- **`[UNVERIFIED]` unit rollover:** do not design a burst-shaped ingestion until rollover is confirmed in writing.
- **Retrieval-integrity caveat:** no §2 quote was read off a live page during research — the browser re-verification (task 1) is a hard prerequisite to the legal sign-off, not optional.

---

## Acceptance criteria / test plan

- [ ] **Bake-off report exists** with per-vendor, per-metric disagreement vs manual ground truth on 100 videos fetched within one hour, and a freshness-lag figure per vendor.
- [ ] **A primary vendor is chosen on measured accuracy** (not docs claims); the runner-up is nominated as the Phase-1 failover.
- [ ] **`mapEnsembleVideo()` verified live:** parsed objects diffed against raw JSON for ≥10 real videos; any field drift fixed and committed to `packages/tiktok-source`.
- [ ] **Field widths confirmed:** a real high-view video's `view_count` exceeds int32 range and still round-trips through `bigint` without loss.
- [ ] **Signed §11 risk acceptance** on file with a named owner and attached browser-verified §2 evidence.
- [ ] **TikTok developer app registered** and **Accounts API Access Application Form submitted** (screenshot/confirmation retained).
- [ ] **Business estate registered** and **account-type split decided** and recorded.
- [ ] **EnsembleData rollover behavior confirmed in writing** (or a smoothed, non-burst ingestion assumed if unconfirmed).

---

## Done checklist

- [ ] §2 TikTok quotes re-verified in a live browser; evidence captured
- [ ] `ScrapeCreatorsSource` + `ApifySource` adapters added behind `TikTokSource`; `createSource()` selects by `VENDOR` env
- [ ] Vendor bake-off run on 100 identical videos within one hour; disagreement + freshness measured vs manual ground truth
- [ ] Primary vendor chosen on measured accuracy; failover nominated
- [ ] `mapEnsembleVideo()` validated against a live EnsembleData response; field drift fixed
- [ ] `video_metric_snapshot` field widths re-confirmed against real payloads (no int32 overflow on `view_count`)
- [ ] Named legal sign-off on §11 recorded
- [ ] TikTok developer app registered
- [ ] Accounts API Access Application Form submitted (started week 1)
- [ ] Business account estate registered
- [ ] `account_type` split (business vs creator) decided and recorded
- [ ] EnsembleData unit rollover confirmed in writing (or burst design avoided)

**Exit gate:** signed risk acceptance + chosen vendor with measured accuracy + Accounts API form submitted → proceed to [Phase 1 — See](./PHASE-1-see.md).
