# Phase 3 — Act (Publishing) (weeks 11–14)

> The **write plane**. This is the legally sensitive phase: the product's exact shape —
> "a utility tool to help upload contents to the account(s) you or your team manages" —
> is a **verbatim-prohibited TikTok app category**. Phase 3 does not fight that; it routes
> around it by shipping the **draft/inbox** path (`video.upload` scope, **not audit-gated**),
> keeping a human's tap in the loop, and baking disclosure into a **non-bypassable gate**.
> See [../00-ARCHITECTURE.md](../00-ARCHITECTURE.md) for the two-plane diagram and
> [../UI-UX-DASHBOARD.md](../UI-UX-DASHBOARD.md) for the composer/review console.

Related docs: [Phase 0 — Foundations](./PHASE-0-foundations.md) (app registration, own-audit start, account-type split) · [Phase 2 — Understand](./PHASE-2-understand.md) (format taxonomy + hook types that feed briefs) · [Phase 4 — Attribute](./PHASE-4-attribute.md) (consumes published-post IDs and per-video `utm_content`).

---

## Goal & definition of done

Stand up the isolated write-plane service that turns a detected outperformer into a published Goodfor post through a compliance gate, on Goodfor's **own** accounts, without ever touching the read plane.

**Definition of done (spec §15 Phase 3 exit):** the loop `detect → brief → produce → gate → publish` completes **within one working day** for at least one Goodfor account, with:

- publishing running through the **draft/inbox** flow (`POST /v2/post/publish/inbox/video/init/`, scope `video.upload`), never Direct Post;
- a **non-bypassable, region-aware disclosure gate** enforced at the database boundary (not just app code);
- sound selection **validated against `account_type`** at brief-generation time;
- competitor-naming scripts routed to a **human substantiation queue**;
- the **anti-spam governor** live (12 posts/account/24h, 4 in-flight uploads, `spam_risk_*` → 24h no-retry quarantine);
- **account-health monitoring** persisting strikes + FYF-suppression signals;
- the **own audit (path C) submitted in parallel** (day-one action, runs through and past this phase).

The **new TikTok Branded Content Policy takes effect 31 August 2026 — mid-Phase-3.** Build to it, not to the pre-August rules.

---

## Current state (what already exists in the codebase for this phase)

**Status: BUILT — code-complete as of 2026-08-16.** `packages/publishing` (token vault, OAuth client that *refuses* `video.publish`, `InboxPublisher`, state machine, governor), `packages/compliance` (region-aware disclosure/sound/claim/AIGC validators), `packages/briefs` (sound-gated brief builder), and `apps/worker-write` (oauth listener, token-refresh cron, tick, reconcile, health, boot guard) are implemented with passing unit tests; the symmetric read-plane boot guard is wired into `worker-read`. Whole monorepo: **typecheck clean, 224 tests green.** Before this runs in production: apply migration `…06` (the DB disclosure trigger only enforces once applied), obtain TikTok `client_key`/`secret` + run the OAuth flow, submit the own-audit (path C), and verify every `// UNVERIFIED` TikTok API shape against the sandbox.

Below is the original starting point (now superseded by the build above):

Phase 3 began as **schema and env template only.** The load-bearing constraints were already respected where they were cheap to lock in:

