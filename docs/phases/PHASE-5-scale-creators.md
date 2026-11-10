# Phase 5 — Scale creators (weeks 19–24)

> Spec basis: `completion.md` §9 (712–835), phasing §15 (Phase 5). Cross-refs: [../00-ARCHITECTURE.md](../00-ARCHITECTURE.md) (write-plane placement of the CRM), [./PHASE-3-act-publishing.md](./PHASE-3-act-publishing.md) (owned accounts + Business Center linking Spark Ads reuses), [./PHASE-4-attribute.md](./PHASE-4-attribute.md) (`performance_fact` reuses install/signup/trial/subscription counters), [./PHASE-2-understand.md](./PHASE-2-understand.md) (`er_views` denominator convention for vetting).

The Creator CRM/UGC programme lives in the **write plane** — it is authenticated, auditable, and never touches read-plane scraping infrastructure (§3). This is the largest discrete cost commitment in the whole build (Modash floor), so it comes last.

**Status: BUILT — code-complete as of 2026-08-16.** `packages/creator-crm` (collaboration stage machine with legal-only transitions, pricing with **no default `exclusivity_multiplier`** and **no "50% of ask" rule**, fake-follower + er_views vetting, licence-end alerting, Modash client that captures `credibility` at search time and guards the 404-quota trap, HypeAuditor client pinned to `v=2019-10-18` + throttled) and `apps/worker-creators` (discovery with dedup-on-`platform_user_id`, one-shot-DM outreach cadence, licence-alerts, Spark sync that re-mints expired codes, perf-ingest joined to Phase 4) are implemented with 69 passing unit tests. Migration `…08` written (types hand-added). Needs to run live: apply the migration + **Modash $16,200/yr sign-off**, live Modash/HypeAuditor/Business-Center creds, real outreach. Vendor wire shapes flagged `// UNVERIFIED`; every rate figure tagged "negotiating range — replace with own data".

---

## Goal & definition of done

Run a multi-app UGC creator programme end to end: **source → qualify → contact → negotiate → contract → deliver → live**, with rights and payments tracked and Spark Ads wired so paid amplification accrues to the creator's organic post.

**Definition of done (matches §15 exit):** creators **sourced → contracted → delivering → attributed**, with **no expired usage licences live**. Concretely:

1. **Modash Discovery API** integrated, **capturing `credibility` at search time** (it is query-time-only and never returns on re-fetch — §9.1).
2. **Collaboration-level CRM** — the collaboration, not the creator, is the entity that moves through stages (§9.5), because the same creator sits at different stages for different Goodfor apps simultaneously.
3. **Outreach cadence** — DM first touch, email for the cadence, follow-ups **day 2 and day 5**, terminal at **day 28** (§9.2).
4. **`rights_grant` shipped in v1** with **`licence_end` alerting** — a live paid ad on an expired licence is the single largest routine legal exposure (§9.5).
5. **Spark Ads** wired via **Business Center account-level linking** (no expiry), storing the **organic post id as the join key** between organic and paid performance (§9.3).
6. Per-collaboration performance flowing into `performance_fact`, joined to the Phase 4 attribution funnel.

---

## Current state (what already exists in the codebase for this phase)

**Nothing is built.** Per the code audit, Phase 5 is *Not started*: no Modash integration, no creator CRM/pipeline, no DM→email cadence, no rights/`licence_end` alerting, no Spark Ads / Business Center linking. Grep confirms **no creator-CRM tables exist.**

What exists and is reused:

- **`owned_account`** (in `20260815000001_init_tiktok_core.sql`) — already implemented; `account_type` and Business Center linking underpin Spark Ads.
- **Phase 4 attribution funnel** (`attributed_install`, `app_conversion`) — the CRM's `performance_fact` reuses the same install/signup/trial/subscription counters so creator ROI and organic ROI are measured on one ruler.
- **`er_views` convention** — the read-plane already treats `er_views` (likes+comments+shares ÷ views) as the correct TikTok engagement denominator; vetting here reuses it.

No `packages/creator-crm`, no `apps/worker-creators`, no creator dashboard exist yet.

---

## Prerequisites (which prior-phase outputs are required)

