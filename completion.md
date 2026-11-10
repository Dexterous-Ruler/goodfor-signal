# Goodfor TikTok Machine — Technical Build Spec

**Version 1.0 · 6 August 2026**
Research basis: 131 research agents, ~2,500 tool calls, adversarial fact-checking on every load-bearing number. Load-bearing TikTok platform claims were re-verified first-hand against TikTok's own documentation.

---

## How to read this document

Every factual claim carries a confidence marker:

| Marker | Meaning |
|---|---|
| **[VERIFIED]** | Retrieved from the primary source and independently reconfirmed. Build on it. |
| **[SINGLE-SOURCE]** | Primary source, one retrieval path only. Probably right; re-check before it becomes load-bearing. |
| **[VENDOR]** | A vendor's own claim about its product. Authoritative for prices, worthless for reliability or legality. |
| **[UNVERIFIED]** | Circulating widely, no traceable source. Do not put money or schedule behind it. |
| **[REFUTED]** | Commonly repeated and demonstrably wrong. Listed so nobody re-introduces it. |

A section-by-section source and verification appendix is at the end. **Section 14 is the risk register — read it before approving budget.**

---

## 1. Executive summary

### 1.1 The one thing that determines the entire architecture

**TikTok provides no official, legal way for Goodfor to read competitor data.** This is not a limitation to work around; it is the fact the system is designed on top of.

The Research API is the only official surface that exposes keyword search, hashtag search, and arbitrary third-party video and profile data. TikTok's own FAQ answers the eligibility question directly **[VERIFIED]**:

> "I am a creator, advertiser, or commercial user. Am I eligible for access to the Research Tools? **No.**"

The Research Tools Terms of Service independently bar using the data "for any commercial or unauthorized purpose" **[VERIFIED]**. There is no application to make, no partnership to negotiate, and no university arrangement that helps — approved data may not be used commercially. A 2025 EU development (the DSA Article 40 delegated act, in force 29 October 2025) widens access only to researchers vetted as independent of commercial interests, which cuts further against eligibility, not toward it.

Everything else official is own-account-only. The Display API returns data solely for accounts that have OAuth-authorised your app **[VERIFIED]**. The Business Account API serves only the authorised business account.

**Consequence:** every competitor-intelligence, keyword-tracking, and trend-detection feature in this spec runs on purchased third-party data. That carries contractual risk with TikTok (Section 11), which must be consciously accepted, priced, and isolated — not discovered later.

### 1.2 The second structural fact: the product you described is a prohibited app category

TikTok's Content Sharing Guidelines list, verbatim, under applications that are **not acceptable** **[VERIFIED]**:

> "A utility tool to help upload contents to the account(s) you or your team manages."

That is a precise description of an internal multi-account scheduler. Applying for a Content Posting audit while describing the product honestly invites rejection. Section 8 sets out the three legitimate ways around this; the recommended path uses TikTok's draft/inbox flow, which is not audit-gated for public posts.

### 1.3 The cardinal architectural rule

**The read side and the write side must never share infrastructure, credentials, IP space, or TikTok accounts.**

- **Read side** — competitor data, keywords, hashtags. Third-party vendors, logged-out, on separate infrastructure, under a separate legal entity if counsel advises. Carries contract risk.
- **Write side** — Goodfor's own accounts, OAuth-authenticated, clean, auditable.

If these touch, a data-vendor dispute or a scraping complaint can take down publishing, and scraping activity could jeopardise the authenticated API client itself. Physically separating them is the single highest-value risk control in the build, and it costs almost nothing to do at the start and a great deal to retrofit.

### 1.4 What to build, in order

| Phase | Weeks | Deliverable | Monthly run cost |
|---|---|---|---|
| **0 — Foundations** | 1–2 | Vendor bake-off, legal sign-off, TikTok app registration, Accounts API form | ~$250 |
| **1 — See** | 3–6 | Competitor ingestion, metric time series, outperformance scoring, alerting | ~$400 |
| **2 — Understand** | 7–10 | ASR, multimodal analysis, format clustering, hook taxonomy | ~$500 |
| **3 — Act** | 11–14 | Brief generation, draft/inbox publishing, scheduling, account-health monitoring | ~$600 |
| **4 — Attribute** | 15–18 | Per-video link attribution, Android ground truth, HDYHAU, incrementality | ~$700 |
| **5 — Scale creators** | 19–24 | Creator CRM, sourcing pipeline, rights and payments | ~$2,000 |

Steady state, everything running: **~$1,300–$2,600/month** excluding creator payments and headcount (Section 13).

### 1.5 The five decisions that need a human right now

1. **Accept or reject third-party data risk.** Without it there is no competitor product. Needs named legal sign-off, not an engineering assumption.
2. **Publishing path** — draft/inbox (recommended), third-party audited vendor, or own audit attempt. Determines weeks 11–14.
3. **Account estate model.** Business accounts get programmatic publishing and ads but are restricted to the Commercial Music Library; Creator accounts get trending sounds but no API publishing. You cannot have both on one account (Section 7.3).
4. **Attribution ambition.** Android gives per-video ground truth for free; iOS gives essentially nothing. Decide whether to pay an MMP (Section 10).
5. **Posting cadence cap.** 1–2 videos per account per day is an attribution constraint, not an editorial one (Section 10.5). If growth wants more, attribution gets weaker. That is a real trade-off, not a technicality.

---

## 2. Hard platform constraints

Everything in this section was verified against TikTok's own documentation. TikTok's domains block automated fetchers, so retrieval used the `r.jina.ai` text-extraction proxy; the load-bearing quotes were confirmed through more than one path.

### 2.1 Official API capability matrix

| API | Own data | Competitor data | Keyword/hashtag search | Publishing | Open to Goodfor? |
|---|---|---|---|---|---|
| Display API | Yes | **No** | No | No | Yes |
| Content Posting API | — | No | No | **Yes** | Yes, audit-gated |
| Business Account API | Yes (rich) | No | No | Yes | Yes, form required |
| Research API | Yes | **Yes** | **Yes** | No | **No — commercial users ineligible** |
| Commercial Content API | — | Ads only | 50-char terms | No | Research-gated |
| TikTok One (ex-TTCM) | — | Creator data | No | No | Assume no |

The one API that does what the brief asks for is the one Goodfor cannot have. That is the whole story of this build.

### 2.2 Rate limits **[VERIFIED]**

| Endpoint | Limit | Notes |
|---|---|---|
| `/v2/user/info/` | 600 req/min | One-minute **sliding** window |
| `/v2/video/query/` | 600 req/min | Max 20 video IDs per request |
| `/v2/video/list/` | 600 req/min | `max_count` default 10, max 20 |
| `/v2/post/publish/video/init/` | 6 req/min **per user token** | |
| `/v2/post/publish/content/init/` | 6 req/min per user token | Photo/carousel |
| `/v2/post/publish/inbox/video/init/` | 6 req/min per user token | Draft flow |
| `/v2/post/publish/creator_info/query/` | 20 req/min per user token | |
| `/v2/post/publish/status/fetch/` | 30 req/min per user token | |
| Business Accounts API | 40 QPM per account; **600 QPM global at Basic** | The global ceiling binds first |

Two engineering consequences:

- **The 600/min is per `client_key`, shared across all your workers.** The token bucket must be centralised in Redis, not per-process.
- **The window slides.** A scheduler that fires 600 requests at 11:59:59 and 600 more at 12:00:00 will be throttled, because the trailing 60 seconds is recomputed on every request. Smooth, don't batch at boundaries.

Over-limit returns HTTP 429 with error code `rate_limit_exceeded`.

**No Display API daily quota is published anywhere.** `/doc/rate-limits` returns 404. Vendor blogs quoting Display API daily caps could not be traced to any official page. Instrument the observed ceiling in staging rather than hardcoding a guess.

### 2.3 The publishing audit gate **[VERIFIED]**

Until the API client passes TikTok's Content Posting audit:

> "Unaudited API Clients can only post contents in `SELF_ONLY` viewership."
> "All user accounts using the API client to post must be set to private at the time of posting."
> "Unaudited API Clients can allow up to 5 users to post in a 24 hour window."

Multi-account public publishing is therefore **blocked outright pre-audit, not throttled**.

**One widely-repeated claim is wrong, and it matters.** An experienced integrator asserts that pre-audit posts can never be made public. TikTok's own documentation contradicts this **[VERIFIED]**:

> "the account owner must first change their account visibility to public, and then change the privacy settings of each content to 'Everyone.'"

So the audit window is not dead time. Content produced during it is recoverable through a manual, per-post step.

**A trap that will cost you a production incident:** `creator_info/query` still returns `PUBLIC_TO_EVERYONE` in `privacy_level_options`, and every call returns success, while the post is silently coerced to private **[SINGLE-SOURCE, third-party error catalogue — confirm in sandbox]**. The integration will appear to work in development and fail invisibly in production. Verify actual post visibility out-of-band before trusting a 200.

### 2.4 Posting caps

| Claim | Status |
|---|---|
| "typically around 15 posts per day / creator account", "shared across all API Clients using Direct Post" | **[SINGLE-SOURCE]** TikTok Content Sharing Guidelines. Soft guidance — "may vary among creators" |
| "15–25 videos/account/day, varies by tier" | **[REFUTED]** No TikTok document states 25. Vendor-only. Design against 15 |
| Per-client 24-hour active-creator cap | **[VERIFIED]** exists; set from the usage estimates *you supply in the audit application form* |
| Max 5 pending API shares per user per 24h | **[SINGLE-SOURCE]** error `spam_risk_too_many_pending_share` |

TikTok documents only the error codes, never the numbers: `spam_risk_too_many_posts` ("The daily post cap from the API is reached for the current user") and `reached_active_user_cap` ("The daily quota for active publishing users from your client is reached") **[VERIFIED]**.

**Design rule: back off on those two error codes. Never hardcode a daily constant.** And because the per-client cap derives from your own audit-form estimates, size those estimates deliberately before submitting — that number becomes your production ceiling.

### 2.5 Media and content constraints **[VERIFIED]**

| Constraint | Value |
|---|---|
| Max video file size | **4 GB** (not 10 GB — that figure is vendor error) |
| Max video duration | 10 minutes; per-creator limit in `max_video_post_duration_sec` may be lower |
| Min resolution | **360 px** both dimensions (not 540×960); max 4096 px |
| Frame rate | 23–60 fps |
| Chunking | 5 MB min, 64 MB max; final chunk up to 128 MB; 1–1000 chunks |
| Video caption (`title`) | **2,200 UTF-16 runes** |
| Photo `title` / `description` | 90 / 4,000 UTF-16 runes |
| Photo posts | **`PULL_FROM_URL` only** — no chunked upload path. Max 35 images |
| `upload_url` TTL | **1 hour** from issuance |
| `privacy_level` enum | `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY` |

Three things that will bite:

- **Caption length is UTF-16 code units.** JavaScript `String.length` is correct. Python `len()` (code points) and Go `len()` (bytes) both miscount emoji against the 90-rune photo title.
- **No account ever gets all four privacy levels.** Public accounts get `PUBLIC_TO_EVERYONE` / `MUTUAL_FOLLOW_FRIENDS` / `SELF_ONLY`; private accounts get `FOLLOWER_OF_CREATOR` / `MUTUAL_FOLLOW_FRIENDS` / `SELF_ONLY`. Render only what `privacy_level_options` returns or you get `privacy_level_option_mismatch`.
- **`upload_url` lives one hour.** Issue it at publish time, never at schedule time. A 4 GB upload inside that window needs ~9.1 Mbit/s sustained — re-init when *projected* completion exceeds the TTL rather than waiting for expiry.

### 2.6 OAuth **[VERIFIED]**

| Item | Value |
|---|---|
| `access_token` | 24 hours (`expires_in = 86400`) |
| `refresh_token` | 365 days (`refresh_expires_in = 31536000`) |
| Rotation | Mandatory — "You must use the newly-returned token if the value is different" |
| Endpoints | `POST /v2/oauth/token/`, `POST /v2/oauth/revoke/` |

**The 365 days runs from initial issuance, not last refresh.** Refreshing does not extend the horizon. Compute the re-authorisation prompt from the *original grant timestamp* — a system that computes it from the latest `refresh_expires_in` will silently believe it has a year of runway forever, then lose every account on the same day.

**Refresh-token rotation creates a race.** Two concurrent refreshes for the same account, and one loses its token permanently. Required design: a Postgres advisory lock (`pg_advisory_xact_lock(hashtext(open_id))`) held across the refresh HTTP call; refresh proactively at T−6h on a cron rather than lazily on 401; retain the previous refresh token for one generation so a crashed refresh can be retried.