- **Write-plane tables already exist**, `already implemented in supabase/migrations/20260815000001_init_tiktok_core.sql` (lines 186–250): `owned_account` (with `account_type` CHECK `('business','creator')`, `access_token`/`refresh_token` as `bytea`, `original_granted_at` with the "365 days from initial issuance" comment), `scheduled_post` (status enum `draft|queued|uploading|pending|published|failed|cancelled`, `privacy_level` enum incl. `SELF_ONLY`, `disclosure_type` `('none','your_brand','branded_content')`, `disclosure_verified boolean default false`, `sound_is_cml`, `publish_id`, and TikTok's misspelled `publicaly_available_post_id` kept verbatim), and `account_health` (`strike_count_by_area jsonb`, `fyf_traffic_share`, `originality_status`, `suppression_flag`). RLS is enabled with no policies (service-role only).
  - Two spec/DB naming deltas to carry forward as-built: the migration uses **`disclosure_verified`** (spec §12 wrote `disclosure_text_verified`) and **`app_slug`** (spec §12 wrote `app_id`). Use the migration's names.
- **The scope decision is already baked into `.env.example`** (lines 24–26): `TIKTOK_SCOPES=user.info.basic,video.list,video.upload`. The comment already states `video.upload` = draft/inbox = "NOT audit-gated; the Phase 3 path" and `video.publish` = Direct Post = "audit-gated." `TOKEN_ENCRYPTION_KEY` (32-byte, `openssl rand -base64 32`) and `TIKTOK_CLIENT_KEY/SECRET/REDIRECT_URI` are already declared.

**Everything executable is missing:** no write-plane app, no OAuth/token-crypto code, no publishing state machine, no compliance gate, no brief generation, no governor, no health poller. The `owned_account` / `scheduled_post` / `account_health` tables are **referenced by zero lines of code today.**

---

## Prerequisites (which prior-phase outputs are required)

| From | Required output | Used for |
|---|---|---|
| **Phase 0** | TikTok app registered; `client_key`/`secret` issued; **own audit (path C) submission started day one**; Business estate registered; **account-type split decided** (which handles are `business` vs `creator`) | OAuth, `owned_account` rows, sound-gate correctness |
| **Phase 0** | Named legal sign-off on §11 (replication/disclosure posture) | Authority to publish replicated formats at all |
| **Phase 2** | Format taxonomy (`format_cluster`) + hook-type distribution with per-type performance | Brief generation picks a proven format/hook, not a guess |
| **Phase 1** | Alert queue (outperformers at `z≥2.5, age≤12h, views≥10k, α>0`) | The trigger that opens a brief |
| **Read plane** | Structured findings **only** — a brief carries a format label, hook type, and a link, **never the competitor's video file, audio, or verbatim text** | The plane boundary (§3) |

If Phase 0's audit form / app registration is not done, Phase 3 can still be **built and tested against the sandbox**, but cannot publish to live public accounts.

---

## Tech & tools introduced in this phase (exact technologies/versions)

| Concern | Choice | Note |
|---|---|---|
| Publishing API | **TikTok Content Posting API — Inbox** `POST /v2/post/publish/inbox/video/init/` | Scope `video.upload`; **not audit-gated for public posts** |
| Upload transport | **`FILE_UPLOAD`** chunked `PUT` (preferred) or `PULL_FROM_URL` | `PULL_FROM_URL` needs domain verification → `url_ownership_unverified` |
| Own-account insight | **TikTok API for Business** (`TIKTOK_BUSINESS_APP_ID/SECRET`) | Gated behind the Accounts API Access form (blocking since 20 Mar 2026) |
| Token crypto | **Node `crypto` AES-256-GCM** envelope encryption, key = `TOKEN_ENCRYPTION_KEY` | KMS in prod; ciphertext = `iv ‖ authTag ‖ data` in `bytea` |
| Refresh safety | **Postgres advisory lock** `pg_advisory_xact_lock(owned_account_id)` | Kills the refresh-token race (§14) |
| Queue / scheduler | **`scheduled_for` column + 60s tick** (mirrors worker-read `tick.ts`) | No cron-per-post |
| Rate limiting | **Redis Lua token bucket — SEPARATE instance/namespace from the read plane** | Plane separation extends to Redis |
| Multi-account scheduler (optional) | **Postiz self-hosted (AGPL-3.0), $15/mo** | Run **unmodified** internally only; a customer-facing fork triggers copyleft → use **Mixpost (MIT)** |
| Runtime | Node/TypeScript on **Fly or Railway** — a **separate deployment** from worker-read | Different egress IP, different secret bundle |

**Do not add `video.publish` to the requested scopes yet.** "Requesting scopes you do not demonstrably use is a rejection reason" (§8.1). It joins the scope set only when the own-audit demo actually builds a Direct Post composer.

---

## Work breakdown — ordered, concrete tasks

Create **one new deployment** (`apps/worker-write`) and **three new packages**. Nothing here imports from `apps/worker-read`, `packages/tiktok-source`, or any read-plane credential — that separation is the phase's highest-value control.

### Week 11 — Plane isolation, OAuth, token vault

1. **`apps/worker-write/`** — new app, `@goodfor/worker-write`, `"type": "module"`, deployed as its **own** Fly/Railway service with a **dedicated egress IP**. Its process env loads **only**: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI`, `TIKTOK_SCOPES`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_URL`. It must **never** see `ENSEMBLEDATA_TOKEN` / `SCRAPECREATORS_API_KEY`. Symmetrically, `worker-read` must never see `TIKTOK_CLIENT_SECRET` / `TOKEN_ENCRYPTION_KEY`. Add a boot assertion in each that throws if a foreign-plane var is present.
2. **`packages/publishing/`** — new package `@goodfor/publishing`. Define a `Publisher` interface with **≥2 implementations from day one** (§8.2 mandate): `InboxPublisher` (path A, the real one) and a `VendorPublisher` stub (path B contract only). Contains: the TikTok OAuth client (`authorize` URL builder, `exchangeCode`, `refresh`), the token-crypto module (`sealToken`/`openToken`, AES-256-GCM), and the state-machine driver (below).
3. **OAuth callback → move it out of the dashboard.** `.env.example` ships `TIKTOK_REDIRECT_URI=https://localhost:3000/api/auth/tiktok/callback` as a placeholder. **Repoint it at the write-plane host** and implement the callback as a small HTTPS listener **inside `apps/worker-write`** (`src/oauth.ts`), so the client secret and token exchange live only in the write plane, never in the read-plane dashboard process. Exchange → `sealToken` → store `access_token`/`refresh_token` `bytea` + `access_expires_at` + `refresh_expires_at` + **`original_granted_at = now()`** on the `owned_account` row.
4. **Token vault + refresh cron** (`src/token.ts`): AES-256-GCM envelope encryption; refresh cron at **T−6h** before `access_expires_at`, wrapped in `pg_advisory_xact_lock(owned_account_id)`; **retain the previous token one generation** (`prev_access_token`/`prev_refresh_token`) so a failed rotation is recoverable; compute the **re-auth prompt from `original_granted_at + 365d`**, not from the latest refresh (refresh tokens expire 365 days from *initial* issuance).

### Week 12 — Brief generation + the non-bypassable compliance gate

5. **`packages/compliance/`** — new package `@goodfor/compliance`, the gate. Pure functions + a DB trigger (below). Validates: (a) **disclosure artefact**, (b) **sound vs `account_type`**, (c) **competitor-claim substantiation**, (d) **AIGC realism labelling**.
6. **`packages/briefs/`** — new package `@goodfor/briefs`. `createBrief(alert, formatCluster, targetAccount)` writes a `brief` row. **Sound is gated here, at brief time** (§7.3): if `target_account_type = 'business'`, only Commercial Music Library (`sound_is_cml = true`) sounds are selectable; a trend that depends on a non-commercial sound is **flagged unbuildable on that account before anyone shoots the video.**
7. **Disclosure gate** (`packages/compliance/src/disclosure.ts`): the single compliant artefact is **burned-in "Ad" in the first frame + spoken disclosure + "#ad" leading the caption** (§7.6). Region-aware: `"Sponsored"` passes FTC but **fails ASA**; a hashtag at the end of a caption **fails** (sits behind "See more"). Persist `disclosure_region`, which TikTok in-app toggle was used (`your_brand` for Goodfor promoting Goodfor, `branded_content` for a paid creator), and `appeal_deadline_at = published_at + 24h`.
8. **Competitor-claim queue** (`packages/compliance/src/claims.ts`): any script naming a competitor routes to a **human review queue** with a mandatory per-claim **dated substantiation** field — `"£X vs £Y as at 2026-08-16"`, never "cheaper" (§7.5). No brief with an unverified competitor claim can reach `ready`.
9. **AIGC check**: label when content shows **realistic-looking scenes or people** — trigger is **realism, not AI usage** (§7.4). Set the TikTok AIGC toggle **and** honour EU AI Act Art. 50's independent marking duty if the post targets EU/EEA. **Never** build any watermark-stripping step.

### Week 13 — Publishing state machine + anti-spam governor

10. **State-machine driver** (`packages/publishing/src/statemachine.ts`) — see the algorithm section. `creator_info/query → init (inbox) → upload PUT → status/fetch poll → reconcile`. Log every transition to `publish_attempt`. **Branch on the error-code string, never the HTTP status.**
11. **Reconciliation job** (`apps/worker-write/src/reconcile.ts`): `publish_id → publicaly_available_post_id` only resolves **after** a human taps publish and moderation clears. Poll `scheduled_post_reconcile_idx` (already exists). **Special-case inbox drafts and private posts** — they stay `pending` indefinitely with no webhook; do not let them fill the queue as zombies.
12. **Anti-spam governor** (`packages/publishing/src/governor.ts`): enforce **12 posts/account/24h** (`posts_last_24h`), **4 in-flight uploads/account** (`uploads_in_flight`), and on **any `spam_risk_*` error → 24h `quarantined_until`, do not retry** (retrying escalates toward `spam_risk_user_banned_from_posting`). Honour `X-RateLimit-Remaining`/`X-RateLimit-Reset` dynamically. **One posting system per account** — the ~15/day cap is shared across API clients.
13. **Tick loop** (`apps/worker-write/src/tick.ts`): 60s `setInterval` with `--once`, mirroring `worker-read/src/tick.ts`. Picks up `scheduled_post` rows on `scheduled_post_due_idx`, checks the governor, drives the state machine. Idempotent on `idempotency_key` so queue redelivery cannot double-post.

### Week 14 — Account health, console wiring, audit, hardening

14. **Account-health poller** (`apps/worker-write/src/health.ts`): via TikTok API for Business, persist rolling **90-day strike window per policy area** into `account_health.strike_count_by_area`, and the **FYF-suppression detector** (§8.5): fire `suppression_flag` when For-You traffic share collapses while other sources hold. **Caveat to verify in-app first:** confirm whether **Search is broken out** as a separate traffic source in 2026 analytics before trusting the detector — persist `search_traffic_share` so the check is possible. Ingest **Account Check originality status** per post into `originality_status`.
15. **Console pages** (`apps/dashboard`, new write-plane section — see [../UI-UX-DASHBOARD.md](../UI-UX-DASHBOARD.md)): brief review, compliance-gate checklist, the one-tap "send to inbox" action, per-account health. The dashboard reads/writes via the service role **but never holds `TIKTOK_CLIENT_SECRET` or `TOKEN_ENCRYPTION_KEY`** — it marks `disclosure_verified` and enqueues; `worker-write` alone performs token handling and API calls.
16. **Submit the own audit (path C)** if not already in flight from Phase 0: PDF UX mockups + the 10-step screen recording (authorisation, composer with nickname, privacy selector with **no default**, Duet/Stitch/Comment toggles unchecked, disclosure toggling, consent-text changes, preview, publish, live verification). Budget multiple rounds; it runs in parallel and does not block path A.
17. **Build to the 31 Aug 2026 Branded Content Policy**: undisclosed branded content triggers an in-app notice within **2–3 hours**; if not disclosed/appealed within **24 hours** it "may then be ineligible for the For You page." The `appeal_deadline_at` SLA (task 7) is the operational hook.

---

## Data model changes

The base write-plane tables exist. Phase 3 adds a `brief` table (the artefact that crosses the plane boundary), an auditable `publish_attempt` log, governor/token columns, region-aware disclosure columns, and the **DB-level non-bypassable gate**.

New migration: **`supabase/migrations/20260815000006_writeplane_publishing.sql`**

```sql
-- The brief is what crosses the plane boundary: a structured finding, never an asset.
create table if not exists brief (
  id                        bigint generated always as identity primary key,
  app_slug                  text not null,
  competitor_inspiration_id bigint references tracked_video(id) on delete set null,
  format_cluster_id         bigint,                    -- Phase 2 format taxonomy
  hook_type                 text,                      -- constrained enum from packages/contracts
  target_account_type       text not null check (target_account_type in ('business','creator')),
  sound_id                  text,
  sound_is_cml              boolean,                   -- gated vs target_account_type AT BRIEF TIME
  competitor_claims         jsonb not null default '[]',  -- [{claim, figure, as_of_date, verified_by}]
  status                    text not null default 'draft'
                              check (status in ('draft','ready','in_production','scheduled','rejected')),
  created_at                timestamptz not null default now()
);

-- One-generation token retention + in-flight governor
alter table owned_account
  add column if not exists uploads_in_flight smallint not null default 0,
  add column if not exists prev_access_token  bytea,
  add column if not exists prev_refresh_token bytea,
  add column if not exists token_generation   integer  not null default 0,
  add column if not exists quarantine_reason  text;

-- Region-aware disclosure + appeal SLA + idempotency + brief FK + spam trace
alter table scheduled_post
  add column if not exists brief_id                 bigint references brief(id) on delete set null,
  add column if not exists disclosure_region        text,          -- 'US' | 'UK' | 'EU' | ...
  add column if not exists tiktok_disclosure_toggle text,          -- which in-app toggle was set
  add column if not exists appeal_deadline_at       timestamptz,   -- published_at + 24h
  add column if not exists idempotency_key          text unique,   -- redelivery cannot double-post
  add column if not exists spam_risk_code           text;

-- Auditable transition log — one row per state-machine step (§11 legal position)
create table if not exists publish_attempt (
  id                bigint generated always as identity primary key,
  scheduled_post_id bigint not null references scheduled_post(id) on delete cascade,
  owned_account_id  bigint not null references owned_account(id),
  step              text   not null,   -- creator_info | init | upload | status_poll | reconcile
  error_code        text,              -- TikTok error-code STRING, never the HTTP status
  http_status       smallint,
  raw_response      jsonb,
  ts                timestamptz not null default now()
);

-- Search-traffic breakout for the suppression detector (verify Search is broken out first)
alter table account_health
  add column if not exists search_traffic_share numeric(5,4);

-- THE NON-BYPASSABLE DISCLOSURE GATE — enforced in the DB, not just app code.
-- Any post that promotes (disclosure_type <> 'none') cannot leave 'draft' without
-- a verified, region-stamped disclosure. App bugs cannot route around this.
create or replace function enforce_disclosure_gate() returns trigger as $$
begin
  if new.status <> 'draft'
     and new.disclosure_type <> 'none'
     and (new.disclosure_verified is not true or new.disclosure_region is null) then
    raise exception
      'disclosure gate: post % cannot advance past draft without verified region-aware disclosure',
      new.id;
  end if;
  return new;
end $$ language plpgsql;

create trigger scheduled_post_disclosure_gate
  before insert or update on scheduled_post
  for each row execute function enforce_disclosure_gate();

alter table brief           enable row level security;
alter table publish_attempt enable row level security;
```

Regenerate types afterward: `npm run db:types` (updates `packages/db/src/database.types.ts`).

---

## Key algorithms & decisions (with the spec's exact thresholds/costs)

### The publishing path — why inbox, restated

The product is a **named prohibited category**. Path A (`inbox/video/init/`, scope `video.upload`) is recommended for v1 because it is **not audit-gated for public posts**, **sidesteps the prohibited-app problem entirely** (a human publishes), and keeps a person in the compliance loop you need anyway — at a cost of **one tap per post**, which §10.5 already wants (≤1–2 posts/account/day). Path B (audited vendor) rests on an **inference, not documented fact** — get written vendor confirmation before relying on it. Path C (own audit) is free, 2–4 weeks/round, and ships **in parallel**. **Recommended: ship A now, submit C day one.** Never describe the app to TikTok as a multi-account uploader (§14 risk 3).

### Publishing state machine

```
creator_info/query  →  init (inbox)  →  upload (PUT)  →  status/fetch poll  →  reconcile
```

- **`creator_info/query` first, on every post.** Returns allowed privacy levels, the creator's Duet/Stitch/Comment settings, and `max_video_post_duration_sec` (can be **below** the 10-min API ceiling for a given account).
- **A 200 is not a publish.** Processing is async; response is `status: pending`, and a post can fail minutes after acceptance. Poll `status/fetch` or reconcile via webhook — mandatory.
- **Private / inbox-draft posts stay `pending` indefinitely** with no webhook until made public — special-case them or the queue fills with zombies.
- **`publicaly_available_post_id`** (TikTok's misspelling, coded verbatim) only returns **after moderation** — the joinable ID does not exist at publish time, hence the reconciliation job.
- **Branch on the error-code string, never the HTTP status:** `url_ownership_unverified` is documented as **400 on one page and 403 on another**.
- **The production trap (§2.3):** `creator_info/query` still lists `PUBLIC_TO_EVERYONE` in `privacy_level_options` and every call returns success, while the post can be **silently coerced to private** on an unaudited client. It works in dev and fails invisibly in prod — **verify actual post visibility out-of-band before trusting a 200.**

### Anti-spam governor (§8.3)

| Control | Value |
|---|---|
| Posts / account / 24h | **12** (headroom under the ~15 guidance) |
| In-flight uploads / account | **4** (under the 5-pending ceiling) |
| Any `spam_risk_*` | **24h quarantine — do NOT retry** (retry escalates toward permanent ban) |
| Caption | Vary per account (caption spam scored separately) |
| Rate headers | Honour `X-RateLimit-Remaining` / `X-RateLimit-Reset` dynamically |

**One posting system per account** — the ~15/day cap is shared across all API clients; a legacy scheduler on the same account causes silent failures.

### Multi-account operation — where NOT to spend (§8.4)

Server-to-server posting authenticates by **OAuth `access_token`, not device fingerprint**. Proxies, antidetect browsers, and "same IP = ban" claims are **vendor marketing, inapplicable by construction** — **zero spend** on them. Spend the entire anti-ban budget on **per-account content differentiation** (different hook, voiceover, opening frames, caption); metadata-only variation does not defeat frame-sequence or audio fingerprinting. The **real** risk is silent **FYF reach suppression** from unoriginal content — instrument it (§8.5), don't buy proxies for it.

### Token refresh race (§14 medium risk)

`pg_advisory_xact_lock(owned_account_id)` around every refresh; run the cron at **T−6h**; **retain the previous token one generation**; compute the re-auth deadline from **`original_granted_at + 365d`**. Losing this race loses the account permanently.

### Replication guardrail carried into every brief (§7.1)

**Replicate formats, never assets.** Re-shoot with Goodfor's own footage/script/on-screen text — that falls outside all four of TikTok's unoriginal buckets (copied, repurposed, spliced, watermarked). **Never reproduce a verbatim script or verbatim on-screen text** (cleanest substantial-similarity evidence). Originality is a **scored FYF input, not a binary gate**; ingest Account Check per post. Apps may not superimpose "link or promotional text" — **no burned-in CTA overlays or link text in the render pipeline** (§7.6).

---

## External dependencies & monthly cost

| Item | Cost/mo | Note |
|---|---|---|
| Publishing (self-hosted Postiz, optional scheduler) | **$15** | AGPL-3.0; run **unmodified** internally only. Path A direct-to-API adds ~$0 marginal beyond compute |
| Vendor path B (only if chosen) | **$49** (Postiz cloud, 30 ch) – **$108** (Zernio) – **$599** (Ayrshare Business) | Price the **account model**, not the tool (5.5× spread) |
| Compute (worker-write, separate deployment) | part of the **$80** Fly/Railway line | Separate service + dedicated egress IP |
| Own audit (path C) | **$0** | Free to apply; budget staff time for multiple rounds |
| Redis (separate write-plane instance/namespace) | part of the **$7–20** queue line | Must not share the read-plane bucket |

Phase 3 whole-system target is **~$600/mo** (§15). The publishing-specific add is small ($15 + a slice of compute); **data acquisition still dominates the bill** from earlier phases.

---

## Risks & guardrails

| Risk (§14) | Severity | Guardrail |
|---|---|---|
| Product is a **named prohibited app category** → audit rejection | High | Ship **inbox/`video.upload`**; never request `video.publish` until the audit demo exists; never describe it as a multi-account uploader |
| **Scraping complaint jeopardises the authenticated API client** | High | **Hard plane separation** — `apps/worker-write` is a separate deployment, separate egress IP, separate secret bundle; boot assertion rejects foreign-plane env vars |
| **Disclosure failure** — FTC **$53,088/violation**, CMA up to **10% turnover** | High | **DB-trigger** non-bypassable region-aware gate; single compliant artefact ("Ad" first frame + spoken + "#ad" leading caption); `appeal_deadline_at = post_time+24h` |
| **Silent FYF suppression** from replicated content | High | Format-not-asset rule; Account Check ingestion; `suppression_flag` detector |
| **Refresh-token race** loses accounts permanently | Medium | Advisory lock + T−6h cron + retain previous token one generation; re-auth from `original_granted_at` |
| **Silent private coercion** on unaudited client (§2.3) | Medium | Verify actual visibility out-of-band before trusting a 200; special-case pending/private in reconcile |
| **New Branded Content Policy live 31 Aug 2026** (mid-phase) | Medium | Build to it; 24h appeal SLA is the operational hook |
| **EU AI Act Art. 50** independent marking duty | Medium | AIGC realism label + machine-readable marking for EU/EEA targets; never strip watermarks |
| **>2 posts/account/day breaks attribution identification** (§10.5) | Medium | Governor caps interplay with Phase 4 cadence; prefer more accounts over more posts |

---

## Acceptance criteria / test plan

1. **End-to-end (phase exit):** a Phase-1 alert produces a brief, a produced video clears the gate, and `worker-write` delivers it to a Goodfor account's inbox where a human publishes — **within one working day**. Verify the published post is actually public **out-of-band** (not just a 200).
2. **Disclosure gate is non-bypassable:** an attempt to advance a `scheduled_post` past `draft` with `disclosure_type <> 'none'` and `disclosure_verified = false` (or null `disclosure_region`) is **rejected by the DB trigger**, not merely by app code. Unit + integration test.
3. **Sound gate:** a `business` brief cannot select a non-CML sound; the system reports "unbuildable on this account" **before** production.
4. **Competitor claim:** a script naming a competitor cannot reach `ready` without a dated substantiation figure.
5. **Governor:** the 13th post in 24h is refused; the 5th in-flight upload is refused; a simulated `spam_risk_*` sets `quarantined_until = now()+24h` and is **not retried**.
6. **Token race:** two concurrent refreshers on one account — only one rotates; the other blocks on the advisory lock; the previous token is retained one generation.
7. **State machine:** branches on error-code strings; `url_ownership_unverified` handled identically whether returned as 400 or 403; reconciliation resolves `publicaly_available_post_id` only post-moderation; private/inbox drafts do not accumulate as zombies.
8. **Plane separation:** assert `worker-write`'s process has **no** `ENSEMBLEDATA_TOKEN`/`SCRAPECREATORS_API_KEY`; assert `worker-read`'s has **no** `TIKTOK_CLIENT_SECRET`/`TOKEN_ENCRYPTION_KEY`. Both boot assertions throw on violation.
9. **Sandbox trap:** confirm the §2.3 silent-private-coercion behaviour in the TikTok sandbox and that the out-of-band visibility check catches it.

---

## Done checklist

Legend: `[x]` built + unit-tested · `[~]` code-complete, needs live TikTok creds / applied migration / sandbox · `[ ]` operational, not code.

- [x] `apps/worker-write` app built (guard/oauth/token/tick/reconcile/health/run); **boot guards reject foreign-plane env vars in BOTH workers** (`worker-write` rejects `ENSEMBLEDATA_TOKEN`/`SCRAPECREATORS`, `worker-read` rejects `TIKTOK_CLIENT_SECRET`/`TOKEN_ENCRYPTION_KEY`) — *deploy as a separate service w/ dedicated egress IP is an ops step*
- [x] `packages/publishing` — `Publisher` interface + `InboxPublisher` (real) + `VendorPublisher` (stub); OAuth client **refuses `video.publish`** (throws)
- [x] OAuth callback lives in `worker-write` (`oauth.ts`); token exchange seals `bytea` tokens + sets `original_granted_at`
- [x] AES-256-GCM token vault (`sealToken`/`openToken`, tamper-tested); refresh cron w/ advisory lock, one-generation retention, re-auth from `original_granted_at + 365d`
- [x] `packages/briefs` — sound gated at brief time vs `account_type` (business ⇒ CML only)
- [x] `packages/compliance` — region-aware disclosure validator (Sponsored fails ASA, trailing-hashtag fails), competitor-claim substantiation, AIGC realism check
- [~] Migration `20260815000006_writeplane_publishing.sql` **written** (incl. the **DB-level disclosure-gate trigger**); types hand-added locally. **Apply with `supabase db push --linked`** — the DB trigger only enforces once applied.
- [x] State-machine driver (`creator_info → init → upload → status → reconcile`); **branches on error-code string**, treats 200 as pending; every step logged to `publish_attempt`
- [x] Reconciliation job resolves `publish_id → publicaly_available_post_id`; private/inbox drafts special-cased (no zombies)
- [x] Anti-spam governor: 12/24h, 4 in-flight, `spam_risk_*` → 24h no-retry quarantine; idempotency enforced
- [x] Account-health poller: 90-day strike window, FYF-suppression detector, `search_traffic_share`, originality — *TikTok Business API shapes `// UNVERIFIED`*
- [ ] Dashboard write-plane console pages (UI follow-up — see `UI-UX-DASHBOARD.md`); dashboard holds no client secret / encryption key
- [ ] Own audit (path C) submitted (operational); `video.publish` kept out of scopes ✓ (enforced in code)
- [~] Built to the 31 Aug 2026 Branded Content Policy; `appeal_deadline_at` SLA columns present
- [~] Phase exit `detect → brief → gate → publish`: code paths complete + unit-tested; live end-to-end needs TikTok creds + applied migration
