# Phase 4 — Attribute (weeks 15–18)

> Spec basis: `completion.md` §10 (836–921), phasing §15 (Phase 4). Cross-refs: [../00-ARCHITECTURE.md](../00-ARCHITECTURE.md) (write-plane / read-plane boundary), [./PHASE-3-act-publishing.md](./PHASE-3-act-publishing.md) (owned accounts + published posts this phase measures), [./PHASE-2-understand.md](./PHASE-2-understand.md) (`format_cluster`, the unit CPPs map to), [./PHASE-5-scale-creators.md](./PHASE-5-scale-creators.md) (`performance_fact` reuses this phase's install/signup/trial/subscription counters).

Attribution lives entirely in the **write plane**. It touches Goodfor's own apps, own TikTok accounts, and an MMP holding Goodfor's own keys. It must never share infrastructure, credentials, or egress with the read plane (§3, §14 risk 2).

**Status: BUILT — code-complete as of 2026-08-16.** `packages/attribution` (install-referrer parser, Apple control-total gunzip/parser, `ct` base36 codec, format-lift OLS regression, CPI, Kochava MMP client with the billing-trap guard, cadence guard) and `apps/worker-attribute` (install-ingest with bio-rotation resolution, bio-link rotation, Apple ES256-JWT poll with idempotent re-key, cpp-sync, lift-fit, tick + write-plane boot guard) are implemented with 80 passing unit tests. Migration `…07` written (types hand-added). Needs to run live: apply the migration, the cross-team mobile SDK work (Android `installreferrer:2.2`, iOS HDYHAU), live Kochava/Apple creds, and a real single-channel pause test for the CPI deliverable. Kochava/Apple wire shapes flagged `// UNVERIFIED`.

---

## Goal & definition of done

Turn "we published a video" into "that video drove N installs → M signups → K subscriptions worth $X" — as far as the platforms physically allow, which is **fully deterministic on Android and essentially never per-video on iOS** (§10.1).

**Definition of done (matches §15 exit):** a *defensible organic CPI derived from an incrementality test*, not from a vendor benchmark. Concretely:

1. Android per-video ground truth flowing: `Play Install Referrer → utm_content=<video_id> → attributed_install`, 100% deterministic (§10.1).
2. Per-account bio links with a **rotation log** so an organic install can be pinned to whichever video was featured in bio at click time.
3. Apple **Analytics Reports API** loaded idempotently as a daily channel-level **control total** (§10.3), re-keyed on `(date, processing_date)`.
4. Custom Product Pages mapped 1:1 onto `format_cluster` rows, giving **format-level iOS conversion above the privacy floor** (§10.3).
5. Post-paywall **HDYHAU** survey + **thumbnail follow-up** live in the app (§10.4) — the only $0 per-video iOS mechanisms.
6. One **single-channel pause test** completed end-to-end, producing a computed organic CPI (§10.4, §10.6).

---

## Current state (what already exists in the codebase for this phase)

**Nothing attribution-specific is built.** Per the code audit, Phase 4 is *Not started*: no tables, no code for Install Referrer, per-video `utm_content`, bio-link rotation, HDYHAU, Apple Analytics, Custom Product Pages, or the pause test.

What *does* exist and is load-bearing here:

- **`owned_account`** and **`scheduled_post`** (in `20260815000001_init_tiktok_core.sql`) — already implemented. `scheduled_post.publicaly_available_post_id` (TikTok's verbatim misspelling) is the public post id that appears only after moderation; it is the natural join key from a published Goodfor video to its attribution.
- **`format_cluster`** (in `20260815000004_analysis.sql`) — already implemented. This is the entity a Custom Product Page maps onto.
- Read-plane scoring/ingestion (`packages/scoring`, `apps/worker-read`) — untouched by this phase and must stay untouched.

No `packages/attribution`, no `apps/worker-attribute`, no attribution dashboard pages exist yet.

---

## Prerequisites (which prior-phase outputs are required)

| From | Output required | Why |
|---|---|---|
| Phase 3 | Live published posts on owned accounts, with `publicaly_available_post_id` reconciled | Nothing to attribute until Goodfor is actually posting |
| Phase 3 | Anti-spam governor + one-posting-system-per-account | The cadence constraint (below) extends it; you cannot bolt cadence on after posting habits form |
| Phase 2 | `format_cluster` taxonomy populated | CPPs and the format-lift kernel key on cluster id |
| Cross-team (Goodfor app) | Android build integrating `com.android.installreferrer:installreferrer:2.2`; iOS build with the HDYHAU + thumbnail survey screens | These are **mobile-app changes outside this monorepo** — schedule them week 1; they gate everything |
| Phase 0 | Named legal sign-off (unchanged) | Owned-media MMP links are fine; the plane boundary is the risk control |

**The mobile-app dependency is the critical path.** The SDK and survey work happens in the Goodfor consumer app, not here. Book it in week 15 or Phase 4 slips.

---

## Tech & tools introduced in this phase (exact technologies/versions)

- **Android:** Play Install Referrer library `com.android.installreferrer:installreferrer:2.2`. Read once on first launch; 90-day install-referrer retention (§10.1).
- **MMP:** **Kochava free tier** — 10K attributed conversions/month, owned-media attribution + SmartLinks, **$0** (§10.2). This is the deliberate starting choice. Tenjin (~$2,200/mo at the ≤$0.03 overage ceiling) is deferred to "when volume demands" (§13 with-creators column).
- **Apple:** App Store Connect **Analytics Reports API** — `POST https://api.appstoreconnect.apple.com/v1/analyticsReportRequests`, `accessType: ONGOING`, JWT (ES256) auth, **Admin role** required for the first request of each report type. Output is tab-delimited `.txt.gz` (§10.3).
- **Apple Custom Product Pages** — up to **70** page versions, each with its own conversion metrics (§10.3).
- **Apple campaign links** — `pt`/`ct`/`mt`; `ct` ≤ **30 alphanumeric chars**, encoded base36 with a lookup table (§10.3).
- **Incrementality:** start with a manual **single-channel pause test**; scale later to **GeoLift** (Meta, R) or **Meridian** (Google Bayesian MMM, Python **3.11–3.13**, GPU recommended) — deferred, not built this phase (§10.4).
- **Node/TypeScript** for the new package and worker, matching the existing stack (§3.2).

**Explicitly not adopted:** SKAdNetwork / AdAttributionKit (organic uncovered — no postback possible, §10.1); fingerprinting (banned, app-rejection risk, §10.1); Privacy Sandbox / Attribution Reporting API (retiring, announced 17 Oct 2025 — do not architect on it, §10.1); AppsFlyer/Singular/Branch/Adjust as the starting MMP (price, §10.2).

---

## Work breakdown — ordered, concrete tasks

Ordered so each step unblocks the next.

1. **`packages/attribution` (new).** Pure-TS core, no I/O:
   - `install-referrer.ts` — parse the Android referrer string `utm_source=tiktok&utm_content=<video_id>`; validate; return `{ utmSource, videoId }`.
   - `apple-control-total.ts` — parse the tab-delimited `.txt.gz` Analytics report; map the Source Type enum (`App Store search | App Store browse | App referrer | Web referrer | App Clip | Unavailable | Institutional purchase`) — TikTok's in-app webview is an **App referrer** (§10.3).
   - `ct-codec.ts` — base36 encode/decode of `ct` campaign codes with a persisted lookup table (≤30 chars).
   - `format-lift.ts` — the daily regression `installs_t = baseline + Σ_v (views_{v,t} × k_format)` with a **1–3 day lag kernel** (§10.5); emits `k_format` per `format_cluster`.
   - `cpi.ts` — compute organic CPI from a pause test: `(fully-loaded content cost) ÷ (incremental installs)` (§10.6). **No published constant.**
2. **`packages/attribution` MMP client** — thin Kochava wrapper for SmartLink creation + owned-media conversion pull. Guard the **billing trap** (below) at the client boundary.
3. **Migration `20260815000007_attribution.sql`** (schema below).
4. **`apps/worker-attribute` (new)** — write-plane worker, isolated from `apps/worker-read`:
   - `install-ingest.ts` — receive install-referrer callbacks (from the app backend / Kochava postback), match to the bio-link rotation active at click time, write `attributed_install`.
   - `apple-poll.ts` — daily pull of Analytics Reports; idempotent upsert into `apple_analytics_daily` keyed on `(date, processing_date, source_type, metric_name)`, newest `processing_date` wins.
   - `cpp-sync.ts` — pull per-CPP conversion metrics; join to `format_cluster` via `custom_product_page`.
   - `lift-fit.ts` — nightly `format-lift` fit; persist `k_format`.
   - `tick.ts` — the worker loop (mirror `apps/worker-read/src/tick.ts` shape, separate process/credentials).
5. **Bio-link rotation service** — `bio-link.ts` in the worker: one stable short link per owned account whose `utm_content` is stamped with the currently-featured post; every change appends to `bio_link_rotation`. This is what makes organic installs per-video attributable at all.
6. **Cadence guard** — extend the Phase 3 anti-spam governor (`scheduled_post`) with an **attribution cadence check**: refuse to schedule a 3rd video/account/day (identification requires ≤1–2, §10.5). Surface it as a warning, not a hard block, but log the override.
7. **Custom Product Page registry** — provisioning script that creates up to 15 CPPs (one per recurring format), stores `cpp_apple_id ↔ format_cluster_id ↔ ct_code`.
8. **App-side (cross-team, tracked here):** Android SDK read-on-first-launch; iOS HDYHAU post-paywall + thumbnail follow-up screens; both POST to the attribution ingest.
9. **Dashboard** — new pages under `apps/dashboard`: `attribution/` (per-video installs, Android ground truth), `formats-conversion/` (CPP → format conversion), `control-total/` (Apple reconciliation vs summed attribution), `incrementality/` (pause-test CPI). Extend `lib/queries.ts` with `getVideoInstalls`, `getFormatConversion`, `getControlTotalReconciliation`, `getIncrementalityResult`.
10. **Run the first single-channel pause test** (2–4 weeks — this straddles into acceptance; kick it off week 15/16 so it clears within the phase).

---

## Data model changes

New migration **`20260815000007_attribution.sql`**. All tables write-plane; enable RLS with no policies (service-role only), matching the existing convention.

```sql
-- Per-account bio link + append-only rotation log.
-- Organic TikTok has no per-video link; the ONLY per-video signal is
-- "which featured video was live in bio when the user clicked".
create table if not exists bio_link (
  id                bigint generated always as identity primary key,
  owned_account_id  bigint not null references owned_account(id) on delete cascade,
  slug              text   not null unique,            -- short code in the URL
  store_url_android text   not null,                   -- Play URL carrying utm_content
  store_url_ios     text   not null,                   -- App Store URL carrying pt/ct
  created_at        timestamptz not null default now()
);

create table if not exists bio_link_rotation (   -- append-only, never UPDATE
  id                bigint generated always as identity primary key,
  bio_link_id       bigint not null references bio_link(id) on delete cascade,
  featured_post_id  bigint references scheduled_post(id) on delete set null,
  utm_content       text   not null,                   -- = published TikTok video id
  format_cluster_id integer references format_cluster(id) on delete set null,
  rotated_on_at     timestamptz not null default now(),
  rotated_off_at    timestamptz                        -- null = currently live
);
create index if not exists bio_link_rotation_live_idx
  on bio_link_rotation (bio_link_id, rotated_on_at desc) where rotated_off_at is null;

-- Deterministic on Android; best-effort/null video on iOS.
create table if not exists attributed_install (
  id                bigint generated always as identity primary key,
  platform          text not null check (platform in ('android','ios')),
  owned_account_id  bigint references owned_account(id) on delete set null,
  featured_post_id  bigint references scheduled_post(id) on delete set null,
  format_cluster_id integer references format_cluster(id) on delete set null, -- denormalized for lift
  utm_content       text,                              -- video id, null on unattributable iOS
  is_deterministic  boolean not null,                  -- true only for Android referrer
  source            text not null,                     -- 'play_referrer' | 'kochava' | 'hdyhau' | 'ios_extrapolated'
  installed_at      timestamptz not null,
  first_launch_at   timestamptz,
  device_pseudo_id  text                               -- never PII in a URL (§ privacy)
);
create index if not exists attributed_install_post_idx on attributed_install (featured_post_id);

-- Funnel after install; append-only (never UPDATE metrics — §12 rule).
create table if not exists app_conversion (
  id            bigint generated always as identity primary key,
  install_id    bigint references attributed_install(id) on delete cascade,
  event_type    text not null check (event_type in
                  ('install','signup','trial_start','subscription','renewal','churn')),
  occurred_at   timestamptz not null,
  revenue_cents integer,
  captured_at   timestamptz not null default now()
);

-- Post-paywall HDYHAU + thumbnail follow-up. The only $0 per-video iOS mechanism.
create table if not exists hdyhau_response (
  id                 bigint generated always as identity primary key,
  user_pseudo_id     text not null,
  placement          text not null check (placement in
                       ('post_paywall','trial_start','onboarding_complete')),
  selected_channel   text,                              -- one option per active channel, "Other" pinned last
  followup_account_id bigint references owned_account(id) on delete set null,
  followup_post_id   bigint references scheduled_post(id) on delete set null,  -- "which video?"
  submitted_at       timestamptz not null default now()
);

-- Apple control total — daily, channel-level, NEVER per-video.
-- Idempotent re-key: newest processing_date wins (§10.3).
create table if not exists apple_analytics_daily (
  report_date     date not null,
  processing_date date not null,
  source_type     text not null,                       -- App referrer | Web referrer | ...
  metric_name     text not null,                       -- installs | product_page_views | ...
  value           numeric not null,                    -- privacy-floored, noise ±2 @68.2%
  loaded_at       timestamptz not null default now(),
  primary key (report_date, processing_date, source_type, metric_name)
);

-- Custom Product Pages: format-level iOS conversion above the privacy floor.
create table if not exists custom_product_page (
  id                bigint generated always as identity primary key,
  cpp_apple_id      text not null unique,
  format_cluster_id integer references format_cluster(id) on delete set null,
  ct_code           text not null unique,              -- base36, <=30 chars
  name              text not null,
  created_at        timestamptz not null default now()
);

-- Format-lift coefficients + incrementality results.
create table if not exists format_lift (
  format_cluster_id integer not null references format_cluster(id) on delete cascade,
  fit_date          date not null,
  k_format          numeric(12,6) not null,            -- installs per view for this format
  lag_days          smallint not null default 1,       -- 1-3 day kernel
  r_squared         numeric(5,4),
  primary key (format_cluster_id, fit_date)
);

create table if not exists incrementality_test (
  id                  bigint generated always as identity primary key,
  method              text not null check (method in
                        ('single_channel_pause','geolift','meridian')),
  channel             text not null,
  account_scope       text,
  started_at          timestamptz not null,
  ended_at            timestamptz,
  baseline_installs   integer,
  observed_installs   integer,
  incremental_installs integer,
  fully_loaded_cost_cents integer,
  computed_cpi_cents  integer,                          -- THE deliverable number
  notes               text
);
```

**No UPDATE-in-place** on `attributed_install`, `app_conversion`, or `apple_analytics_daily` — attribution is a derivative that needs history (§12). Apple corrections arrive as new `processing_date` rows, not overwrites.

---

## Key algorithms & decisions (with the spec's exact thresholds/costs)

- **Android is ground truth; iOS is extrapolated.** Budget **60–75% of organic-social iOS installs as unattributable at video level** (§10.1). iOS is ~77% of new subscription-app launches, so the extrapolation carries real weight — **re-validate the Android→iOS ratio periodically** rather than assuming stability (§10.1).
- **The MMP billing trap (hard guardrail).** Fronting organic TikTok with a per-video MMP link **converts free organic into billable conversions** (§10.2). Kochava free tier covers 10K attributed conversions/mo; do not exceed it casually, and **do not move to Tenjin until you have confirmed in writing that owned-media links bill at all** — its tooltip defines a conversion as one attributed to a *PAID* UA campaign (§10.2).
- **Apple privacy floor** (§10.3): values from **<5 users/devices omitted**; noise such that **68.2% within ±2, 95% within ±4, 99.7% within ±6**. Eight true installs reports as 4–12 at 95% confidence. This is why Apple is a **control total only**, never a per-video ledger. Load idempotently, newest `processing_date` wins; **data for a day is complete two days after** the reporting date.
- **Apple campaign-link tripwires** (§10.3): both `pt` **and** `ct` required or nothing registers; attribution needs a first-time download **within 24h** of click; campaigns surface only after 24h **and ≥5 first-time downloads**; last-touch overwrites; `ct` ≤ 30 alphanumeric chars → base36 + lookup table.
- **AppsFlyer OneLink TTL trap** (if ever used instead of Kochava): default TTL **31 days**, max **730**; a video's useful life is ~35 days to 95% of lifetime views, so default links **404 exactly when the long tail arrives** — set an explicit long TTL, and note API-created links don't appear in the dashboard (your DB is the sole system of record).
- **Cadence constraint (§10.5):** **identification requires ≤1–2 videos/account/day.** Beyond that, regressors collinearise and the model cannot separate which video drove which spike. Cal AI showed a **176× view spread between two accounts of the same brand** (`@calai.track` 311 views/video vs `@cal_ai_` 54,745) — **account-level variance dominates video-level variance**, so *more accounts beats more posts per account*, and that direction is also attribution-friendly. This makes the Phase 3 governor's cadence check a real product decision, not a nicety.
- **Install model (§10.5):** `installs_t = baseline + Σ_v (views_{v,t} × k_format)` with a **1–3 day lag kernel** (~72% of views land day one). Fit `k_format` per `format_cluster`.
- **CPI is computed, never quoted (§10.6):** organic CPI = (fully-loaded content cost) ÷ (incremental installs from a pause test). **No published organic TikTok CPI exists.** For sanity-comparison only: Tier-1 English fitness/health CPI **$2.50–$6.50**, iOS runs **2.0–3.5× Android**; **ignore Business of Apps' $1.75–$4.00 TikTok figure** (2024 projection, Android-above-iOS, contradicts both 2026 sources).
- **Value chain for revenue sizing (§10.6):** `installs × install-to-paid × LTV-per-payer`. 1M organic views → ~750 installs × **2.9%** (H&F install→paid D35) × **$35.64** Year-1 LTV ≈ **$775 Year-1 revenue/million views**. **Do not chain with the D14 RPI $0.48** — different window, double-counts. Largest single lever in the dataset: **hard paywall 10.7% vs freemium 2.1% (5.1×)** — a product decision, but the attribution model must know which regime Goodfor is in.

### ⚠️ Weak-evidence items — verify before modeling money on these

These are the §10 numbers the spec itself flags as soft. Treat as **placeholders to be replaced by Goodfor's own measured data**, never as coefficients you bake into a forecast:

- **Link-in-bio CTR — the weakest number in the entire document** (§10.6): 1–5% of profile visits, **0.1–0.5% of video views**, `[UNVERIFIED, no sample size, uncorroborated]`. The derived ~$6.67 organic-CPI-equivalent rests on it *and* on an asserted $5 CPM. **Compute your own** from a pause test.
- **HDYHAU completion 45–85%** (§10.4): `[VENDOR, no sample size]`. The "MMP 200 vs HDYHAU 350 → 1.75× under-count" is **one documented case**, not a rate. Reliability is high with 1–2 social channels, **low with 5+**.
- **Subscription-funnel benchmarks** (§10.6, RevenueCat) — `[VENDOR, large sample]`: 2.9% install→paid, 37.7% trial→paid, $35.64 LTV. Large sample but still an external benchmark; use to *sanity-check* Goodfor's cohorts, not to *set* them.
- **Retention / completion benchmarks generally** — every published 3-second-retention and Spark-Ads-lift figure is `[REFUTED]` at source (§6.5, §9.3). Regress your **own** retention curves against `hook_type` once installs are flowing; do not import a completion benchmark into a CPI model.
- **Cal AI 176× spread** (§10.5): `[SINGLE-SOURCE]`. Directionally used to justify "more accounts," not as a magnitude to plan capacity against.
- **US divestiture (22 Jan 2026) partitioning** (§14): partition every benchmark **pre/post and US/non-US — never pool.**

---

## External dependencies & monthly cost

| Item | Cost/mo | Notes |
|---|---|---|
| MMP (Kochava free tier) | **$0** | 10K attributed conversions/mo; owned-media + SmartLinks (§10.2) |
| Apple Analytics Reports API | $0 | Included with App Store Connect; needs Admin role for first request |
| Custom Product Pages | $0 | Up to 70; included |
| Incrementality (single-channel pause) | $0 | Manual; GeoLift/Meridian deferred |
| Play Install Referrer | $0 | Library only |
| Attribution worker compute | rolls into existing Fly/Railway line | Separate write-plane process |

Attribution's **direct** monthly cost this phase is **$0** (§13: Attribution column `$0 / $0 / $2,200` — the $2,200 Tenjin line is the *with-creators* future, not now). The **~$700/mo Phase 4 total** in §15 is the *whole system* at this phase (data acquisition still dominates), not an attribution bill. Tenjin at ~$2,200/mo is a later trigger "only when volume demands."

---

## Risks & guardrails

- **Read/write plane bleed (§14 risk 2, High).** The attribution worker holds Goodfor's MMP keys and Apple credentials. It must run in the write-plane cloud account, separate egress, separate secrets from `apps/worker-read`. A scraping complaint must never be able to reach these keys.
- **MMP billing trap (§10.2, Low-Med → becomes Med at scale).** Guard at the client boundary; alert if attributed conversions approach the 10K free-tier ceiling; require written vendor confirmation before any paid-tier migration.
- **Over-posting breaks identification (§14 Medium; §10.5).** >2 videos/account/day collinearises the model. The cadence guard makes this a conscious override with a logged reason.
- **iOS over-claiming.** Never present an iOS per-video number as deterministic. Mark `is_deterministic=false`; label extrapolated iOS distinctly in the dashboard.
- **Apple late corrections.** Any pipeline that treats the first `processing_date` as final will drift. Idempotent re-key is mandatory, not optional.
- **Privacy (system rules + §):** never place a device id, user id, or PII in a URL/query string. `utm_content` carries a **video id only**.
- **Do not architect on Privacy Sandbox** (§10.1) — it is retiring with no end dates.

---

## Acceptance criteria / test plan

1. **Android determinism:** a known test install through a tagged bio link produces exactly one `attributed_install` with `is_deterministic=true` and the correct `utm_content`/`featured_post_id`. Round-trip verified end-to-end from a physical Android device.
2. **Bio rotation correctness:** given a rotation log, an install timestamped inside a rotation window resolves to that window's `featured_post_id`; an install after `rotated_off_at` does not.
3. **Apple idempotency:** re-loading the same report date with a newer `processing_date` overwrites the value; an older `processing_date` is ignored. Primary-key collision count = 0.
4. **Control-total reconciliation:** summed per-video Android installs + extrapolated iOS ≈ Apple App-referrer control total within the privacy-floor noise band (±2 at 68.2%). Large divergence is a bug, not a rounding artifact.
5. **CPP → format mapping:** each `custom_product_page` row resolves to a live `format_cluster`; per-CPP conversion metrics populate above the 5-user floor for the top formats.
6. **Cadence guard:** scheduling a 3rd same-account same-day post triggers the warning and logs the override.
7. **CPI deliverable:** the single-channel pause test yields a populated `incrementality_test` row with a non-null `computed_cpi_cents` and documented methodology. **This is the phase's definition of done** — a defensible organic CPI from an incrementality test, not a benchmark.

---

## Done checklist

- [ ] `packages/attribution` created (`install-referrer`, `apple-control-total`, `ct-codec`, `format-lift`, `cpi`) with unit tests
- [ ] Kochava free-tier client wired, billing-trap guard + ceiling alert in place
- [ ] Migration `20260815000007_attribution.sql` applied (bio-link + rotation, `attributed_install`, `app_conversion`, `hdyhau_response`, `apple_analytics_daily`, `custom_product_page`, `format_lift`, `incrementality_test`), RLS enabled
- [ ] `apps/worker-attribute` running in the **write plane** (isolated creds/egress), separate from `apps/worker-read`
- [ ] Android `installreferrer:2.2` integrated in the Goodfor app; first-launch read → ingest
- [ ] Per-account bio links live with an append-only rotation log
- [ ] Apple Analytics Reports API loading daily, idempotent on `(date, processing_date)`, Admin role provisioned
- [ ] Up to 15 Custom Product Pages provisioned and mapped to `format_cluster`, `ct` base36-encoded
- [ ] HDYHAU post-paywall survey + thumbnail follow-up shipped in the iOS app (post-conversion placement, "Other" pinned last)
- [ ] Cadence guard added to the Phase 3 governor (≤1–2 videos/account/day, logged overrides)
- [ ] Dashboard pages: `attribution/`, `formats-conversion/`, `control-total/`, `incrementality/`
- [ ] One single-channel pause test completed → `computed_cpi_cents` populated with documented methodology
- [ ] Every weak-evidence number (link-in-bio CTR, HDYHAU completion, funnel benchmarks, retention/Spark lift) tagged in-code/in-dashboard as "replace with own measurement"; benchmarks partitioned US/non-US and pre/post 22 Jan 2026