### 2.7 Dated changes you must not miss

| Date | Change |
|---|---|
| **30 Jun 2025** | TikTok Creator Marketplace endpoints discontinued; migrated to TikTok One (TTO) |
| **13 Sep 2025** | Current For You Feed Eligibility Standards took effect |
| **26 Sep 2025** | TTO API rate-limit tiers introduced (Basic = **50 queries/day**) |
| **1 Dec 2025** | TikTok Terms of Service last updated — the version governing scraping |
| **22 Jan 2026** | US joint venture closed (Section 6.4) |
| **20 Mar 2026** | **Accounts API Access Application Form became mandatory** before app submission |
| **31 Aug 2026** | New TikTok Branded Content Policy takes effect — **25 days away** |

The 20 March 2026 form is a blocking prerequisite sequential to app submission. **Start it in week 1.** The 31 August Branded Content Policy lands during Phase 3 and changes disclosure requirements mid-build.

---

## 3. System architecture

### 3.1 Component map

```
┌─────────────────── READ PLANE (isolated) ───────────────────┐
│                                                              │
│  Vendor APIs ──► Ingestion ──► Metric time series ──► Scoring │
│  (EnsembleData,   (poll         (Postgres/          (robust   │
│   ScrapeCreators)  scheduler)    Timescale)          z-score) │
│                                        │                  │   │
│                                        ▼                  ▼   │
│                              Content analysis ──► Alert queue │
│                              (ASR → vision →                  │
│                               embed → cluster)                │
└──────────────────────────────┬───────────────────────────────┘
                               │  briefs only — never assets
┌──────────────────────────────▼─── WRITE PLANE (clean) ───────┐
│                                                               │
│  Brief ──► Production ──► Compliance gate ──► Publish ──► TikTok│
│                            (disclosure,       (draft/inbox     │
│                             sound, rights)     or vendor)      │
│                                                        │      │
│  Creator CRM ──────────────────────────────────────────┤      │
│                                                        ▼      │
│  Attribution ◄── Business API ◄── own-account metrics         │
└───────────────────────────────────────────────────────────────┘
```

The dashed boundary is a hard one: separate cloud accounts, separate egress IPs, separate credentials. Data crosses it as **briefs and structured findings only — never as competitor video files, audio, or verbatim text.**

### 3.2 Stack recommendation

| Layer | Choice | Why | Cost/mo |
|---|---|---|---|
| Primary DB | **Postgres 16 on Supabase** | Storage is a rounding error at this volume; the compute floor is the real cost, and Postgres has the lowest | $25–70 |
| Time series | **Native monthly range partitions** | Supabase does not offer TimescaleDB (verified 15 Aug 2026 against the live project — `pg_available_extensions` has no `timescaledb`). Declarative partitioning gives the same pruning and O(1) retention drops with no extension dependency | included |
| Vectors | **pgvector, `halfvec`, HNSW** | Same database; 7–9 GB at 1M vectors vs 15–24 GB float32 | included |
| Queue | **Cloudflare Queues** or BullMQ+Redis | $7/mo vs $531 for durable-execution platforms at this volume | $7–20 |
| Scheduler | `due_at` column + 60s tick | Not one cron per video | — |
| Workers | Node/TypeScript on Fly or Railway | Matches the rest of the stack | $80 |
| Dashboard | **Next.js + Recharts** | The alerting UX is bespoke; Retool at $225–475/mo buys the wrong thing | $0–80 |
| Publishing | **Postiz self-hosted** (AGPL-3.0) | 34,322 stars, last push 6 Aug 2026, Next.js+Redis | $15 |

**Do not use ClickHouse.** The benchmark usually cited to justify it (ClickBench) runs 43 queries over 99,997,497 rows — roughly 70× Goodfor's entire annual snapshot volume **[VERIFIED]**. Goodfor generates ~25.2M rows/year and the hot query touches at most 14.4M. ClickHouse Cloud Basic starts at **$66.52/month** and Scale at **$499.38/month** **[VERIFIED]**, against essentially the same storage cost. ClickHouse's own "1000× faster" and "50% disk reduction" marketing claims carry no compression ratios, no absolute latencies, and no dataset sizes — treat as vendor assertion, not benchmark.

**Do not use Temporal or Inngest for polling.** At 2.07M polls/month, Temporal Cloud costs ~$531/month (12.4M actions at tiered rates, less the 1M included in the $100 Essentials plan) and Inngest blows through its 1M-execution Pro tier 8–12× over **[VERIFIED rate cards]**. Cloudflare Queues costs ~$7. Durable execution is the right tool for the *publishing* workflow, where each execution is valuable and correctness matters; it is the wrong tool for high-volume low-value polling.

### 3.3 Open source worth borrowing **[VERIFIED via GitHub API, 6 Aug 2026]**

| Repo | Stars | Licence | Last push | Use |
|---|---|---|---|---|
| `gitroomhq/postiz-app` | 34,322 | AGPL-3.0 | 2026-08-06 | Publishing backbone |
| `davidteather/TikTok-Api` | 6,543 | **MIT** | 2026-07-03 | Only high-star option safely vendorable into closed source |
| `inovector/mixpost` | 3,490 | MIT | 2026-03-16 | PHP/Laravel alternative to Postiz |
| `facebook/ThreatExchange` (vpdq) | — | BSD | active | Video near-duplicate detection |
| `facebookincubator/GeoLift` | — | MIT | active | Incrementality testing |
| `tiktok/tiktok-research-api-wrapper` | **32** | MIT | **2024-12-04** | TikTok's own wrapper — no commits in 20 months |

That last row is worth pausing on. TikTok's official research toolkit has 32 stars and has been untouched for 20 months. It tells you how much institutional weight sits behind the research programme, and reinforces that planning around Research API access — even hypothetically — is unwise.

**AGPL-3.0 warning on Postiz:** network copyleft. Running unmodified Postiz as an internal backend for Goodfor employees is fine. Forking it into anything customer-facing obliges you to release your modifications. If that is a possibility, use Mixpost (MIT) instead and accept the staler PHP stack.

---

## 4. Data acquisition

### 4.1 Vendor selection

Prices verified 6 August 2026 against live rate cards.

**Primary: EnsembleData** — flat monthly tiers with **daily** unit allowances **[VERIFIED]**:

| Tier | Units/day | Price |
|---|---|---|
| Free trial | 50 | $0 |
| Wood | 1,500 | $100/mo |
| **Bronze** | **5,000** | **$200/mo** |
| Silver | 11,000 | $400/mo |
| Gold | 25,000 | $800/mo |
| Platinum | 50,000 | $1,400/mo |

Per-endpoint unit costs **[VERIFIED, all 20 rows]**: Hashtag Search 1 · Keyword Search 1 · Full Keyword Search `#posts/20` · User Posts From Username `1 + depth` · **User Posts From Secuid `depth`** · User Info 1 · **Post Info 2** · Multiple Post Info `2 × #posts` · Post Comments 1 · Music Search 2 · Music Posts 1 · User Followers 2 · User Detailed Info 10.

Units reset at 00:00 UTC; failed requests caused by internal errors are not charged; error `495 All daily units used` is the real backpressure boundary. Whether units roll over is **[UNVERIFIED]** — inferred from the reset language, not published. Confirm in writing before committing to a burst-shaped ingestion design.

**Failover: ScrapeCreators** — $47 for 25,000 non-expiring credits ($1.88/1k), 1 credit per *request* not per record **[VERIFIED]**. Non-expiring credits mean the failover has effectively zero carrying cost. Note its own documented data-quality caveat: "TikTok can return duplicate results for this search" — **dedupe on video ID, never trust cursor ordering.**

**Do not put Apify on the hot path.** Its flagship `clockworks/tiktok-scraper` is capable — hashtag, keyword, profile, and URL inputs, date filters, min/max likes, Latest/Oldest/Popular sorting **[VERIFIED from the actor's input schema]** — but pay-per-event pricing runs $1.70–$3.70 per 1,000 results depending on plan tier, add-ons stack on top, and actor-start latency is unsuitable for 15-minute polling. Its one genuinely valuable contribution is the only empirical reliability figure in the entire vendor landscape: **93.32% success across 11,241,771 runs in 30 days** — a 6.68% failure rate, roughly 1 in 15 **[VERIFIED via Apify's public API]**. Size your retry layer to that.

**Excluded and why:** Exolyt — no API at any tier, unusable as a data source despite good UI. Kalodata — TikTok Shop commerce only, irrelevant to an app. Trendpop — defunct, domain 301s to collab.inc. Shortimize — 12-hour refresh floor cannot serve "replicate within hours". Bright Data — batch drop to S3/GCS, wrong shape for hourly polling, though its $250 minimum-order dataset is worth one purchase for historical backfill.

**Never build on the TikTok Creative Center internal API.** The `creative_radar_api` route returns `{"code":40101,"msg":"no permission"}` with an attributable `request_id` on every response **[VERIFIED]**. It is live but requires signed headers. Reverse-engineering that signature is an unambiguous Business ToS breach with a per-request audit trail pointing at you. Manual qualitative cross-checks in the browser only, never on a cron.

### 4.2 The decision that quadruples or quarters your data bill

The dominant cost is **not** competitor account polling. It is repeated per-video metric snapshots.

- `Multiple Post Info` costs `2 × #posts`. Tracking 2,000 videos twice daily = **8,000 units/day** → forces Gold at **$800/month**.
- Profile-listing polls **already return** play, digg, comment and share counts for every video in the listing, at zero additional unit cost.

**Derive per-video time series from the listing payloads.** Store the full listing response per poll and diff it. At 50 accounts × 30 videos × 6 polls/day this yields **9,000 metric samples/day for free**, and the whole workload lands at ~1,400 units/day — comfortably inside Bronze at $200.

That is a **$200 vs $800 per month decision made entirely in the ingestion schema**, and it is the single most consequential engineering choice in the data layer. It constrains the design: you must persist raw listing payloads and diff them, not issue per-video calls.

Secondary saving: `User Posts From Secuid` costs `depth` versus `1 + depth` for the username variant. Cache each competitor's `secUid` at onboarding and poll by secUid — saves exactly 300 units/day at 50 accounts × 6 polls, or 6.0% of Bronze, for zero engineering cost after the first call.

### 4.3 Poll scheduler

Age-adaptive tiering, because a two-hour-old video and a two-week-old video need completely different cadences:

| Video age | Interval |
|---|---|
| < 1 hour | 5 min |
| 1–6 hours | 15 min |
| 6–24 hours | 30 min |
| 1–3 days | 2 hours |
| 3–7 days | 6 hours |
| 7–30 days | 24 hours |
| > 30 days | 7 days, or evict |

**Velocity override:** promote one tier when Δviews in the last window exceeds 3× Δviews in the prior window; demote one tier after two consecutive polls with Δviews/views < 0.005. Cap promotions at the 5-minute floor.

**Scheduler shape:** do not create one cron per video. Use a single `due_at timestamptz` column with a partial index (`CREATE INDEX ON tracked_video (due_at) WHERE tracking_active`) and one tick job every 60 seconds selecting due rows with a `LIMIT` window.

> **Arithmetic caveat.** The research derived ~69,000 polls/day for 5,000 tracked videos, but that derivation does not reconcile with its own tier table (the hot-cohort figure implies a cadence the table does not produce). Since every downstream cost estimate depends on it, **instrument the real poll count in week 1 of Phase 1 rather than budgeting from it.** The directional point survives: halving the hot and warm tier cadences roughly halves the data bill, and that is the largest single cost dial in the system.

### 4.4 Ingestion control plane

- **Token bucket in Redis Lua** (atomic across workers). Rate 10/sec from the verified 600/min; capacity 300 rather than 600, so a cold-start burst cannot consume the whole window and starve the publishing path. One bucket per `client_key`, a second per data vendor.
- **Retry with AWS full jitter**: `sleep = uniform_random(0, min(300s, 1s × 2^attempt))`, max 6 attempts. Full jitter beats equal-jitter and plain exponential under contention because it decorrelates retry storms. Honour `Retry-After` as a floor.
- **Circuit breaker** after 5 consecutive 429/5xx from a vendor; fail over to ScrapeCreators.
- **Backpressure**: bound the ready queue. When overdue polls back up, drop from the *cool* tier, never the hot tier. A three-day-old video missing a daily snapshot costs nothing; a viral video missing its 15-minute snapshot costs the entire product.
- **Idempotency**: floor the timestamp to the slot and `INSERT ... ON CONFLICT (video_id, ts) DO NOTHING`. Queue redelivery inside the same slot becomes a no-op, so at-least-once delivery is sufficient and no dedupe table is needed.

### 4.5 Before committing: run a vendor bake-off