| From | Output required | Why |
|---|---|---|
| Phase 3 | Owned accounts + Business Center estate | Spark Ads account-level linking hangs off it |
| Phase 4 | Attribution funnel (`attributed_install` → `app_conversion`) | `performance_fact` joins creator deliverables to installs/subscriptions |
| Phase 0 | Business estate registered; legal sign-off | Modash contract + rights tracking are legal-adjacent |
| Budget | Sign-off on the **Modash $16,200/yr floor** | This is the gate, not the unit cost (§9.1) — do not start integration until committed |

---

## Tech & tools introduced in this phase (exact technologies/versions)

- **Modash Discovery API** — **$16,200/yr**, 3,000 credits/mo @ **$0.45**. Search costs **0.01 credit per result** (not per request); influencer report 1, audience report 1, performance 0.25, taxonomy 0. A 1,000-creator shortlist + 200 full reports = **210 credits = $94.50**, well inside the allowance (§9.1). Indexes **1k+ followers only**; nano-tier is direct-outreach-only.
- **HypeAuditor** — second opinion for its **Audience Quality Score** (which Modash's TikTok report lacks). Build against the **free sandbox** (`auditor.searchSandbox`); **pin `v=2019-10-18`** explicitly (omitting the version defaults to LATEST). Rate limit: the only defensible reading is **100 requests/minute ≈ 1.67 RPS** (§9.1). Pricing is unpublished — the circulating $299/$499 figures were fact-checked out.
- **TikTok DM** — one-shot channel: TikTok delivers **exactly one** message to a non-follower's request inbox, then blocks until they accept/reply. **DM for first touch, email for cadence** (§9.2).
- **Spark Ads** — Business Center **account-level linking** (no expiry until unlinked) preferred over per-video codes; code durations 7/30/60/**365** days (default 30); up to **20 codes** batch-submitted (§9.3).
- **Supply marketplaces (buy, do not integrate as data):** JoinBrands, Collabstr, Insense, Billo (§9.1). **JoinBrands is the only marketplace confirmed to include Spark Codes at no extra cost** (§9.6).
- **Node/TypeScript**, matching the stack.

**Explicitly rejected (§9.1):** Phyllo/InsightIQ in the **cold-discovery** path (bi-weekly refresh — right only for post-recruitment consented data, 24h refresh, 90-day history on connection); Heepsy (no API); Aspire/Upfluence/GRIN/CreatorIQ/Traackr/Klear ($17K–$100K+ floors, paying for a UI you replace); TikTok Creator Marketplace (**dead** — migrated to TikTok One 10 Mar 2025, TCM shut 1 Apr 2025; TTO Basic is 50 queries/day, unusable as a crawler).

---

## Work breakdown — ordered, concrete tasks

1. **Migration `20260815000008_creator_crm.sql`** (schema below) — ship `rights_grant` in the **same** migration, not a follow-up.
2. **`packages/creator-crm` (new)** — pure-TS domain core:
   - `stage-machine.ts` — the collaboration state machine `sourced → qualified → contacted → replied → negotiating → contracted → delivered → live` (terminal `paid | renewed | archived | rejected`); legal transitions only.
   - `pricing.ts` — `licence_cost = base_fee × (1 + usage_multiplier + whitelist_rate × months + exclusivity_multiplier)`; **`exclusivity_multiplier` has NO default** (operator-set); anchors as constants but flagged weak (below).
   - `vetting.ts` — fake-follower gate (**hire <25%, avoid >50%**), rank on **`er_views`** vs a **6–8% median band** by tier.
   - `licence.ts` — `licence_end` computation + alert trigger.
3. **`packages/creator-crm` Modash client** — Discovery search + report fetch. **Capture `credibility` from the search response and persist it immediately** — it is never returned on re-fetch. Guard the **404-consumes-quota** trap (§9.1). Stamp `source_vendor` + `vendor_last_synced_at` on every enriched row.
4. **HypeAuditor client** — sandbox-first, `v=2019-10-18` pinned, throttled to 100 req/min. Pulls Audience Quality Score into `creator_audience`.
5. **`apps/worker-creators` (new)** — write-plane worker:
   - `discovery.ts` — run saved searches, dedupe on `platform_user_id`, write `creator_account` + `creator_audience` (with credibility), never UPDATE metrics (append `creator_metric_snapshot`).
   - `outreach.ts` — DM-first send (one shot), then email cadence day 2 / day 5, terminal day 28; stamp `first_contacted_at`, `replied_at`, `next_action_at`.
   - `licence-alerts.ts` — nightly scan for `rights_grant.expires_at` approaching while a linked deliverable is `live`; raise alert.
   - `spark-sync.ts` — Business Center account-level linking; pull per-post paid metrics; **join on the organic post id**.
   - `perf-ingest.ts` — write `performance_fact` (append-only) joined to Phase 4 `app_conversion`.
6. **Spark Ads flow** — implement Business Center linking as primary; per-video codes as fallback. Handle `auth_code_expired` (codes **cannot be reactivated — mint a new one**), `auth_code_format_error`, `not_public_video`, `story_video_not_supported`.
7. **Dashboard** — creator pages under `apps/dashboard`: `creators/` (shortlist + vetting scores), `pipeline/` (collaboration board by stage, per app), `rights/` (licence calendar + `licence_end` alerts), `spark/` (organic-vs-paid per post), `creator-roi/` (`performance_fact` → attribution). Extend `lib/queries.ts` accordingly.
8. **Marketplace buying playbook (not integration)** — operator runbook: buy supply from JoinBrands/Collabstr/Insense; record deals into the same CRM manually or via CSV import; **do not build API integrations to these** (§9.1).

---

## Data model changes

New migration **`20260815000008_creator_crm.sql`**, from §9.5. Write-plane; RLS enabled, no policies (service-role only). **Model the collaboration, not the creator, as the moving entity.**

```sql
-- Dedupes one human across platforms and handle changes.
create table if not exists creator_identity (
  id                bigint generated always as identity primary key,
  display_name      text,
  primary_email     text,
  country           text,
  timezone          text,
  payment_entity_id bigint,
  notes             text,
  created_at        timestamptz not null default now()
);

-- KEY ON platform_user_id, NEVER username (§9.5).
create table if not exists creator_account (
  id                   bigint generated always as identity primary key,
  creator_identity_id  bigint references creator_identity(id) on delete set null,
  platform             text not null,
  platform_user_id     text not null,
  username             text,
  url                  text,
  followers            bigint,
  engagement_rate      numeric(6,4),          -- er_views convention
  avg_views            bigint,
  is_verified          boolean,
  last_posted_at       timestamptz,
  source_vendor        text not null,         -- provenance stamp
  vendor_last_synced_at timestamptz not null,
  unique (platform, platform_user_id)
);

create table if not exists creator_metric_snapshot (   -- append-only, never UPDATE
  creator_account_id bigint not null references creator_account(id) on delete cascade,
  captured_at        timestamptz not null,
  followers          bigint,
  avg_views          bigint,
  engagement_rate    numeric(6,4),
  primary key (creator_account_id, captured_at)
);

-- credibility_score is NULLABLE and captured at SEARCH time only — re-fetch never returns it.
create table if not exists creator_audience (
  id                  bigint generated always as identity primary key,
  creator_account_id  bigint not null references creator_account(id) on delete cascade,
  captured_at         timestamptz not null,
  gender_split        jsonb,
  age_split           jsonb,
  geo_countries       jsonb,
  languages           jsonb,
  interests           jsonb,
  credibility_score   numeric(5,2),           -- Modash query-time-only signal — persist NOW
  audience_quality_score numeric(5,2),        -- HypeAuditor AQS
  audience_reachability numeric(5,2)
);

-- Goodfor is one of several apps.
create table if not exists app (
  id        bigint generated always as identity primary key,
  slug      text not null unique,
  name      text not null
);

create table if not exists campaign (
  id           bigint generated always as identity primary key,
  app_id       bigint not null references app(id) on delete cascade,
  objective    text,
  budget_cents integer,
  start_date   date,
  end_date     date,
  brief_url    text
);

-- THE moving entity. Same creator, different stage per app, simultaneously.
create table if not exists collaboration (
  id                 bigint generated always as identity primary key,
  campaign_id        bigint not null references campaign(id) on delete cascade,
  creator_account_id bigint not null references creator_account(id) on delete cascade,
  stage              text not null default 'sourced' check (stage in
                       ('sourced','qualified','contacted','replied','negotiating',
                        'contracted','delivered','live','paid','renewed','archived','rejected')),
  owner_user_id      bigint,
  rate_cents         integer,
  currency           text default 'USD',
  first_contacted_at timestamptz,
  replied_at         timestamptz,
  contracted_at      timestamptz,
  next_action_at     timestamptz,             -- drives the day 2 / day 5 / day 28 cadence
  source             text,
  created_at         timestamptz not null default now()
);
create index if not exists collaboration_stage_idx on collaboration (stage, next_action_at);

create table if not exists deliverable (
  id                     bigint generated always as identity primary key,
  collaboration_id       bigint not null references collaboration(id) on delete cascade,
  type                   text,
  due_date               date,
  status                 text,
  asset_url              text,
  posted_url             text,
  platform_post_id       text,                -- organic post id = Spark join key
  is_spark_ads_authorized boolean not null default false,
  spark_ads_code         text,
  spark_ads_expires_at   timestamptz
);

-- SHIP IN v1. A live paid ad on an expired licence is the top routine legal exposure.
create table if not exists rights_grant (
  id                     bigint generated always as identity primary key,
  collaboration_id       bigint not null references collaboration(id) on delete cascade,
  usage_scope            text not null check (usage_scope in
                           ('organic_only','paid_ads','whitelisting','perpetual')),
  territories            text[],
  starts_at              timestamptz not null,
  expires_at             timestamptz,          -- licence_end — alert on this
  exclusivity_window_days integer,
  renewal_price_cents    integer
);
create index if not exists rights_grant_expiry_idx on rights_grant (expires_at)
  where expires_at is not null;

create table if not exists payment (
  id                bigint generated always as identity primary key,
  collaboration_id  bigint not null references collaboration(id) on delete cascade,
  amount_cents      integer not null,
  currency          text not null default 'USD',
  platform_fee_cents integer,
  method            text,
  status            text,
  invoice_url       text,
  tax_form_status   text
);

-- append-only per capture; reuses Phase 4 funnel counters for one-ruler ROI.
create table if not exists performance_fact (
  id                 bigint generated always as identity primary key,
  deliverable_id     bigint not null references deliverable(id) on delete cascade,
  captured_at        timestamptz not null,
  views              bigint,
  likes              integer,
  comments           integer,
  shares             integer,
  saves              integer,
  install_count      integer,
  signup_count       integer,
  trial_count        integer,
  subscription_count integer,
  revenue_cents      integer
);
```

**Three schema rules enforced (§9.5):** key on `platform_user_id` never username; never UPDATE metrics in place (`creator_metric_snapshot` and `performance_fact` are append-only); stamp vendor provenance + sync timestamp on every enriched row (Modash on-demand vs Phyllo bi-weekly have completely different staleness).

---

## Key algorithms & decisions (with the spec's exact thresholds/costs)

- **Capture credibility at search time (§9.1).** The TikTok Modash report returns **no `credibility` field and no brand-affinity field** — credibility is a **query-time-only** signal. Persist it from the search response on shortlist; re-fetching the report later will never return it. This is a **schema decision with no second chance**.
- **Modash cost shape (§9.1):** the **$16,200/yr floor is the barrier, not the unit cost.** A realistic shortlist cycle is ~210 credits ≈ $94.50/mo against a 3,000-credit allowance. Guard the **"404 is a successful request that consumes quota"** trap in the client.
- **Vetting (§9.4):** fake followers — **hire <25%, avoid >50%** (Modash guidance; sub-50K creators run 10–20% fake, larger 20–30%). Rank on **`er_views`** (likes+comments+shares ÷ views × 100) against a **6–8% median band** by tier — the circulating "micro 2–4%" figures are follower-denominator numbers in disguise. HypeAuditor's AQS publishes **no numeric cutoff** (detection is "probabilistic, not perfect").
- **Outreach (§9.2):** **DM first touch, email for cadence** — TikTok delivers exactly **one** DM to a non-follower then blocks. Follow up **day 2 and day 5**, keep messages **<250 words**, plateau/terminal at **day 28**. Plan for the **low end** of every response band (an early-stage app gets the seed-stage response rate).
- **Spark Ads (§9.3):** engagement accrues **permanently to the creator's original organic post**, not a separate ad object → **store the organic post id as the join key** (`deliverable.platform_post_id`). Prefer **Business Center account-level linking** (no expiry until unlinked) over per-video codes. Codes **cannot be reactivated** — on `auth_code_expired`, mint a new one.
- **Marketplace take rates (§9.6):** JoinBrands 15/12/10/8% (free/$99/$299/$499); Collabstr **~25% effective** (10% brand + 15% creator — the headline 10% is half the story); Insense 20/10/7% ($500/mo). **JoinBrands is the only marketplace confirmed to bundle Spark Codes** — decisive if paid amplification is in scope.
- **CRM entity choice (§9.5):** the **collaboration** moves through stages, not the creator, because one creator is simultaneously at different stages for different Goodfor apps. This is why `collaboration` (not `creator_account`) carries `stage`.

### ⚠️ Weak-evidence items — verify before modeling money on these

§9 explicitly calls its own pricing **"the softest evidence in the entire research"** — seven claimed rate figures were unsupported at their sources and seven more were wrong. Treat everything below as a **negotiating range, never a formula**:

- **Creator rates (§9.2)** — `[SINGLE-SOURCE, Collabstr 2026, 403 on direct fetch]`: UGC ask **$180**, actually paid **$154 (85.6%)**, campaign avg $197, 80% of deals under $300. **Plan at $150–$200/video.** **Do NOT encode "brands pay 50% of ask"** — that figure appears nowhere in the report; the real ratio is **86%**.
- **Exclusivity premium** — the commonly cited "20–40% exclusivity premium" appears at **none** of its claimed sources → `exclusivity_multiplier` ships with **no default**, operator-set only.
- **Licensing multipliers (§9.2)** — the *strongest-verified* pricing block (triple-sourced): usage rights **30–50% of base**, raw footage **30–50%**, extra hook/CTA **$50 flat**, whitelisting/Spark **30%/month**, full buyout **2–5×**. Still, validate against Goodfor's actual negotiated deals before treating as planning constants.
- **Outreach 32.8% baseline response (§9.2)** — `[VENDOR, 1stCollab, only one with a stated sample]`: 47% of replies <24h, 91% <7 days, plateau 28 days, prior-relationship ~2.5×. Vendor data — plan for the low end.
- **Every Spark Ads performance statistic (§9.3)** — `[REFUTED]`. The "+43% conversion", "+134% completion", and the Nielsen/Socialbakers/Measured/Kantar studies all trace to a single SEO listicle with broken arithmetic; none of the underlying studies could be shown to exist. **Measure your own.**
- **Hook-retention benchmarks (§6.5, applied when scoring creator content)** — all 3-second retention benchmarks are `[REFUTED]`; only TikTok's **5-second** boundary is grounded. Regress creator content against your own retention curves.
- **Link-in-bio CTR (§10.6)** — `[UNVERIFIED]`, the weakest number in the document; if creator ROI models lean on it, replace with pause-test-derived numbers from [Phase 4](./PHASE-4-attribute.md).
- **Modash database size** — their own pages claim 96M / 200M / 250M / 380M on different URLs. Do not cite a coverage number; the load-bearing constraint is simply **1k+ followers only**.

---

## External dependencies & monthly cost

| Item | Cost/mo | Notes |
|---|---|---|
| **Modash Discovery API** | **$1,350/mo** ($16,200/yr) | The floor **is** the barrier; unit usage ~$94.50 (§9.1) |
| Modash Raw API (optional) | $833/mo ($10,000/yr) | Only if bulk enrichment needed; combined ≈ **$2,183/mo** (§13, the largest discrete commitment) |
| HypeAuditor | $0 (sandbox) → unpublished | Build on free sandbox; pricing unpublished, plan a line item TBD |
| Creator supply (JoinBrands et al.) | variable, **$150–$200/video** | Buy, don't integrate; take rates §9.6 |
| Attribution MMP (Tenjin, if triggered) | ~$2,200/mo | Only "when volume demands," from [Phase 4](./PHASE-4-attribute.md) (§10.2) |
| Worker compute | rolls into existing line | Write-plane process |

Per §13 the **with-creators system total is ~$3,050–$6,134/mo**, with **Modash +$2,183/mo the single largest discrete commitment** and data acquisition ($1,300) still the dominant recurring line. §15 targets **~$2,000/mo** for the phase's incremental spend. **Do not begin Modash integration until the $16,200/yr floor is signed off** — it is a commitment, not a metered cost.

---

## Risks & guardrails

- **Expired licence on a live ad (§9.5, top routine legal exposure).** `rights_grant` ships in v1 with `licence_end` alerting; the nightly scan blocks/flags any `live` deliverable whose `rights_grant.expires_at` has passed. Trivial to build now, painful to retrofit.
- **Credibility lost forever (§9.1).** If the discovery client doesn't persist `credibility_score` on the search response, it is unrecoverable. Enforce at the client boundary: no shortlist write without the score captured.
- **Modash 404 quota drain (§9.1).** "A 404 is treated as a successful request" and consumes quota — a crawler that retries 404s burns the allowance. Guard explicitly.
- **DM burn (§9.2).** TikTok blocks after one DM to a non-follower. The outreach worker must send exactly one DM then switch to email; never retry the DM.
- **Vendor staleness confusion (§9.5).** Modash on-demand vs Phyllo bi-weekly (rejected for cold discovery) have different staleness — every enriched row stamps `source_vendor` + `vendor_last_synced_at` so a stale Phyllo row is never mistaken for fresh.
- **Marketplace lock-in.** Collabstr's ~25% effective rate (not the headline 10%) and JoinBrands' Spark-code bundling are cost/capability facts, not integration decisions — record deals in the CRM; do not build to their APIs.
- **Plane boundary.** The CRM and Spark tooling are write-plane, authenticated; they never share credentials or egress with read-plane scraping (§3, §14).
- **US divestiture / regional partitioning (§14).** Partition creator-performance benchmarks US/non-US and pre/post 22 Jan 2026 — never pool.

---

## Acceptance criteria / test plan

1. **Credibility persistence:** a discovery search writes `creator_audience.credibility_score` from the search response; a later report re-fetch leaves it unchanged (proving it's captured at search time, not re-derived).
2. **Dedup correctness:** two records for the same human across handle changes resolve to one `creator_identity`; `creator_account` uniqueness holds on `(platform, platform_user_id)`, never username.
3. **Stage machine:** illegal transitions (e.g. `sourced → live`) are rejected; the same creator sits at different stages in two campaigns for two apps simultaneously without conflict.
4. **Outreach cadence:** a new collaboration fires exactly one DM, then email on day 2 and day 5, then terminal on day 28; `next_action_at` advances correctly.
5. **Licence alerting:** a `rights_grant` with `expires_at` in the past while its deliverable is `live` raises an alert; extending `expires_at` clears it.
6. **Spark join:** paid metrics for a Spark-authorized post join to the organic post via `deliverable.platform_post_id`; `auth_code_expired` triggers new-code minting, not reactivation.
7. **ROI join:** `performance_fact` for a deliverable reconciles against the Phase 4 `app_conversion` funnel for the same featured post.
8. **End-to-end (definition of done):** at least one creator taken **sourced → contracted → delivering → attributed**, with **zero expired licences live** across the estate.

---

## Done checklist

- [ ] Budget sign-off on the Modash **$16,200/yr** floor before integration starts
- [ ] Migration `20260815000008_creator_crm.sql` applied (`creator_identity`, `creator_account`, `creator_metric_snapshot`, `creator_audience`, `app`, `campaign`, `collaboration`, `deliverable`, `rights_grant`, `payment`, `performance_fact`), RLS enabled, `rights_grant` shipped **in v1**
- [ ] `packages/creator-crm` created (`stage-machine`, `pricing`, `vetting`, `licence`) with unit tests; `exclusivity_multiplier` has no default
- [ ] Modash Discovery client: credibility captured at search time, 404-quota guard, provenance stamps
- [ ] HypeAuditor client: sandbox-first, `v=2019-10-18` pinned, 100 req/min throttle, AQS → `creator_audience`
- [ ] `apps/worker-creators` running in the **write plane** (`discovery`, `outreach`, `licence-alerts`, `spark-sync`, `perf-ingest`)
- [ ] Outreach: DM-first (one shot) → email day 2 / day 5 → terminal day 28
- [ ] `licence_end` nightly alert live and tested
- [ ] Spark Ads via Business Center account-level linking; organic post id stored as join key; `auth_code_expired` → new code
- [ ] Dashboard pages: `creators/`, `pipeline/`, `rights/`, `spark/`, `creator-roi/`
- [ ] `performance_fact` joined to Phase 4 attribution funnel for one-ruler ROI
- [ ] Every weak-evidence number (creator rates, exclusivity premium, outreach response rate, Spark lift stats, hook-retention, link-in-bio CTR) tagged as "negotiating range / replace with own data"; no "50% of ask" rule anywhere in code
- [ ] At least one creator taken sourced → contracted → delivering → attributed, zero expired licences live