No third-party benchmark exists comparing TikTok data vendors, and **outperformance detection depends entirely on absolute view-count accuracy**. Two vendors disagreeing by 10% on the same video makes every z-score wrong.

Push the same 100 videos through EnsembleData, ScrapeCreators and Apify within the same hour. Measure disagreement on view/like/comment/share counts, and measure freshness lag against a manually-checked ground truth. **Do this in Phase 0, before the ingestion schema is fixed.** No vendor publishes p50/p95 latency, data-recency guarantees, or uptime history; "no rate limits" from both EnsembleData and ScrapeCreators are self-assertions on a docs page.

---

## 5. Outperformance and trend detection

### 5.1 No vendor publishes their formula

vidIQ, ViewStats, 1of10, Shortimize, Exolyt and Kalodata all publish concepts and thresholds, never maths **[VERIFIED]**. Goodfor must define its own. What is knowable:

| Tool | Baseline statistic | Window | Thresholds |
|---|---|---|---|
| vidIQ | **mean** | "within a similar timeframe" (unspecified) | 2× / 5× / 10× |
| 1of10 | **median** | not stated | displayed multiplier |
| Shortimize | **median** | not stated | **2× median** flags a potential viral hit |
| OverseerOS | formula says mean, prose prefers median | last 20–50 videos | 1.2× / 3× / **8×** / 25× |
| ViewStats | "previous 9 uploads" | 9 videos | **[UNVERIFIED]** — 403 on every retrieval path |

The mean-based approach (vidIQ) has a fatal flaw for this use case: **masking**. An account that posts several viral videos in a row inflates its own mean and standard deviation until nothing registers as an outlier — precisely the account you most want alerts on. Use median.

### 5.2 The scoring formula

**Age-matched robust z-score in log space.** Comparing raw view counts across accounts is the mistake that makes these systems useless.

For video *i* in cohort *c* (cohort = creator account, optionally × content format), let `V_i(a)` be the view count at age *a* hours, obtained by linear interpolation of the two snapshots bracketing *a* onto a fixed age grid `a ∈ {1, 2, 3, 6, 12, 24, 48, 72, 168}`.

Baseline set: `B_c(a) = { log(V_j(a)+1) : j ∈ trailing N videos of cohort c, j ≠ i }`, with **N = 30** (50 for high-volume accounts). **Refuse to score when |B_c(a)| < 8.**

```
z_i(a) = 0.6745 × ( log(V_i(a)+1) − median(B_c(a)) ) / MAD(B_c(a))

where MAD = median(|x − median(x)|)
```

> **Correction to a common gloss.** 0.6745 is **not** "the constant making MAD a consistent estimator of σ" — that constant is 1.4826. 0.6745 = Φ⁻¹(0.75), and the two forms are equivalent: `0.6745 × (x − median)/MAD ≡ (x − median)/(1.4826 × MAD)`. Getting this backwards in code inverts the scale by a factor of ~4.9.

Fall back to classical z when MAD = 0. Flag at |z| > 3.5, the Iglewicz–Hoaglin threshold **[VERIFIED]**.

**Why log space:** TikTok view distributions are heavy-tailed. Negative-binomial beat Poisson on YouTube view counts by an AIC gap of 1,205 vs 2,761,005 **[VERIFIED, though the source is a health-psychology teaching tutorial using one dataset — establishes NB2 > Poisson on *that* data, not as a universal law]**. More seriously, fitted Pareto tail exponents on 16.2M YouTube videos ranged α ∈ [0.50, 4.36], significant in 52 of 59 fits — **α < 1 implies infinite mean**, so any design assuming a stable average will misbehave on the heaviest-tailed segments.

**Velocity and acceleration:**
```
v_i(t) = (V_i(t₂) − V_i(t₁)) / (t₂ − t₁)          views/hour
α_i(t) = (v_i(t₂) − v_i(t₁)) / (t₂ − t₁)
```

**Alert rule** tuned for "replicate within hours":
```
FIRE when  z_i(a) ≥ 2.5
      AND  a ≤ 12 hours
      AND  V_i(a) ≥ 10,000          (noise floor)
      AND  α_i > 0                   (still accelerating, not already peaked)
```
At 15-minute hot-tier cadence, worst-case detection latency is 15 minutes plus queue lag.

**Cold start:** shrink an account's observed median toward a tier prior using empirical-Bayes weight `w = n/(n+k)`, n = videos observed, k ≈ 5–10. Tier priors from Socialinsider (2M videos, 214,507 profiles) **[VENDOR, averages not medians]**: 1–5K followers → 350 avg views; 5–10K → 945; 10–50K → 3,240; 50–100K → 9,900; 100K–1M → 34,900. Publish no score before 3 same-age observations; emit a confidence band instead.

**Ship two numbers per video:** the human-facing multiplier (× median) and the modified z-score. 5× means very different things for a low-variance account and a high-variance one, and only the z-score knows the difference.

**Pick one threshold convention.** The two circulating sets (2/3/5/10 and 1.2/3/8/25) share exactly one cutpoint. Ship Convention A (2× noteworthy, 3× significant, 5× viral candidate, 10× exceptional) and expose the other as a config preset. Inheriting both produces incoherent UI.

### 5.3 Trend detection on keywords, hashtags and sounds

- **Rising vs saturated** via the velocity/acceleration sign pair: `v>0, α>0` = rising, act. `v>0, α<0` = past inflection, act only if shippable within hours. `v<0, α<0` = decaying, ignore. `v<0, α>0` = bottoming, watch.
- **Sub-daily bursts:** Twitter's S-H-ESD (STL decomposition then Generalized ESD on median+MAD). Reference defaults `max_anoms=0.1, alpha=0.05, direction="pos"`; use `only_last="hr"` for near-real-time and `period=24` on hourly view-delta buckets, or 168 buckets for hour-of-week.
- **Daily volume:** Prophet with `interval_width` raised from 0.80 to 0.95, `seasonality_mode='multiplicative'`, 25 changepoints in the first 80% of the series.
- **Ranking competing rising hashtags:** Kleinberg burst detection (`s=2, gamma=1`), using **burst weight** — the reduction in fit cost during the burst versus baseline state — as the rank score.
- **Breakout labelling:** mirror Google Trends, which defines Breakout as growth **> 5,000%** versus the prior equal-length period **[VERIFIED — the only officially documented breakout threshold in this space]**. Above a fixed multiple, print "Breakout" rather than an absurd number. Enforce a minimum-volume floor so 2→120 posts cannot outrank 40,000→900,000.

**Honest limitation:** no peer-reviewed 2025/2026 study models TikTok view velocity as a virality predictor with quantified accuracy. The best available prior work is Szabó–Huberman (2008, YouTube/Digg — first two hours predict 30 days on Digg; YouTube needs 10 days) and Althoff et al. (2013, MAPE 45–19% at 14-day horizons using nearest-neighbour matching against historical curves). Qualitative conclusions transfer; **time constants do not.** Calibrate on Goodfor's own data.

One current datapoint that helps: TikTok posts reach **96% of total reach and ~98% of interactions within 10 days**, and the For You feed drives **72.70%** of views **[VENDOR — Metricool, 2,314,756 posts, 92,000+ accounts, published 12 May 2026]**.

### 5.4 Engagement rate — store both denominators

The two conventions differ by roughly 1.6× in the same year and are routinely conflated:

| Denominator | 2026 figure | Source |
|---|---|---|
| By views | median **4.20%** (Q2 dipped to 3.85%) | Socialinsider, 2M videos |
| By followers | **2.60%** average, −10% YoY | Socialinsider |
| By followers, by tier | nano 7.84% → mega 1.84% | SociaVault, 150,000 accounts |

**By-views is correct for TikTok** — the For You feed drives 72.70% of views, so followers are the wrong denominator. But influencer negotiation runs on by-follower. **Store `er_views` and `er_followers` as separate columns and label every chart with its denominator.** Never mix them in one leaderboard.

Also stamp the view definition: a TikTok view is counted after roughly **1 second** of playback (~3 seconds for videos ≥3 minutes) **[UNVERIFIED — consensus of secondary sources; TikTok blocks retrieval]**. That makes a TikTok view nearly an impression, so TikTok ER-by-views is structurally lower than Instagram's or YouTube's and cross-platform comparison without stating the view definition is meaningless.

---

## 6. Content intelligence

### 6.1 Pipeline

```
video ──► ffmpeg (audio extract + keyframes) ──┬──► Groq Whisper ──► transcript + word timestamps
                                                └──► Gemini (native video) ──► structured analysis
                                                                                      │
transcript ──► text embedding ──► pgvector ──► UMAP ──► HDBSCAN ──► LLM cluster labels
                                                                          │
                                                              format taxonomy + hook classification
```

### 6.2 ASR — Groq, decisively

| Provider | Price per audio-hour |
|---|---|
| **Groq `whisper-large-v3-turbo`** | **$0.04** |
| Groq `whisper-large-v3` | $0.111 |
| OpenAI `gpt-4o-mini-transcribe` | $0.18 |
| OpenAI Whisper / `gpt-4o-transcribe` | $0.36 |
| AssemblyAI Universal-2 async | $0.15 |
| Deepgram Nova-3 mono pre-recorded | $0.462 |

Groq turbo is exactly **9.0× cheaper than OpenAI Whisper**. At 500 videos/day × 30s = 4.17 audio-hours/day, that is **$5.00/month**. Rate headroom is three orders of magnitude (400,000 audio-seconds/hour available vs 15,000 needed) — no rate-limit engineering required.

Two hard constraints **[VERIFIED]**: minimum billed length is **10 seconds** (a 3-second hook clip pays a 3.3× markup — batch hook audio into the full-clip call), and the 100 MB file cap is **Dev tier only; free tier caps at 25 MB**.

Use `response_format=verbose_json` for word timestamps, which is what lets you split the t<3.0s hook.

**Do not self-host.** One RTX 4090 GPU-hour ($0.34 Community on RunPod) beats two days of Groq ($0.333) by 2%. The published break-even figures are internally inconsistent by a factor of 4, and the throughput benchmarks underpinning them come from SEO content farms with no methodology. Keep a `faster-whisper` container behind the same interface purely as a 429 circuit-breaker.

**Correction applied:** earlier research read Deepgram's pricing table through a proxy that misaligned columns and inverted streaming vs pre-recorded. Two independent direct fetches confirm Nova-3 mono PAYG is **streaming $0.0048/min, pre-recorded $0.0077/min** — making batch Deepgram 11.6× Groq, not 3–5×.

### 6.3 Vision — Gemini only

Among OpenAI, Anthropic and Google, **only Google accepts native video input** (Amazon Nova and Qwen-VL also do, outside those three). Claude accepts JPEG/PNG/GIF/WebP only, and for animations "only the first frame is used" **[VERIFIED]**.

Gemini video token mechanics **[VERIFIED]**: stored at 1 FPS, audio at 1 Kbps mono; **258 tokens/frame** at default media resolution on Gemini 2.5, **66** at low; **32 tokens per second of audio**. A 30-second TikTok on Gemini 2.5 default = 7,740 video + 960 audio = **8,700 tokens**.

**Bill audio tokens on the audio line, not the video line.** They are priced differently ($1.00/M vs $0.30/M on 2.5 Flash), and conflating them understates cost by 22–26%.

| Config | Per video | 500/day | Per month |
|---|---|---|---|
| Gemini 2.5 Flash, default | $0.00453 | $2.27 | **$68** |
| Gemini 2.5 Flash-Lite, default | $0.00126 | $0.63 | **$19** |
| Gemini 3.1 Flash-Lite, default | $0.00176 | $0.88 | $26 |
| Claude Opus 5, 8 native frames | $0.1076 | $53.82 | **~$1,615** |
| TwelveLabs Marengo embedding | $0.021 | $10.50 | $315 + growing library fee |

**A correction that inverts a recommendation.** Gemini 3 already defaults video to **70 tokens/frame** — the low-equivalent. Setting `media_resolution_low` for video on Gemini 3 saves **nothing**. Worse, the commonly suggested "hybrid" of sending 12 hook frames at `media_resolution_high` raises those frames from 70 to 280 tokens each, making it a **2.1× cost increase**, not an optimisation. It may still be worth it for hook-text fidelity — but book it as deliberate spend. Also: low and medium are identical for video (70 each), so **never select medium for video**. On Gemini 2.5 the lever is real in the other direction (258 → 66 is a genuine 3.9× cut).

**Do not buy OCR separately.** Google Cloud Vision at $1.50/1,000 units means a 12-frame hook pass costs $0.018/video = **$270/month** — 17× the cost of running the entire video through Gemini 2.5 Flash-Lite, for strictly narrower output **[VERIFIED]**. Read on-screen text inside the Gemini call you are already paying for. Keep PaddleOCR self-hosted as a zero-marginal-cost audit path on a 1% sample.

Likewise skip AssemblyAI's IAB topic detection at +$0.15/hr — **exactly equal to its own base rate**, and a worse format signal than your own clustering.

**Two lanes:** synchronous real-time for videos clearing the alert threshold (~50–80/day), and the Batch API at **50% off** for the ~420–450/day corpus feed. Gemini batch jobs **expire after 48 hours** if still pending and results are unrecoverable — build a re-submit path, not just a poll. Reach Gemini Tier 2 ($100 paid + 3 days elapsed) before any historical backfill, or the $10-per-10-minutes Tier 1 spend cap will throttle it.

### 6.4 Clustering and dedupe

**Embeddings are a rounding error:** `text-embedding-3-small` at $0.02/M means 500 videos/day × ~400 tokens = **$0.004/day, $1.20/year**. Choose on dimension and vector-DB footprint, not price.

**Do not build "find similar videos" on averaged CLIP/SigLIP frame vectors.** A retrieval benchmark shows frame-averaged image encoders at roughly half the quality of true video embedders (X-CLIP NDCG@10 0.470, SigLIP 2 0.325 vs Gemini Embedding 2 at 0.769 and Marengo at 0.760) **[UNVERIFIED — 20 CC0 Pexels videos, 60 queries; Pexels stock is a poor proxy for TikTok. Re-run on labelled Goodfor videos before locking the choice.]** The lesson generalises even if the numbers do not: video is not a bag of frames.

**Clustering:** BERTopic with `UMAP(n_neighbors=15, n_components=5, min_dist=0.0, metric='cosine', random_state=42)` → `HDBSCAN(min_cluster_size=N, metric='euclidean', cluster_selection_method='eom', prediction_data=True)`.

Two operational facts: there is **no `n_topics` knob** — `min_cluster_size` indirectly controls topic count — and **UMAP is stochastic**, so compute embeddings once and re-run BERTopic over them. The documented default `min_cluster_size=150` is calibrated for 100k+ documents and would collapse a 15k-video corpus into 5–8 mega-clusters; use **0.5–1% of corpus (25–75 at 5k–15k videos)**.

`prediction_data=True` enables `approximate_predict()` — **re-fit weekly, assign daily in milliseconds.** Label clusters with an LLM from the 15–20 highest-probability members: ~50 clusters × ~4k tokens weekly on Gemini 2.5 Flash ≈ **$0.05/week**.

**Treat HDBSCAN's `-1` outlier label as the "novel format" alert queue.** In competitor intelligence the outliers are the product, not the noise.

**Near-duplicate detection: vPDQ, not TMK.** TMK optimises for identical videos of the same length with a fixed-length hash; vPDQ produces a variable-length hash and matches subsequences. TikTok reposts are trimmed, cropped and re-captioned, so vPDQ is correct. Hash 1 frame/sec → ~30 PDQ hashes × 256 bits = ~1 KB/video as Postgres `bytea`; one FAISS binary index (2,000 videos × 500 frames benchmarks at 0.2525 ms/query versus 684.5 ms brute force). Repo defaults are quality filter F=50, match distance D=31, comparison percentage Pc=80%.

**Tighten D to ~20.** At the default you cannot separate "same creator reposting" (dedupe it) from "different creator recreating the format" (that *is* the signal). Deduping the second away destroys the product.

### 6.5 Hook analysis

The only officially grounded hook constant that exists is TikTok's **5-second** boundary — the Creator Rewards Program requires "Video views must be longer than 5 seconds" **[VERIFIED]**.

**Every 3-second retention benchmark in circulation is unusable.** Sources give incompatible cut-points for the same variable (>65% vs 70–85%) and incompatible multipliers (4–7× vs 2.2×), none disclose a sample or method, and several contradict each other outright **[REFUTED as shippable facts]**. So are the "optimal 21–34 seconds" claims and every "best time to post" rule — TikTok has never published an optimum, and no official documentation states that posting time affects distribution.

**Instrument at 5 seconds, derive the rest in-house.** Extract 12 frames from the first 3 seconds (`ffmpeg -ss 0 -t 3 -vf fps=4`), pHash-dedupe, pass to Gemini with ASR word timestamps filtered to t<3.0s, and emit constrained enum output so clusters stay comparable:

```
hook_type ∈ { direct_address, question, negative_claim, result_reveal,
              before_after, listicle_countdown, pattern_interrupt,
              text_only_static, duet_react, pov_scenario,
              price_reveal, controversy_bait }
```
plus `hook_text_sequence[]` (each on-screen text state with timestamp), `spoken_hook`, `face_present`, `face_screen_fraction`, `cut_count_first_3s`, `caption_style`, `audio_type`.

Then regress Goodfor's own TikTok Analytics retention curves against `hook_type` and `cut_count_first_3s`. Within weeks you have an internal benchmark grounded in your own audience, which is worth more than any published constant.

**One frame-sampling warning.** Scene detection is a pixel-difference metric, so a static talking-head TikTok whose on-screen text swaps every 0.8 seconds scores near zero and yields **one** keyframe — losing exactly the on-screen-text sequence the hook classifier needs. Dense-sample the hook regardless of scene scores. The commonly cited ffmpeg scene thresholds (0.1–0.3 / 0.4–0.5 / 0.6–0.7) appear in no ffmpeg documentation and are tutorial folklore **[REFUTED]**.

### 6.6 All-in analysis cost

| Lane | Per video | Per month at 500/day |
|---|---|---|
| Quality (Gemini 2.5 Flash, sync) | $0.0056 | ~$120 all-in |
| Optimised (3.1 Flash-Lite, 85% batched) | $0.0014 | ~$56 all-in |
| Naive (Claude Opus 5 on frames) | $0.108 | ~$1,615 |

**The spread between the sensible and the naive architecture is roughly 30×**, and it is entirely a function of model and batching choices that take a day to get right.

---

## 7. Replication engine and legal guardrails

### 7.1 The rule

**Replicate formats. Never replicate assets.**

TikTok's Creator Academy originality policy defines four buckets of unoriginal content **[VERIFIED]**: completely copied ("You cannot directly use content from other sources without permission"); largely repurposed ("from another source without adding any creative edits"); spliced compilations ("combined from multiple sources with little or no additional information or content value"); and watermarked ("If your repurposed content includes a watermark or logo, in most cases, it does not count as original content").

**All four key on reuse of a source asset.** Re-shooting a competitor's format with your own footage, script and on-screen text falls outside every one of them. That negative inference is the legal and policy foundation of the entire replication strategy, and it holds.

Consequences of getting it wrong: "Unoriginal content may be removed from the For You feed, making it harder to discover", and ineligibility for Creator Rewards, "which uses 'originality' as a key metric" — so originality is a **scored input, not a binary gate**.

**Ingest TikTok's Account Check tool per post** rather than inferring originality. It is TikTok's own first-party diagnostic and it tells you what TikTok actually thinks.

### 7.2 Copyright boundaries

**US.** *Rentmeester v. Nike*, 883 F.3d 1111 (9th Cir., 27 Feb 2018) affirmed dismissal in full: Nike "borrowed only the general idea or concept embodied in the photo" **[VERIFIED verbatim]**. But *Hanagami v. Epic Games* (9th Cir., 1 Nov 2023) reversed a Rule 12 dismissal over a **two-second sequence** — four beats of music, eight body movements, repeated ten times **[VERIFIED]**. Reducing choreography to poses "would be akin to reducing music to just 'notes'"; what is protected is "the selection and arrangement of the work's otherwise unprotected elements."

The gap between those two cases is where a replication strategy lives. The operative rule: recreate with your own footage, words and props; never reuse the competitor's pixels or audio-as-recorded; **never reproduce a verbatim script or verbatim on-screen text.** Literal text copying is the cleanest substantial-similarity evidence available to a plaintiff and requires no expert testimony.

**UK.** *Banner Universal Motion Pictures v Endemol Shine* [2017] EWHC 2600 (Ch) requires (i) "a number of **clearly identified** features which, taken together, distinguish the show" and (ii) those features "connected with each other in a coherent framework which can be **repeatedly applied**" **[VERIFIED verbatim]**. A 15-second TikTok format fails both limbs comfortably. **UK format-rights exposure is close to nil.**

**EU.** TRIPS Art. 9(2) protects expression not ideas; *Levola Hengelo* (C-310/17) requires expression identifiable "with sufficient precision and objectivity", which defeats vague "vibe" claims; *Funke Medien* (C-469/17) locates originality in "the choice, sequence and combination".

> **Two EU cases turned while this research ran.** *Mio* (C-580/23) was decided **5 December 2025**, adopting a recognisability approach rather than an overall-impression test for infringement; *Pelham II* (C-590/23) was decided by the Grand Chamber, reported **14 April 2026**. Widely-cited 2024 commentary still lists both as pending. **Mio's recognisability standard directly governs how close an EU-facing recreation may sit to the original — neither holding was read in this research, and both need a lawyer's eye before the EU-facing replication policy is finalised.**

### 7.3 Music — the constraint that shapes your account estate

TikTok's **Commercial Music Library contains 1,000,000 songs** — TikTok's own figure, verbatim: "a global music library of 1 million songs" **[VERIFIED]**. A vendor claim of 150,000 is an order of magnitude low.

The CML is **not** Business-account-exclusive — personal accounts reach it through the "Commercial Sounds" dropdown. It is *mandatory* for Business accounts **[VERIFIED]**.

This creates an unavoidable trade:

| | Business account | Creator account |
|---|---|---|
| API publishing | **Yes** | No |
| Ads Manager / Spark Ads | **Yes** | No |
| Bio link at any follower count | **Yes** | 1,000-follower threshold |
| Trending (non-commercial) sounds | **No** — CML only | **Yes** |
| Creator Rewards | No | **Yes** |

**You cannot have both on one account.** Run a two-tier estate and make `account_type` a first-class schema field that *gates sound selection at brief-generation time*. A trend that depends on a specific non-commercial sound simply cannot be executed on a Business account, and the system should say so before anyone shoots the video rather than after.

The enforcement ladder for a Business account using a non-CML trending sound (muting, removal, ad rejection, account restrictions) is **[VENDOR]** only and should be tested empirically on a throwaway account before the policy is written into the product.

### 7.4 AI content

TikTok's rule: "we require creators to label AI-generated or significantly edited content that shows **realistic-looking scenes or people**" **[VERIFIED]**. Safe harbours are explicit: no disclosure needed for "small edits like color correction, reframing, or cropping" or "using artistic styles, like anime". **The trigger is realism, not AI usage.**

TikTok has labelled over 1.3 billion videos, implemented C2PA Content Credentials since 9 May 2024, and since 19 Nov 2025 applies "a robust technological 'watermark' that only we can read" **[SINGLE-SOURCE, TikTok Newsroom]**. **Never build any workflow that depends on stripping watermarks** — invisible watermarks survive re-encoding and are readable by TikTok while being invisible to your pipeline.

**EU AI Act Article 50 became applicable on 2 August 2026 — four days ago — with no grandfathering.** Obligations are "instantly applicable to all AI systems within scope, regardless of when the system was placed on the market." Deepfake labelling applies "even without intent to deceive… even if no real individual is depicted", explicitly reaching "artificially generated product shots". Penalties reach **€15 million or 3% of worldwide annual turnover, whichever is higher** **[SINGLE-SOURCE — law-firm summaries, not the Official Journal text; verify Art. 50(2) and 50(4) against the consolidated Regulation]**.

**TikTok's AIGC toggle is necessary but may not be sufficient.** Article 50 imposes an independent machine-readable marking duty on the deployer. If Goodfor markets into the EU/EEA, that is a separate implementation, and its exposure dwarfs any platform penalty.

### 7.5 Naming competitors

This is the highest-probability legal complaint in a replication strategy and the one that produces a letter within days.

UK s.10(6) TMA 1994 was **repealed** by the Trade Marks Regulations 2018, in force 14 January 2019. Comparative use is now non-infringing **only if it meets every Article 4 condition of Directive 2006/114/EC**: not misleading; compares goods meeting the same needs; objectively compares material, relevant, verifiable and representative features; does not discredit or denigrate; does not take unfair advantage of the mark's reputation; does not present goods as imitations **[SINGLE-SOURCE — Bird & Bird]**.

**Route every competitor-naming script to a human review queue with a mandatory per-claim substantiation field carrying a dated figure.** "£X vs £Y as at 6 August 2026", never "cheaper".

### 7.6 Disclosure — build this into the publishing gate, not the checklist

**A new TikTok Branded Content Policy was published 4 August 2026 and takes effect 31 August 2026** — during Phase 3 of this build **[SINGLE-SOURCE]**. Detection reportedly reached 100% of US creator accounts by end of March 2026; undisclosed branded content triggers an in-app notification within **2–3 hours**, and if not disclosed or appealed within **24 hours**, the content "may then be ineligible for the For You page" **[VENDOR]**. Properly disclosed branded content reportedly performs *better* than undisclosed promotional material — disclosure is a ranking positive, not a tax.

**US — 16 CFR Part 465**, effective 21 October 2024. Maximum civil penalty **$53,088 per violation** (raised from $51,744 effective 17 Jan 2025; unchanged for 2026 per OMB Memorandum M-26-11). §465.2 bans reviews from someone who never used the product. §465.4 bans conditioning compensation on positive sentiment — **a creator brief may not say "must be positive"**. Violations count **per post**, so exposure scales linearly with posting cadence — which is exactly what this system is designed to increase.

**UK — ASA/CAP.** Acceptable labels are only "Ad", "Advert", "Advertising", "Ad Feature", "Advertisement Feature". Explicitly inadequate: "Sponsored", "Gifted", "In association with", brand @mention alone, "aff", "sp". Must be visible before engagement — **a hashtag at the end of a caption fails**, because it sits behind "See more". The ASA cannot fine, but the **CMA can, directly and without court since 6 April 2025** under the DMCCA 2024: up to **10% of global turnover or £300,000, whichever is higher**. In its first year the CMA investigated 14 businesses, ordered £1.3M+ in refunds and levied fines approaching £6M.

**The single compliant artefact:** burned-in "**Ad**" in the first frame + spoken disclosure + "#ad" leading the caption. That clears both regimes. "Sponsored" alone passes the FTC and **fails the ASA**.

**Make this a non-bypassable field on every scheduled post**, region-aware, storing which TikTok toggle was used ("Your Brand" for Goodfor's own account promoting Goodfor; "Branded Content" for a paid creator), and persisting `post_time + 24h` as an appeal-deadline SLA.

One more constraint from the developer guidelines, easy to miss and audit-relevant: apps "should not superimpose or otherwise include any brand name, logo, watermark, other promotional branding, **link or promotional text**" **[VERIFIED]**. That rules out burned-in CTA overlays and link text in the render pipeline.

---

## 8. Publishing and scheduling

### 8.1 The three paths

Recall §1.2: TikTok explicitly lists "a utility tool to help upload contents to the account(s) you or your team manages" as an unacceptable app category. Options in order of recommendation:

**(A) Draft/inbox flow — recommended for v1.**
`POST /v2/post/publish/inbox/video/init/` delivers the finished video to the creator's TikTok inbox, where a human taps publish. This path:
- is **not audit-gated for public posts** — content can go public immediately;
- sidesteps the prohibited-app problem entirely, because the human publishes;
- keeps a person in the loop for the compliance gate you need anyway (disclosure, sound licensing, competitor claims);
- costs one tap per post.

For a small team posting 1–2 videos per account per day — which §10.5 recommends on attribution grounds anyway — the marginal cost of that tap is negligible against the risk it retires.

**(B) Third-party audited vendor.** Publishing through a vendor whose client already passed audit plausibly yields public posts with no Goodfor-side audit, because the restriction attaches to the registered `client_key`.

> **This is an inference, not a documented fact.** TikTok nowhere states that a vendor's audit extends to its customers, and every corroborating quote comes from vendors selling exactly this arrangement. Ayrshare's own TikTok documentation and launch blog **never mention audit at all** (confirmed negative). Get written confirmation from any vendor before architecting on it.

Trade-offs that survive regardless: the OAuth consent screen shows the *vendor's* name to your team; a vendor client suspension takes down all publishing at once; the vendor sees every video, caption and token; and vendor rate limits stack on top of TikTok's.

**(C) Own audit.** Free to apply, 2–4 weeks per round **[SINGLE-SOURCE — Mixpost's implementer docs, not TikTok; treat as a floor for one round, not end-to-end]**. Requires UX mockups in PDF and a 10-step screen recording covering authorisation, composer with nickname, privacy selector with no default, Duet/Stitch/Comment toggles unchecked, disclosure toggling, consent text changes, preview, publish, and live verification on profile. Documented rejection reasons include demos omitting the full authorisation flow, creator settings not respected in the UI, no confirmation screen before publishing, and — notably — "Requesting scopes you do not demonstrably use is a rejection reason."

**Recommended: ship (A) now, submit (C) in parallel on day one.** They are not exclusive, the audit is free, and having your own audited client eventually removes the vendor dependency. Budget for multiple rounds.

### 8.2 Vendor pricing if you take path (B)

| Vendor | Model | 30 TikTok accounts |
|---|---|---|
| **Zernio** (was Late/getlate.dev) | 2 free, then $6/mo (3–10), $3/mo (11–100), $1/mo (101+) | **~$108/mo** |
| Ayrshare | Per brand-profile: Premium $149, Launch $299, Business $599 | $599/mo (Business, 30 profiles) |
| Blotato | Starter $29 (20 accounts), Creator $97 (40) | $29–97/mo, but see conflict |
| Postiz cloud | Standard $29 (5 ch), Team $39 (10), Pro $49 (30), Ultimate $99 (100) | **$49/mo** |
| Mixpost | **$299 one-time** Pro, unlimited accounts | $299 once |

Note the 5.5× spread between Zernio and Ayrshare for the same 30 accounts — because one bills per social account and the other per *brand profile*. **Price the account model, not the tool.**

Two conflicts to resolve before selecting: Blotato's Starter tier is claimed by a competitor to cap at 3 TikTok accounts per 24h, which cannot coexist with its own "up to 900 TikTok posts/month"; and Mixpost's own docs say Lite and Pro may apply for TikTok App Review while a third-party review says Enterprise only. **Trust first-party, verify in writing.**

**Buffer is closed to new integrators** — no new developer app registrations, GraphQL API in public beta with personal keys only. Do not design against it. **Later** has no public posting API. **Ayrshare has signalled platform risk**: after X changed third-party access on 31 March 2026, Ayrshare stated it is "expanding this capability across Ayrshare" for bring-your-own-key. TikTok is not named in that roadmap, but the direction is clear — **build a publishing abstraction with at least two implementations from day one.**

### 8.3 Publishing state machine

```
creator_info/query  →  init  →  upload (PUT)  →  status/fetch poll  →  reconcile
```

- **`creator_info/query` must be called first** on every post. It returns the allowed privacy levels, the creator's Duet/Stitch/Comment settings, and `max_video_post_duration_sec`, which can be *below* the 10-minute API ceiling for a given account.
- **A 200 is not a successful publish.** TikTok processes asynchronously; response is `status: pending`, typically completing in 1–2 minutes, and a post can fail minutes after acceptance. Status polling or webhook reconciliation is mandatory.
- **Private posts stay `pending` indefinitely** with no webhook until made public — special-case this or the queue fills with zombies.
- **`publicaly_available_post_id`** — TikTok's own misspelling, code it verbatim — only returns after moderation approval. Ship a `publish_id → publicaly_available_post_id` reconciliation job, because the joinable post ID does not exist at publish time.
- Branch on the **error-code string, never the HTTP status**: `url_ownership_unverified` returns 400 on one documentation page and 403 on another.

**Anti-spam governor:**

| Control | Value |
|---|---|
| Posts per account per 24h | **12** (headroom under the ~15 guidance) |
| In-flight uploads per account | **4** (under the 5-pending ceiling) |
| Any `spam_risk_*` error | **24h account quarantine — do not retry** |
| Caption text | Vary per account; caption spam is scored separately |
| Rate headers | Honour `X-RateLimit-Remaining` / `X-RateLimit-Reset` dynamically |

Retrying a `spam_risk_*` escalates toward `spam_risk_user_banned_from_posting`. Treat it as a circuit breaker, not a transient failure.

**One posting system per account.** The ~15/day creator cap is shared across all API clients using Direct Post, so a legacy scheduler still connected to the same account will cause silent failures in yours.

### 8.4 Multi-account operation — where not to spend money

The advice circulating about multi-account TikTok operations is almost entirely vendor marketing. Claims about proxies, antidetect browsers, "50+ device attributes", "3–6 accounts per device" and "same IP = ban" trace uniformly to companies selling proxies, antidetect browsers, or cloud phones, with no controlled experiment anywhere **[REFUTED as a basis for spend]**.

**They are inapplicable by construction.** Server-to-server Content Posting API calls authenticate by OAuth `access_token`, not device fingerprint. Canvas and WebGL fingerprinting have nothing to touch. Ayrshare, Buffer and Hootsuite serve thousands of accounts from a handful of datacentre IPs.

TikTok's Developer ToS §II.1 **affirmatively grants** the right to "use automated means in your Application to collect information from or otherwise interact with the TikTok Developer Services", qualified by "solely as described in the TikTok Developer Documentation" **[SINGLE-SOURCE]**. The Community Guidelines ban automation "designed to bypass our systems" — API posting is the system, not a bypass.

**The real risk is content-level, and it is exactly what a replication strategy produces:** content "is also ineligible for the FYF if it includes unoriginal or reused material without anything new". That is **silent reach suppression, not a ban** — the hardest failure mode to see in analytics, and the one to instrument for (§8.5).

**Spend the anti-ban budget on per-account content differentiation, not infrastructure.** Different hook, voiceover, opening frames and caption per account. Metadata-only variation does not defeat frame-sequence or audio fingerprinting. Zero spend on proxies or antidetect browsers.

### 8.5 Account health monitoring

Build this into the schema from v1, not as a dashboard afterthought:

- **Rolling 90-day strike window per policy area** (safety, civility) and per feature (comments, DMs). Strikes expire after 90 days **[VERIFIED]**; the permanent-ban threshold is not published.
- **FYF-suppression detector**: fire when For You traffic share collapses while other sources hold steady. This depends on the analytics traffic-source breakdown — **verify in-app whether Search is broken out separately in 2026 before committing to the detector**, because that is unconfirmed and it is the primary creator-side suppression diagnostic.
- **Account Check originality status** ingested per post (§7.1).

### 8.6 Native scheduler, for reference

TikTok's own scheduler: **15 minutes to 10 days** ahead, desktop web only, **Business Account required**, video only — "Carousels, playlists, ad campaigns, and Lives are not included" **[VERIFIED first-party, though the announcement post predates 2025 and may be stale]**. Useful as a manual fallback; not a backend.

The Content Posting API has **no documented scheduling horizon**. That is an argument from absence, not a documented absence of a limit — validate empirically before queueing months ahead.

---

## 9. Creator CRM and UGC sourcing

### 9.1 Data source

**Modash is the only vendor with readable docs, a published rate card, and a real discovery API** **[VERIFIED]**:

| Product | Entry | Rate |
|---|---|---|
| Discovery API | **$16,200/yr** | 3,000 credits/mo @ $0.45 |
| Raw API | **$10,000/yr** | 40,000 req/mo |

Discovery credits: search **0.01 per search result** (not per request), influencer report 1, audience report 1, performance 0.25, taxonomy endpoints 0. A 1,000-creator shortlist plus 200 full reports costs **210 credits = $94.50** — well inside the monthly allowance. **The $16,200 floor is the barrier, not the unit cost.**

Two traps: the Raw API's advertised $0.02/request does not reconcile with its own annual price (40,000 × 12 × $0.02 = $9,600 ≠ $10,000; true rate $0.02083). And **"A 404 status code is treated as a successful request"** and consumes quota — a real budgeting hazard for a polling crawler.

**A schema decision with no second chance:** the TikTok report returns **no `credibility` field and no brand-affinity field**. Credibility is a **query-time-only signal on TikTok** — capture it from the search response at shortlist time and persist it, because re-fetching the report later will never return it.

**Hard constraint:** Modash indexes creators with **1k+ followers**. Sub-1K creators are absent regardless of which database-size figure you believe (their own pages claim 96M, 200M, 250M and 380M on different URLs). Nano-tier sourcing is direct-outreach-only.

**Second opinion: HypeAuditor** for its Audience Quality Score, which is TikTok-supported and which Modash's TikTok report lacks. Build the whole integration against its free sandbox (`auditor.searchSandbox`) — rare in this category — and pin `v=2019-10-18` explicitly, since omitting the version defaults to LATEST. Its rate-limit documentation is self-contradictory ("the limit on RPS… should be less than 100 per minute"); **the only defensible reading is 100 requests/minute ≈ 1.67 RPS.** Its pricing is entirely unpublished; the $299/$499 figures circulating are third-party and were knocked out in fact-checking.

**Do not put Phyllo/InsightIQ in the cold-discovery path** — its public profile analytics refresh **bi-weekly**, which cannot serve hours-latency work. It is right for post-recruitment consented data (90 days of history on connection, 24-hour refresh).

**Excluded:** Heepsy (explicitly no API). Aspire, Upfluence, GRIN, CreatorIQ, Traackr, Klear (gated docs, $17K–$100K+/yr floors, mostly paying for a UI you are replacing). Later Influence (reporting only, cannot seed a database). Collabstr, Insense, Billo, JoinBrands are **supply, not data** — buy from them, do not integrate.

**TikTok Creator Marketplace is dead as a product** — creators migrated to TikTok One after 10 March 2025 and TCM shut down 1 April 2025. Assume no API access; the TTO Basic tier is **50 queries/day**, unusable as a crawler.

### 9.2 Pricing reality — handle with care

**This is the softest evidence in the entire research.** Seven claimed rate figures were unsupported at their cited sources and seven more were wrong. Nearly every circulating creator-rate table either misattributed its source or cited figures that do not exist there. Treat everything below as a negotiating range, never as a formula.

**The one dataset with real transactions** — Collabstr's 2026 report, 21,000+ collaborations **[SINGLE-SOURCE, 403 on direct fetch]**:

| Metric | Value |
|---|---|
| UGC asking price | **$180** |
| UGC actually paid | **$154** (85.6% of ask) |
| UGC campaign average | $197, down 5.7% YoY |
| Deals under $300 | **80%** |
| UGC share of all influencer campaigns | 15% → **35%** YoY |

**Plan at $150–$200 per video, not $300–$500.** Use $154 as the planning anchor and $180 as the negotiation ceiling.

**Do not encode a "brands pay 50% of ask" rule** — that figure circulates widely and appears nowhere in the report. The 2026 ratio is 86%.

**Licensing multipliers** — the strongest-verified pricing block, triple-sourced:
- Usage rights, specified duration: **30–50% of base**
- Raw footage: **30–50% of base**
- Additional hook/CTA variation: **$50 flat each**
- Whitelisting / Spark Ads: **30% of base per month** (one source says 30–100%)
- Full buyout: **2–5× base** (UK convention)

```
licence_cost = base_fee × (1 + usage_multiplier
                             + whitelist_rate × months
                             + exclusivity_multiplier)
```

Leave `exclusivity_multiplier` as an operator-set field with **no default** — the commonly cited "20–40% exclusivity premium" appears at none of its claimed sources.

**Outreach benchmarks** — 1stCollab, 100,000+ outreaches across 150+ campaigns **[VENDOR, but the only one with a stated sample]**: **32.8% baseline response rate**; 47% of responses within 24h, 91% within 7 days, plateau at 28 days; follow up on **day 2 and day 5**; keep messages under 250 words. Prior-relationship creators reply at ~2.5×. Late-stage brands get >2× the response of seed-stage — **an early-stage app should plan for the low end of every band.**

**TikTok DM is a one-shot channel.** TikTok delivers exactly one message to a non-follower's request inbox and blocks further sends until they accept or reply. **DM for first touch, email for the cadence.**

### 9.3 Spark Ads

Creator flow **[VERIFIED]**: Settings → Creator tools → **Ad settings** (requires a Professional account) → open the video → "..." → Ad settings → accept terms → **Ad authorization** → duration → **Generate code**.

Durations: **7 / 30 / 60 / 365 days, default 30**. Advertiser path: "+ Add videos or images" → "TikTok posts" tab → "Apply for Authorization" → enter code → Search → Confirm. **Up to 20 codes batch-submitted at once.**

Error states: `auth_code_expired` (**codes cannot be reactivated — a brand-new code is required**), `auth_code_format_error`, `not_public_video`, `story_video_not_supported`.

**The mechanism worth building around:** all paid engagement accrues permanently to the creator's **original organic post**, not to a separate ad object. **Store the organic post ID as the join key between organic and paid performance.** That single decision makes the whole organic/paid measurement story coherent.

For a retained roster, prefer **Business Center account-level linking** — grants Spark access to all eligible posts with **no expiry until unlinked**, avoiding per-video code churn entirely.

**Every published Spark Ads performance statistic is unusable.** The "+43% conversion", "+134% completion rate", and the Nielsen/Socialbakers/Measured.com/Kantar studies all trace to a single SEO listicle whose own arithmetic is broken — it publishes 3.84% vs 1.12% and labels it "+69%" when the actual lift is +243% **[REFUTED]**. None of the underlying studies could be shown to exist. Measure your own.

### 9.4 Vetting

- **Fake followers:** hire under **25%**, avoid over **50%** (Modash's own guidance). Baselines: sub-50K creators run 10–20% fake; larger creators 20–30%.
- **Rank on `er_views`** — (likes + comments + shares) ÷ views × 100 — against a **6–8% median band** by tier. Circulating "micro 2–4%" figures are follower-denominator numbers in disguise.
- HypeAuditor compresses fraud signals into a 1–100 Audience Quality Score and **publishes no numeric cutoff**, stating detection is "probabilistic, not perfect".

### 9.5 CRM schema

**Model the collaboration, not the creator, as the thing that moves through stages** — the same creator sits at different stages for different Goodfor apps simultaneously.

```
sourced → qualified → contacted → replied → negotiating
       → contracted → delivered → live
terminal: paid | renewed | archived | rejected
```

Entities:

- **`creator_identity`** — dedupes one human across platforms and handle changes. `id, display_name, primary_email, country, timezone, payment_entity_id, notes`
- **`creator_account`** — `creator_identity_id, platform, platform_user_id, username, url, followers, engagement_rate, avg_views, is_verified, last_posted_at, source_vendor, vendor_last_synced_at`
- **`creator_metric_snapshot`** — append-only
- **`creator_audience`** — `captured_at, gender_split, age_split, geo_countries, languages, interests, credibility_score NULLABLE, audience_reachability`
- **`app`** — Goodfor is one of several
- **`campaign`** — `app_id, objective, budget_cents, start_date, end_date, brief_url`
- **`collaboration`** — `campaign_id, creator_account_id, stage, owner_user_id, rate_cents, currency, first_contacted_at, replied_at, contracted_at, next_action_at, source`
- **`deliverable`** — `type, due_date, status, asset_url, posted_url, platform_post_id, is_spark_ads_authorized, spark_ads_code, spark_ads_expires_at`
- **`rights_grant`** — `usage_scope ∈ (organic_only | paid_ads | whitelisting | perpetual), territories, starts_at, expires_at, exclusivity_window_days, renewal_price_cents`
- **`payment`** — `amount_cents, currency, platform_fee_cents, method, status, invoice_url, tax_form_status`
- **`performance_fact`** — append-only per capture: `deliverable_id, captured_at, views, likes, comments, shares, saves, install_count, signup_count, trial_count, subscription_count, revenue_cents`

Three rules: **key on `platform_user_id`, never username**; **never UPDATE metrics in place** (outperformance is a derivative and needs history); **stamp vendor provenance and sync timestamp on every enriched row**, because Modash on-demand and Phyllo bi-weekly have completely different staleness characteristics.

**Ship `rights_grant` in v1.** JoinBrands grants unlimited usage rights; Collabstr and Insense do not. **A live paid ad running on an expired usage licence is the single largest routine legal exposure in a UGC programme**, and the alert on `licence_end` is trivial to build in v1 and painful to retrofit.

### 9.6 Marketplace take rates

| Platform | Subscription | Fee |
|---|---|---|
| JoinBrands | Free / $99 / $299 / $499 per mo | 15% / 12% / 10% / 8% |
| Collabstr | Free / $249 / $333 per mo | 10% brand (5% Premium) **+ 15% creator** = **~25% effective** |
| Insense | $500/mo (or $400 annual) | 20% / 10% / 7% |

**JoinBrands is the only marketplace confirmed to include Spark Codes and Instagram Partnership Ad Codes at no extra cost** — decisive if paid amplification is in scope. Note Collabstr's ~25% combined effective rate; the headline 10% is half the story.

---

## 10. Attribution and measurement

### 10.1 The asymmetry that defines this problem

**Android gives you per-video ground truth for free. iOS gives you essentially nothing.**

**Android** **[VERIFIED]**: Play Install Referrer library `com.android.installreferrer:installreferrer:2.2`. Carry the video ID at zero cost: `&referrer=utm_source%3Dtiktok%26utm_content%3D<video_id>`. Read once on first launch, 90-day retention. **100% deterministic.**

**iOS**: AdAttributionKit and SKAdNetwork "explicitly require signed ads from registered ad networks; organic traffic isn't covered" **[VERIFIED]**. No organic post can generate a postback. Fingerprinting is banned outright — Apple may reject apps that "reference SDKs… engaging in this practice". Deferred deep linking has a **15-minute lookback** on AppsFlyer UDL, and the "saw it, downloaded tomorrow" cohort is exactly where organic over-indexes. **Budget 60–75% of organic-social iOS installs as unattributable at video level.**

**Ship Android as the attribution ground truth and extrapolate iOS from it.** Stop designing for an iOS equivalent that does not exist. Note that iOS is ~77% of new subscription-app launches, so the extrapolation carries real weight — validate the ratio periodically rather than assuming stability.

**Privacy Sandbox is dead as an attribution route** — announced 17 October 2025, retiring the Attribution Reporting API on both Chrome and Android, with no end dates published. Do not architect on it.

### 10.2 MMP pricing

| Vendor | Free tier | Paid | Organic |
|---|---|---|---|
| **Kochava** | **10K attributed conversions/mo**, includes owned-media attribution + SmartLinks | Foundation from $500/mo | — |
| Singular | 15,000 paid conversions | $0.05/conversion | "All organic installs are always free" |
| AppsFlyer | Zero plan, 12K conversions first year | **$0.07**/conversion | Unattributed organic free |
| Tenjin | 2,000/mo | S $200 / M $400 / L $700 per mo; overage **≤$0.03** | "Unlimited Organic Installs" |
| Branch | trial | **Median ACV $52,997/yr** | — |
| Adjust | — | Median $44,000/yr | — |

At 100,000 owned-media-attributed installs/month: AppsFlyer ~$7,000 · Singular ~$5,000 · **Tenjin ~$2,200** · Kochava $500 + unpublished overage. Branch and Adjust are out on price alone.

**The trap:** putting a per-video OneLink in front of organic TikTok **converts free organic traffic into billable conversions**. AppsFlyer is explicit that a conversion is one "that your efforts drove and that you measured with AppsFlyer" — owned-media links count. **Do not front organic traffic with an MMP link unless per-video attribution value exceeds the per-conversion price.**

Start with **Kochava's free tier** (10K attributed conversions/month, owned-media attribution and SmartLinks included, $0). Move to Tenjin budgeted at the $0.03 overage ceiling only when volume demands — and only after Tenjin confirms in writing that owned-media links bill at all, since its own tooltip defines a conversion as one "attributed by Tenjin to a **PAID** user acquisition campaign".

If using AppsFlyer OneLink: 1,000 req/sec/account, 7.5M requests/month, payload max 3,000 chars, URL ID max 50 chars. **TTL defaults to 31 days and maxes at 730** — and 31 days is shorter than a video's useful life (~35 days to 95% of lifetime views), so links 404 exactly when the long tail arrives. **Set an explicit long TTL.** Also: "Links created via the API do not appear in the list of OneLink custom links in the dashboard" — your database is the sole system of record.

### 10.3 Apple as a control total

App Store Connect's Analytics Reports API gives a daily channel-level control total, never a per-video ledger.

`POST https://api.appstoreconnect.apple.com/v1/analyticsReportRequests` with `accessType: ONGOING`. Admin role required for the first request of each report type. First report arrives in 24–48 hours; **data for a given day is complete two days after the reporting date**; format is tab-delimited `.txt.gz`.

Source Type enum: App Store search, App Store browse, **App referrer**, **Web referrer**, App Clip, Unavailable, Institutional purchase. TikTok's in-app webview surfaces as an *app* referrer.

**The privacy floor makes per-video impossible** **[VERIFIED]**: values from fewer than 5 users or devices are omitted, and noise is injected such that **68.2% of values fall within ±2, 95% within ±4, 99.7% within ±6**. Eight true installs reports as 4–12 at 95% confidence. Late corrections occur beyond the completeness threshold, so **load idempotently, re-keyed on `(date, processing_date)`, newest processing_date wins.**

**Campaign links (`pt`/`ct`/`mt`)** are usable but tight: `ct` accepts up to **30 alphanumeric characters**; attribution requires a first-time download **within 24 hours** of the click; campaigns appear only after 24 hours and **at least five first-time downloads**; last-touch overwrites; **both `pt` and `ct` are required** or nothing registers. Encode `ct` as base36 with a lookup table.

**Custom Product Pages are the underused lever**: up to **70** additional product page versions, each with its own conversion metrics. Map 5–15 recurring content formats to CPPs and you get **format-level conversion rates above the privacy floor for free** — the closest thing to per-format iOS attribution that exists.

### 10.4 What to do instead of deterministic iOS attribution

**Post-install survey (HDYHAU).** Place immediately after onboarding completion, trial start, or first purchase — post-paywall is strongest, never pre-onboarding. **45–85% completion** when timed post-conversion **[VENDOR, no sample size]**. One documented case: the MMP reported 200 subscriptions where HDYHAU indicated 350 — **a 1.75× under-count**. Randomise answer order but pin "Other" last; one option per active channel, no generic "social media" bucket. Reliability is high with 1–2 social channels, low with 5+.

**Add a thumbnail follow-up** — "which account / which video?" over the last 7–14 days. **This is the only per-video iOS mechanism that exists, and it costs $0 per conversion.**

**Incrementality.** Run a **single-channel pause test before any geo design** — 2–4 weeks to clear conversion delays, extended past the trial window for a subscription app. For low-volume apps this beats a complex geo or user-level design. Scale up to GeoLift (Meta's augmented synthetic control, R) or Meridian (Google's Bayesian MMM, Python 3.11–3.13, GPU recommended) when volume supports it. TikTok's own materials cite 97 geo-lift studies, so geo-lift is the platform's preferred incrementality currency.

### 10.5 The cadence constraint

Model daily installs as `baseline + Σ_v (views_{v,t} × k_format)` with a 1–3 day lag kernel, given ~72% of views land on day one.

**Identification requires ≤1–2 videos per account per day.** Post more and the regressors collinearise and the model cannot separate which video drove which spike.

This is a genuine tension with the "post more" instinct, and it should be a conscious decision rather than an accident. Cal AI's account data makes the case that it costs less than it appears: `@calai.track` produced 311 views/video across 176 videos while `@cal_ai_` produced 54,745 views/video across 137 — **a 176× spread between accounts of the same brand posting similar content** **[SINGLE-SOURCE]**. **Account-level variance dominates video-level variance.** More accounts beats more posts per account, and it happens to be the attribution-friendly direction too.

### 10.6 Benchmarks

**Subscription funnel** — RevenueCat State of Subscription Apps 2026, 115,000+ apps, $16bn revenue **[VENDOR, large sample]**:

| Metric | Health & Fitness | Notes |
|---|---|---|
| Install → paid, D35 | **2.9%** | Business 2.6%, Gaming 1.0% |
| **Hard paywall vs freemium** | **10.7% vs 2.1%** | **5.1× — the largest single lever in the dataset** |
| Trial start, D30 | 6.9% | Business 9.1% |
| Trial → paid | 37.7% | Travel 43.5%, Gaming 25.0% |
| **By trial length** | **17–32 days: 42.5%** · 5–9 days: 37.4% · ≤4 days: **25.5%** | Longer trials convert better — contradicts the 3-day default |
| Year-1 LTV per payer | **$35.64** | Productivity $24.95, Gaming $11.22 |

**Value chain:** `installs × install-to-paid × LTV-per-payer`. 1M organic views → ~750 installs × 2.9% × $35.64 ≈ **$775 Year-1 realised revenue per million views**. Do not chain this with the D14 RPI figure ($0.48) — that is an early-window measure and combining them double-counts.

**CPI for comparison** — Tier-1 English, 2026 **[VENDOR]**: fitness/health $2.50–$6.50, productivity/SaaS $4.00–$10.00. iOS runs **2.0–3.5× Android** in Tier 1. Regional multipliers: Tier-1 Europe 0.7–0.9×, LATAM 0.2–0.4×, SEA 0.1–0.3×, Japan/Korea 1.2–1.8×. **Ignore Business of Apps' $1.75–$4.00 TikTok CPI** — it is 2024 projection data and has Android above iOS, contradicting both 2026 sources.

**Link-in-bio CTR is the weakest number in this document** — 1–5% of profile visits, 0.1–0.5% of video views **[UNVERIFIED, no sample size, uncorroborated]**. The derived ~$6.67 organic CPI equivalent rests on it and on an asserted $5 CPM. **Compute your own** as (fully-loaded content cost) ÷ (incremental installs from a pause test). No published organic TikTok CPI exists.

**Genuinely unknown and worth knowing:** brand-account hit rate (what % of videos exceed a viral threshold), median-vs-mean views by tier, videos-per-week-to-traction, and time-to-first-viral. Socialinsider publishes averages only and explicitly declines to publish viral-threshold percentages or medians. The closest proxy is Opus's 13.5M-clip dataset: median **1,879** views per clip, "Viral" = 3×+ = **5,638+**.

---

## 11. Legal position on third-party data

**This section needs a lawyer's sign-off before Phase 1 begins. It is not legal advice.**

### 11.1 The exposure is contract, not criminal

TikTok's Terms of Service, **last updated 1 December 2025** **[VERIFIED verbatim]**, bar users from "use automated scripts to collect information from or otherwise interact with the Services", and state content "may not be downloaded, copied, reproduced, distributed… or otherwise exploited for any purpose whatsoever without our… prior written consent", with an express bar on use "for any commercial or unauthorized purpose".

The CFAA narrowing that scraping advocates cite is **irrelevant here**. *hiQ v LinkedIn* won on the CFAA and **lost the breach-of-contract claim** — and breach of contract is precisely the theory TikTok's ToS supplies. *Van Buren* and the CFAA line of cases do not help.

**Realistic risk profile:** not criminal. Breach of contract, account and IP bans, and injunction exposure.

### 11.2 The pivotal distinction

**Logged-in versus logged-out.** Contract formation is much stronger where the scraper agreed to the ToS by logging in. This is the central issue post-*Meta v Bright Data*, and it drives three concrete mitigations:

1. **Crawl logged-out.** Never authenticate to collect competitor data.
2. **Never scrape from Goodfor-owned TikTok accounts or from infrastructure associated with the authenticated API client.** This is the §1.3 separation rule, and this is why it exists.
3. **Buy from a vendor rather than scraping in-house**, so the vendor performs the collection.

On (3), be clear-eyed: **no vendor in the surveyed set offers indemnification.** Bright Data's "designed to comply with data protection regulations" is a design assertion, not a contractual indemnity. EnsembleData, ScrapeCreators, Lamatok, Piloterr and Data365 publish no compliance language at all. Apify is a **marketplace** — the actor is authored by a third party and Apify's platform terms disclaim responsibility for actor behaviour, so buying through Apify **adds a counterparty rather than protection**.

Buying still helps — it puts the collection activity in someone else's hands and gives you a commercial relationship to point at — but it does not transfer the risk. Price it as risk retained.

### 11.3 UK/EU data protection

Public TikTok posts still contain personal data. If Goodfor is UK-based and stores creator profiles in a CRM, UK GDPR applies: a legitimate-interests assessment, and **Article 14 transparency obligations for data not collected from the data subject**.

**Practical mitigation — minimise what you store.** Persist only public engagement metrics and video IDs for competitor intelligence. **Do not store follower lists or commenter identities.** That is simultaneously the highest GDPR exposure and the most expensive data to acquire (EnsembleData `User Followers` at 2 units; Apify's follower add-on at $4.00/1,000) — the compliant choice is also the cheap one.

### 11.4 Has TikTok enforced?

**Unknown.** No enforcement examples, cease-and-desist reports or API-access revocations over scraping surfaced in this research. That is an absence of evidence rather than evidence of absence — and TikTok's domains block the automated retrieval that would find such reports.

### 11.5 The mitigation that actually matters

**Abstract every TikTok data call behind one internal interface:**

```
TikTokSource {
  getUserPosts(secUid, depth)
  searchKeyword(term, opts)
  searchHashtag(tag, opts)
  getPostInfo(videoIds[])
}
```

Vendor-swapping becomes a config change. Since no vendor indemnifies and Goodfor carries the risk either way, **switchability is the mitigation** — for a vendor being blocked, going out of business, or being told to stop.

---

## 12. Data model

Core tables. `[]` denotes indexes.

```sql
-- COMPETITOR INTELLIGENCE (read plane)

competitor_account (
  id, platform_user_id, sec_uid, username, display_name,
  follower_count, is_tracked, tracking_tier, added_at,
  vendor_last_synced_at
)  [platform_user_id UNIQUE]

tracked_video (
  id, competitor_account_id, platform_video_id, created_at_tiktok,
  duration_s, description, music_id, hashtags TEXT[],
  due_at timestamptz, tracking_active bool, first_seen_at
)  [due_at WHERE tracking_active] [platform_video_id UNIQUE]

video_metric_snapshot (             -- WIDE, not EAV
  video_id bigint, ts timestamptz,
  view_count bigint,                -- BIGINT: TikTok view_count is int64
  like_count integer,               -- INTEGER: int32 in TikTok's schema
  comment_count integer,
  share_count integer,
  favorites_count integer,
  PRIMARY KEY (video_id, ts)
) PARTITION BY RANGE (ts)   -- monthly partitions; pg_cron keeps 3 months ahead
   -- ts is the FLOORED slot → ON CONFLICT DO NOTHING gives free idempotency

video_score (
  video_id, age_hours, z_score, multiplier_vs_median,
  velocity_vph, acceleration, computed_at, baseline_n
)

video_analysis (
  video_id, transcript, hook_type, hook_text_sequence JSONB,
  spoken_hook, face_present, face_screen_fraction,
  cut_count_first_3s, caption_style, audio_type,
  format_cluster_id, embedding halfvec(1536),
  phash_frames bytea, analysed_at, model_version
)  [embedding USING hnsw (m=16, ef_construction=64)]

keyword_trend (
  term, term_type,                  -- keyword | hashtag | sound
  ts, post_count, view_count,
  velocity, acceleration, burst_weight, state
)  -- state ∈ rising | peaked | decaying | bottoming
```

```sql
-- PUBLISHING (write plane)

owned_account (
  id, app_id, tiktok_open_id, username,
  account_type,                     -- business | creator  → GATES SOUND SELECTION
  access_token bytea,               -- KMS-wrapped, never plaintext
  access_expires_at, refresh_token bytea, refresh_expires_at,
  original_granted_at,              -- re-auth prompt computed from THIS
  posts_last_24h, quarantined_until
)

scheduled_post (
  id, owned_account_id, scheduled_for, status,
  video_asset_url, caption, privacy_level,
  disclosure_type,                  -- none | your_brand | branded_content
  disclosure_text_verified bool,    -- non-bypassable gate
  sound_id, sound_is_cml bool,      -- validated against account_type
  publish_id, publicaly_available_post_id,   -- TikTok's misspelling, verbatim
  source_brief_id, competitor_inspiration_id
)

account_health (
  owned_account_id, ts, strike_count_by_area JSONB,
  fyf_traffic_share, originality_status, suppression_flag
)
```

Design rules, restated because each one is expensive to retrofit:

1. **Wide snapshot table, not EAV.** All six metrics arrive in one response; a narrow table multiplies rows 6× and forces a self-join for every velocity query, for zero ingest benefit.
2. **`view_count` is BIGINT, the other three are INTEGER** — TikTok's own schema has `view_count` as int64 and like/comment/share as int32.
3. **Floored timestamp slots** give idempotency under queue redelivery without a dedupe table.
4. **Never UPDATE metrics in place.** Every derived signal in this system is a time derivative.
5. **`account_type` gates sound selection** at brief generation, not at publish time — you want the constraint surfaced before anyone shoots the video.
6. **Tokens are `bytea`, KMS-wrapped**, with the refresh guarded by an advisory lock.

---

## 13. Cost model

Monthly USD at the brief's stated scale: 50 competitor accounts, 200 keywords/hashtags, 500 videos/day analysed, ~5,000 videos under active tracking.

| Line | Low | Expected | High | Driver |
|---|---|---|---|---|
| Data acquisition | $200 | $400 | $1,300 | Poll cadence; listing-derived vs per-video calls |
| AI analysis | $21 | $120 | $750 | Model tier and batch share |
| Storage + DB | $30 | $70 | $160 | Postgres/Timescale vs ClickHouse |
| Compute + queue | $7 | $110 | $850 | Cloudflare Queues vs Temporal |
| Dashboard | $0 | $80 | $475 | Self-hosted vs Retool |
| Publishing | $15 | $49 | $299 | Self-hosted Postiz vs vendor |
| Attribution | $0 | $0 | $2,200 | Kochava free tier vs paid MMP |
| Observability + misc | $18 | $41 | $100 | |
| **Total** | **$291** | **$870** | **$6,134** | |
| Creator data (Modash) | — | +$2,183 | +$2,183 | $26,200/yr, Phase 5 only |

**Realistic expected run rate: ~$870/month for Phases 1–4, ~$3,050/month once creator sourcing is live.**

Three observations:

- **Data acquisition dominates in every scenario**, and it is controlled almost entirely by two decisions: deriving metrics from listing payloads (§4.2, a 4× swing) and hot-tier poll cadence (§4.3, a 2× swing). Both are schema-level choices made in week 3.
- **The AI line is a rounding error done right and a disaster done wrong** — $21 versus $1,615 for the same work, purely from model selection and batching.
- **Modash's $16,200 + $10,000 annual floors are the single largest discrete commitment** in the plan, and they gate Phase 5 entirely. There is no cheaper legitimate path with readable docs and a rate card. If creator sourcing is not certain, defer it.

**Off-the-shelf comparison.** The closest single product is Exolyt at **$950/month** for 300 tracked accounts and 300 hashtags **[VERIFIED]** — but its pricing page does not state that any tier includes API access, and without API access you cannot join it to install and revenue data, which defeats the purpose. A realistic buy-side bundle (Exolyt Advanced + 2 Sprout seats + Buffer) floors at **~$1,430/month** and more likely runs $2,200–$2,850.

So buying costs roughly 1.6–3× building, **and still cannot deliver the three things Goodfor actually asked for**: age-matched robust z-score alerting on a 15-minute cadence (commercial tools refresh at 12–24 hours), format clustering over competitor content, and a join from TikTok video to app install to subscription revenue. The build case is sound — but it rests on those three capabilities being genuinely wanted, not on cost.

---

## 14. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Third-party data collection breaches TikTok ToS** | High | Logged-out only; isolated infrastructure; vendor-sourced; named legal sign-off before Phase 1; abstraction layer for rapid vendor swap |
| 2 | **Scraping jeopardises the authenticated API client** | High | Absolute separation of read and write planes (§1.3). Never scrape from Goodfor accounts or associated IPs |
| 3 | **Audit rejection — the product is a named prohibited category** | High | Ship the draft/inbox path (§8.1A); do not describe the product as an internal multi-account uploader |
| 4 | **Silent FYF suppression from replicated content** | High | Format-not-asset rule enforced in the pipeline; Account Check ingestion; suppression detector (§8.5) |
| 5 | **Vendor view counts disagree, invalidating every score** | High | Bake-off in Phase 0 before the schema is fixed (§4.5) |
| 6 | **Disclosure failure** — FTC $53,088/violation, CMA up to 10% of global turnover | High | Non-bypassable region-aware disclosure gate; UK-standard creative by default |
| 7 | **Expired usage licence on a live paid ad** | Medium-High | `rights_grant` table in v1 with `licence_end` alerting |
| 8 | **Vendor concentration** — EnsembleData or the publishing vendor disappears | Medium | ScrapeCreators failover at zero carrying cost; two publishing implementations from day one |
| 9 | **US divestiture changed the algorithm** | Medium | Partition all benchmarks on pre/post 22 Jan 2026 and US/non-US; never pool |
| 10 | **EU AI Act Art. 50 marking duty** (live since 2 Aug 2026) | Medium | Separate machine-readable marking from TikTok's toggle if marketing into the EU |
| 11 | **Refresh-token race loses account access permanently** | Medium | Advisory lock across refresh; proactive T−6h cron; retain previous token one generation |
| 12 | **Mio (C-580/23) recognisability standard** may narrow EU replication headroom | Medium | Read both 2025–26 judgments before finalising EU replication policy |
| 13 | **Attribution cadence conflict** — >2 posts/account/day breaks identification | Medium | Conscious decision at §10.5; more accounts rather than more posts |
| 14 | **MMP converts free organic into billable conversions** | Low-Medium | Kochava free tier first; written confirmation on owned-media billing |

### The honest gaps

Things this research could not establish, that matter:

- **Brand-account hit rate, time-to-first-viral, and videos-per-week-to-traction.** No published source. You will discover these from your own data in Phase 1, and until then any content-volume plan is a guess.
- **Whether a vendor's audit genuinely extends to its customers.** Asserted only by vendors selling that arrangement.
- **Whether Search is broken out as a traffic source in TikTok analytics in 2026.** The suppression detector depends on it.
- **Whether the per-client 24-hour cap can be raised post-audit without re-audit.**
- **Any controlled experiment on duplicate-content reach suppression.** Every quantitative claim traces to a vendor with a commercial interest.
- **Organic TikTok CPI.** Published nowhere. Compute it in-house from a pause test.
- **The two decided EU copyright judgments' holdings** (Mio, Pelham II).

Where research budgets were exhausted mid-topic, the absence of a figure is weaker evidence than usual that none exists. Those points are marked in the source appendix.

---

## 15. Phasing

### Phase 0 — Foundations (weeks 1–2)
Vendor bake-off across EnsembleData, ScrapeCreators and Apify on 100 identical videos within one hour, measuring view-count disagreement and freshness. Legal sign-off on §11 with a named owner. TikTok developer app registration. **Submit the Accounts API Access Application Form** — blocking since 20 March 2026 and sequential to app submission. Register the Business account estate. Decide the account-type split.

**Exit criteria:** a signed risk acceptance, a chosen primary vendor with measured accuracy, and the Accounts API form submitted.

### Phase 1 — See (weeks 3–6)
Ingestion with age-adaptive polling and centralised Redis token bucket. Wide snapshot table on Timescale. Robust z-score scoring with age matching. Alert queue at z ≥ 2.5, age ≤ 12h, views ≥ 10,000, α > 0. Basic Next.js dashboard.

**Instrument the real poll count in week 1 of this phase** and re-derive the data budget from it rather than from §4.3's arithmetic.

**Exit criteria:** competitor outperformance alerts firing within 15 minutes of detection, with a measured false-positive rate.

### Phase 2 — Understand (weeks 7–10)
Groq ASR. Gemini vision on two lanes (sync for alerts, batch for corpus). Text embeddings into pgvector. Weekly BERTopic re-fit, daily `approximate_predict` assignment. Hook classification with constrained enums. vPDQ dedupe at D≈20.

**Exit criteria:** a format taxonomy derived from real competitor content, and a hook-type distribution with per-type performance.

### Phase 3 — Act (weeks 11–14)
Brief generation from alerts. Non-bypassable compliance gate: disclosure, sound licensing validated against `account_type`, competitor-claim review queue. Draft/inbox publishing. Anti-spam governor. Account health monitoring. **Own audit submitted in parallel.**

The new Branded Content Policy takes effect 31 August 2026, mid-phase — build to it, not to the current one.

**Exit criteria:** a competitor video detected, briefed, produced, compliance-gated and published within one working day.

### Phase 4 — Attribute (weeks 15–18)
Android Play Install Referrer with per-video `utm_content`. Per-account bio links with a timestamped rotation log. HDYHAU post-paywall with thumbnail follow-up. Apple Analytics Reports API as a daily control total, loaded idempotently. Custom Product Pages mapped to content formats. First single-channel pause test.

**Exit criteria:** a defensible organic CPI computed from an incrementality test, not from a click model.

### Phase 5 — Scale creators (weeks 19–24)
Modash integration (capture credibility at search time). Creator CRM with collaboration-level pipeline. Outreach: DM first touch, email cadence at day 2 and day 5, terminal at day 28. Rights and payment tracking with `licence_end` alerting. Spark Ads via Business Center account linking.

**Exit criteria:** creators sourced, contracted, delivering, and attributed to installs — with no expired licences live.

---

## 16. Source and verification appendix

**Method.** Two research fleets (131 agents, ~2,500 tool calls) with adversarial verification. The first ran 3-vote refutation on 25 extracted claims; 13 were killed, mostly because TikTok's domains block automated fetchers and the quotes could not be substantiated through the harness. The second ran 12 targeted deep-dives, each followed by a dedicated fact-checker tasked with refuting or correcting its numbers: 129 verdicts returned, of which **24 were corrections and 12 were unsupported**.

**Direct verification.** The load-bearing TikTok platform claims in §2 were re-retrieved and confirmed first-hand outside the agent harness, via the `r.jina.ai` text-extraction proxy after `developers.tiktok.com` and `www.tiktok.com` refused both direct fetch and browser navigation. Confirmed this way: Research API commercial ineligibility (FAQ and Research Tools ToS), the unaudited-client restrictions and the manual public-recovery path, the 600/min sliding-window rate table, and the Direct Post rate limits, caption limits, privacy enum and error codes.

**Retrieval integrity caveat.** No TikTok quote in this document was read off a live page in a browser. Cross-checks were consistent and several were confirmed through two independent paths, but **before engineering time is committed, a human should re-verify the §2 quotes in a real browser.**

### Corrections applied that would have cost real money

| Wrong figure that was circulating | Corrected |
|---|---|
| Gemini video `media_resolution_low` saves 3× | Gemini 3 **already defaults to 70 tokens/frame**; the suggested "optimisation" is a 2.1× cost **increase** |
| Max video file size 10 GB | **4 GB** |
| Min resolution 540×960 | **360 px** both dimensions |
| Deepgram batch is 3–5× Groq | **11.6×** — the source proxy misaligned pricing columns |
| Temporal ~$571/mo at this volume | **~$531** — the plan's included actions were not subtracted |
| Mio C-580/23 and Pelham II pending | **Both decided** (5 Dec 2025 and 14 Apr 2026) |
| Commercial Music Library has 150,000 tracks | **1,000,000** — TikTok's own figure |
| Spark Ads "+43% conversion rate" | **Unsupported** — traces to one listicle whose own arithmetic is broken |
| "15–25 posts/account/day" | **No official source for 25.** Design against 15 |
| Pre-audit posts can never be made public | **False** — TikTok documents the manual recovery path |
| 0.6745 makes MAD a consistent estimator of σ | That constant is **1.4826**; 0.6745 = Φ⁻¹(0.75) |
| UGC nano TikTok $150–$400 | **$200–$500** at the cited source; several adjacent tier figures existed nowhere |

### Where the evidence is weakest

**UGC creator rates** (§9.2) — seven claims unsupported at their cited sources, seven wrong. Treat as negotiating ranges only.
**Hook retention benchmarks** (§6.5) — every published figure is an undated marketing blog, and they contradict each other. Derive in-house.
**Link-in-bio CTR** (§10.6) — one Substack post, no sample size, uncorroborated. The organic CPI derivation rests on it.
**Cold-start mechanics** — test cohort sizes, evaluation windows and completion thresholds all circulate in mutually contradictory forms with no primary source. Build against the account's own same-age distribution instead.
**Multi-account ban thresholds** (§8.4) — uniformly vendor-sourced from companies selling the countermeasures.

### Primary sources

TikTok: `developers.tiktok.com` (content-sharing-guidelines, content-posting-api-reference-direct-post, media-transfer-guide, research-api-faq, tiktok-api-v2-rate-limit, oauth-user-access-token-management, display-api), `tiktok.com/legal` (ToS 1 Dec 2025, Research Tools ToS, Branded Content Policy), `tiktok.com/community-guidelines` (fyf-standards), Creator Academy originality policy, `tiktok.com/transparency` (recommendation-system, DSA reports), TikTok Newsroom (AI content).

Vendors (rate cards, authoritative for price only): ensembledata.com, scrapecreators.com, apify.com, brightdata.com, modash.io, hypeauditor.readme.io, groq.com, ai.google.dev, platform.claude.com, assemblyai.com, deepgram.com, runpod.io, clickhouse.com, temporal.io, trigger.dev, ayrshare.com, postiz.com, appsflyer.com, singular.net, tenjin.com, kochava.com, collabstr.com, joinbrands.com, insense.pro, exolyt.com.

Standards and law: `developer.apple.com` (Analytics Reports API, privacy noise, campaign links, Custom Product Pages), `developer.android.com` (Install Referrer), Rentmeester v Nike 883 F.3d 1111, Hanagami v Epic Games, Banner v Endemol [2017] EWHC 2600 (Ch), 16 CFR Parts 255 and 465, ASA/CAP guidance, EU AI Act Art. 50, DMCCA 2024.

Research: Iglewicz–Hoaglin modified z-score, Szabó–Huberman arXiv:0811.0405, Miotto–Altmann arXiv:1403.3616, Althoff et al. arXiv:1405.7452, KInIT arXiv:2504.18140 (TikTok audit reproducibility), Twitter S-H-ESD, Kleinberg burst detection, BERTopic best practices, Facebook vPDQ.

---

*Prepared 6 August 2026. Platform terms, audit criteria, vendor pricing and per-client caps all change without notice. Re-verify §2 and §13 before committing engineering time.*
