# Goodfor TikTok Machine — Deploy Runbook

> How the Goodfor "signal" system ships to production on **Fly.io** + **Supabase**.
> Read [`00-ARCHITECTURE.md`](./00-ARCHITECTURE.md) §2 (read plane vs write plane)
> and §5 (tech stack) first — this runbook is the operational expression of the
> plane-isolation rule those sections establish.
>
> Configs: [`../deploy/fly/fly.dashboard.toml`](../deploy/fly/fly.dashboard.toml) ·
> [`../deploy/fly/fly.read.toml`](../deploy/fly/fly.read.toml) ·
> [`../deploy/fly/fly.write.toml`](../deploy/fly/fly.write.toml).
> Env template: [`../.env.example`](../.env.example).

---

## 1. Deployment model — three apps, two planes, one database (and WHY)

The system deploys as **three separate Fly.io apps** that share **only** the
Supabase Postgres. This is not an aesthetic choice — it is the single
highest-value risk control in the whole system (§1 "cardinal rule", §8 rule 5).

| Fly app | Plane | Runs | Secret bundle | Config |
|---|---|---|---|---|
| `goodfor-signal-read` | **READ** | worker-read (poll, trends) + worker-analyse (analyse, refit, poll-batch) | Vendor + AI + Supabase — **no** TikTok/token keys | `fly.read.toml` |
| `goodfor-signal-write` | **WRITE** | worker-write (publish/reconcile/health/**token-refresh**) + worker-attribute (attribute/apple) + worker-creators (creators/outreach/licence) | TikTok + token + MMP + creator keys + Supabase — **no** vendor keys | `fly.write.toml` |
| `goodfor-signal-dashboard` | READ (surface) | Next.js console | Supabase only | `fly.dashboard.toml` |

**Why the read and write planes must never touch.** The READ plane runs entirely
on **purchased third-party data** because TikTok's Research API — the only
official competitor-data surface — is categorically closed to commercial users
(§1, Constraint 1). It is therefore assumed to attract a Terms-of-Service /
scraping complaint eventually, and must be treated as **disposable**. The WRITE
plane holds the one thing that actually ships Goodfor's videos: the
OAuth-authenticated TikTok Content Posting API client and its encrypted tokens.

> **If a scraping complaint on the read side could reach the write side's OAuth
> tokens, one complaint could suspend publishing, attribution, and the creator
> CRM at once.** Physical separation caps the blast radius: worst case the read
> app is torn down and rebuilt behind a vendor/IP swap while publishing keeps
> running, untouched.

On Fly this separation is **physical**: two different apps means two different
sets of machines, two different secret vaults, and two different egress IPs. To
make the "disposable read plane" property real, allocate a **dedicated egress
IP** to each plane so the read IP can be burned and rotated without touching the
write plane:

```bash
fly ips allocate-v4 --app goodfor-signal-read     # rotatable / disposable
fly ips allocate-v4 --app goodfor-signal-write    # protected, long-lived
```

For even stronger egress separation, run the read app in a **different region**
from the write app (edit `primary_region` in `fly.read.toml`). The two planes
share exactly one thing — the Supabase Postgres — and that is deliberate: it is
the shared substrate the read-only dashboard reads from (§2).

**What crosses the boundary.** Only distilled, non-copyrightable *findings*
(briefs, hook taxonomy, z-scores, trend states) — persisted to Postgres by the
read plane, read back by the write plane. **Never** competitor video files,
audio, captions, or verbatim text. The database is the seam; it carries findings,
not assets.

---

## 2. Secrets — the exact `fly secrets set` groups per app

Secrets are **referenced by name only** in the `.toml` configs and set out of
band with `fly secrets set`. Never commit real values (see `.env.example`).
The cardinal invariant, enforced by boot guards (§3):

> **Never co-locate `ENSEMBLEDATA_TOKEN` with `TIKTOK_CLIENT_SECRET`.**
> Vendor read-plane keys and TikTok write-plane keys must live in different
> secret vaults, on different apps.

### 2a. Shared by ALL three apps

Both planes and the dashboard persist to / read from the same Supabase Postgres
via the service-role client (`packages/db` → `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`).

```bash
# Run for EACH app (goodfor-signal-read, -write, -dashboard):
fly secrets set --app <app> \
  SUPABASE_URL="https://<project-ref>.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
```

### 2b. READ plane only — `goodfor-signal-read`

Vendor data + AI provider keys + the egress token-bucket Redis. **No TikTok, no
token-encryption key.**

```bash
fly secrets set --app goodfor-signal-read \
  ENSEMBLEDATA_TOKEN="<...>" \
  APIFY_TOKEN="<...>" \
  SCRAPECREATORS_API_KEY="<...>" \
  GROQ_API_KEY="<...>" \
  GEMINI_API_KEY="<...>" \
  OPENAI_API_KEY="<...>" \
  REDIS_URL="redis://<...>"        # Lua token-bucket egress throttle (§5)
# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from §2a.
# PYTHON_BIN is a non-secret [env] value in fly.read.toml, not a secret.
# APIFY_TOKEN is the PREFERRED media source: analyse fetches playable video via
#   Apify (its own quota, separate from EnsembleData's daily unit cap); listings
#   stay on EnsembleData. With both set, createSource() = EnsembleData + Apify-media.
```

### 2c. WRITE plane only — `goodfor-signal-write`

TikTok publishing + token encryption + attribution (Kochava, Apple) + creator
CRM (Modash, HypeAuditor, Business). **No vendor read-plane keys.**

```bash
fly secrets set --app goodfor-signal-write \
  TIKTOK_CLIENT_KEY="<...>" \
  TIKTOK_CLIENT_SECRET="<...>" \
  TIKTOK_REDIRECT_URI="https://<host>/api/auth/tiktok/callback" \
  TIKTOK_SCOPES="user.info.basic,video.list,video.upload" \
  TOKEN_ENCRYPTION_KEY="<openssl rand -base64 32>" \
  TIKTOK_BUSINESS_APP_ID="<...>" \
  TIKTOK_BUSINESS_SECRET="<...>" \
  KOCHAVA_API_KEY="<...>" \
  KOCHAVA_APP_GUID="<...>" \
  APP_STORE_CONNECT_KEY_ID="<...>" \
  APP_STORE_CONNECT_ISSUER_ID="<...>" \
  APP_STORE_CONNECT_PRIVATE_KEY="<.p8 PEM, or _B64 variant>" \
  MODASH_API_KEY="<...>" \
  MODASH_BASE_URL="<...>" \
  HYPEAUDITOR_API_TOKEN="<...>" \
  HYPEAUDITOR_BASE_URL="<...>" \
  TIKTOK_DM_ACCESS_TOKEN="<...>" \
  OUTREACH_EMAIL_API_KEY="<...>" \
  TIKTOK_BUSINESS_ACCESS_TOKEN="<...>"
# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from §2a.
# Phase 5 creator keys (MODASH_*/HYPEAUDITOR_*/outreach/business) can be added
# when that phase goes live — the creators worker fails soft on a missing key.
```

### 2d. Dashboard — `goodfor-signal-dashboard`

**Supabase only** (§2a). The dashboard is a read-only console; it holds neither
vendor keys nor TikTok keys. `GET /api/status` proves this: it only issues
head-count reads against the shared DB.

### The forbidden co-locations (spell them out to catch a copy-paste slip)

| App | MUST have | MUST NOT have |
|---|---|---|
| `goodfor-signal-read` | `ENSEMBLEDATA_TOKEN`, `SCRAPECREATORS_API_KEY`, `GROQ/GEMINI/OPENAI`, `REDIS_URL`, `SUPABASE_*` | `TIKTOK_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` (and all other write-plane keys) |
| `goodfor-signal-write` | `TIKTOK_*`, `TOKEN_ENCRYPTION_KEY`, `KOCHAVA_*`, `APP_STORE_CONNECT_*`, `MODASH_*`, `HYPEAUDITOR_*`, `SUPABASE_*` | `ENSEMBLEDATA_TOKEN`, `SCRAPECREATORS_API_KEY` |
| `goodfor-signal-dashboard` | `SUPABASE_*` | everything else |

---

## 3. Boot guards — the enforcement, and what happens on violation

Every worker asserts its plane at boot, **right after `loadEnv()`**, before it
does any work. The guards import nothing from the other plane's packages — the
two planes share no code, so the check cannot be silently broken by a refactor.

| Plane | Guard | Where | Trips when it sees | On trip |
|---|---|---|---|---|
| READ | `assertReadPlane()` (inline) | `apps/worker-read/src/tick.ts` | `TIKTOK_CLIENT_SECRET` **or** `TOKEN_ENCRYPTION_KEY` non-empty | `throw` → process exits non-zero, never runs |
| WRITE | `assertWritePlane()` | `apps/worker-write/src/guard.ts`, `worker-attribute/src/guard.ts`, `worker-creators/src/guard.ts` (called from each `deps.ts`) | `ENSEMBLEDATA_TOKEN` **or** `SCRAPECREATORS_API_KEY` non-empty | `throw` → process exits non-zero, never runs |

A **blank** value (e.g. `ENSEMBLEDATA_TOKEN=` copied straight from
`.env.example`, which dotenv materialises as `""`) is treated as *absent* — only
a real, non-empty value is a violation. That keeps the template harmless while
still catching a genuine cross-plane secret leak.

**What a violation looks like in practice.** If someone sets
`ENSEMBLEDATA_TOKEN` on `goodfor-signal-write`, the very next deploy's
`publish`/`attribute`/`creators` machines crash at boot with, e.g.:

```
[worker-write] plane isolation violation: read-plane env var(s) present in the
write plane: ENSEMBLEDATA_TOKEN. ... Remove the read-plane credentials from this
process before starting it.
```

Fly's health/restart supervisor sees the machine fail to stay up and the deploy
does **not** go healthy — you get a **loud, deploy-blocking failure**, exactly as
intended. The fix is `fly secrets unset ENSEMBLEDATA_TOKEN --app
goodfor-signal-write` and redeploy. The guard is fail-closed: a plane-crossing
service never serves traffic.

> Note: `worker-analyse` runs on the read app and shares its read-plane-only
> secret bundle, so it inherits the isolation by virtue of the app boundary
> (it never receives a write-plane key to leak). The symmetric `assertReadPlane`
> in `worker-read` is what actively fails the read app if a write key appears.

---

## 4. The Python sidecar (worker-analyse only)

`worker-analyse` is the only component that is not pure Node. Its clustering and
near-duplicate steps shell out to Python and ffmpeg (§5 ASR/Vision/clustering):

- **ffmpeg** on `PATH` — audio + keyframe extraction (`packages/media`).
- **Python 3.11/3.12** with `scripts/analysis/requirements.txt`:
  `numpy`, `umap-learn`, `hdbscan`, `joblib` (→ `cluster.py`, UMAP→HDBSCAN),
  and `pdqhash` (→ `vpdq.py`, true PDQ-256; falls back to a numpy DCT otherwise).

**Do not use Python 3.14** — the numba stack under umap-learn/hdbscan has no
wheels for it (see the header of `scripts/analysis/requirements.txt`).

Both must be baked into **`deploy/Dockerfile.read`** (the parallel Dockerfile
task owns that file). The image should create a dedicated venv and install the
requirements, e.g.:

```dockerfile
# in deploy/Dockerfile.read (illustrative — owned by the Dockerfile task)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3.12 python3.12-venv \
 && python3.12 -m venv /opt/venv \
 && /opt/venv/bin/pip install -r scripts/analysis/requirements.txt
```

The workers find the interpreter through **`PYTHON_BIN`**, which
`fly.read.toml` sets to `/opt/venv/bin/python` in `[env]` (the clustering/vpdq
providers default to `python3` otherwise). The write and dashboard images need
**neither** Python nor ffmpeg — keep them slim, Node-only.

Smoke-test the sidecar wiring after a read deploy:

```bash
fly ssh console --app goodfor-signal-read -C "npm run smoke"
```

---

## 5. Database migrations (run before the first worker deploy)

Both planes persist to one Supabase Postgres; the schema is the shared
substrate, so migrations run **once, centrally**, from an operator machine —
**not** from a worker. The SQL lives in `supabase/migrations/` (§4:
`init_tiktok_core`, `partition_maintenance`, `tracked_terms`, `analysis`).

```bash
# One-time, from the repo root, against the linked project:
supabase link --project-ref <project-ref>     # first time only
supabase db push                              # or: npm run db:push  (supabase db push --linked)
```

`partition_maintenance` installs the `pg_cron` job `ensure_metric_partitions()`
that keeps `video_metric_snapshot` partitioned ~3 months ahead — no external
scheduler needed. Confirm it is scheduled after the push:

```sql
select jobname, schedule from cron.job;   -- expect ensure_metric_partitions
```

Regenerate typed bindings if the schema changed: `npm run db:types`. **Order:**
migrate first, then deploy workers — a worker booting against a missing table
just errors on its first tick.

---

## 6. Deploy commands, scaling, and the anti-spam caveat

### 6a. First deploy (order matters)

```bash
# 0) migrate (§5), then set secrets (§2) on all three apps.
# Run every deploy from the REPO ROOT so the Docker build context is the monorepo.
fly deploy --config deploy/fly/fly.read.toml
fly deploy --config deploy/fly/fly.write.toml
fly deploy --config deploy/fly/fly.dashboard.toml
```

Each `[processes]` group becomes its own machine. **But** several groups are
**one-shot cron jobs** (they run `main()` once and exit 0): they must **not** be
left as always-on machines, or Fly's supervisor restarts them in a tight
loop — hammering the DB (`health`) or TikTok (`reconcile`). Only the loops
(`setInterval`) stay always-on.

| Group | App | Kind | Always-on? |
|---|---|---|---|
| `poll` | read | 60s loop | **yes, count = 1** |
| `trends` | read | 5-min loop | yes, count = 1 |
| `analyse` | read | 60s drain loop | yes, count ≥ 1 (scalable) |
| `analyse-refit` | read | weekly one-shot | **no — scheduled** |
| `analyse-batch` | read | one-shot | **no — scheduled** |
| `publish` | write | 60s loop | **yes, count = 1 (never more — see 6c)** |
| `attribute` | write | 60s loop | yes, count = 1 |
| `creators` | write | 60s loop | yes, count = 1 |
| `reconcile`, `health` | write | one-shot | **no — scheduled** |
| `attribute-apple` | write | one-shot | **no — scheduled** |
| `creators-outreach`, `creators-licence` | write | one-shot | **no — scheduled** |

### 6b. Set counts + schedules after the first deploy

```bash
# READ: always-on loops; scale the one-shots to zero.
fly scale count poll=1 trends=1 analyse=1 analyse-refit=0 analyse-batch=0 --app goodfor-signal-read

# WRITE: always-on loops; scale the one-shots to zero.
fly scale count publish=1 attribute=1 creators=1 \
  reconcile=0 health=0 attribute-apple=0 creators-outreach=0 creators-licence=0 \
  --app goodfor-signal-write
```

Run each one-shot on a schedule with a **scheduled Machine** (Fly runs the
group's command on the given cadence, then the machine stops):

```bash
# read plane
fly machine run --schedule weekly  --app goodfor-signal-read  --process-group analyse-refit
fly machine run --schedule hourly  --app goodfor-signal-read  --process-group analyse-batch
# write plane
fly machine run --schedule hourly  --app goodfor-signal-write --process-group reconcile
fly machine run --schedule hourly  --app goodfor-signal-write --process-group health
fly machine run --schedule daily   --app goodfor-signal-write --process-group attribute-apple
fly machine run --schedule daily   --app goodfor-signal-write --process-group creators-outreach
fly machine run --schedule daily   --app goodfor-signal-write --process-group creators-licence
```

(Fly's native schedules are `hourly`/`daily`/`weekly`/`monthly`. If you need a
finer cadence — e.g. reconcile every few minutes — trigger `fly machine run`
from an external cron instead.)

### 6c. Scaling notes — and the one-posting-system-per-account caveat

- **`publish` is horizontally UN-scalable — keep it at exactly 1.** The anti-spam
  governor enforces **≤12 posts/account/24h** and **≤4 in-flight uploads**
  (§3 "Act", §8 rule 6/anti-spam). Two `publish` instances race that governor and
  double-post, breaching TikTok's own per-account limits and the compliance
  posture the whole write plane exists to protect. **One posting system per
  account, full stop.** The same applies to `poll`: it is a single 60-second
  `due_at` drain — a second instance double-polls and double-spends vendor units
  (the $200-vs-$800 cost line, §7). Keep `poll` at 1.
- **`analyse` is the safe place to scale out.** It drains `analysis_queue` with
  idempotent, slot-floored writes (`ON CONFLICT DO NOTHING`), so multiple
  instances cooperate without double-paying for vision. Raise `analyse` count (or
  its `[[vm]]` size in `fly.read.toml`) when the queue backs up — vision is the
  cost driver, so scale on queue depth, not CPU.
- **Scale by memory, not count, for the write-plane loops** (`attribute`,
  `creators`): they are single-owner tickers; bump the shared `[[vm]]` memory in
  `fly.write.toml` rather than adding instances.
- **Dashboard** stays at `min_machines_running = 1`; it is an internal console.

---

## 7. Local development (docker-compose)

Local dev mirrors the plane split without Fly. The two planes still run as
**separate processes with separate env files** so the boot guards are exercised
exactly as in prod — a plane-crossing `.env` fails locally too.

- Redis (read-plane token bucket) and, optionally, a local Postgres come from
  `docker-compose`:

  ```bash
  docker compose up -d redis            # + postgres if not using the Supabase project
  ```

- Copy `.env.example` → `.env.local` and fill it in. Keep the read-plane vars and
  the write-plane vars conceptually separate; when running a write worker, make
  sure `ENSEMBLEDATA_TOKEN`/`SCRAPECREATORS_API_KEY` are **blank or unset**, and
  vice-versa — otherwise the guard throws (which is the point).
- Run each plane in its own shell:

  ```bash
  npm run poll            # read-plane ingest loop     (worker-read)
  npm run trends          # read-plane trend loop
  npm run analyse:once    # read-plane analysis, single pass (needs PYTHON_BIN + ffmpeg)
  npm run publish:once    # write-plane publish, single pass (worker-write)
  npm run attribute:once  # write-plane attribution, single pass
  npm run dev             # dashboard on http://localhost:3000
  ```

- The `--once` / `:once` variants run a single tick and exit — ideal for local
  iteration and for exercising the same code path the scheduled Machines run in
  prod. The Python sidecar is set up per `scripts/analysis/requirements.txt`
  (create the 3.12 venv, `pip install -r`, export `PYTHON_BIN`).

Migrations against a local Postgres use the same `supabase db push`; against the
shared Supabase project, prefer running migrations from one operator machine
(§5) so two developers don't race the schema.

---

## Appendix — secret-group quick reference

| Variable(s) | read | write | dashboard |
|---|:--:|:--:|:--:|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | ✅ | ✅ | ✅ |
| `ENSEMBLEDATA_TOKEN`, `SCRAPECREATORS_API_KEY` | ✅ | ⛔ | ⛔ |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` | ✅ | ⛔ | ⛔ |
| `REDIS_URL` | ✅ | ⛔ | ⛔ |
| `PYTHON_BIN` *(non-secret `[env]`)* | ✅ | — | — |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI`, `TIKTOK_SCOPES` | ⛔ | ✅ | ⛔ |
| `TOKEN_ENCRYPTION_KEY` | ⛔ | ✅ | ⛔ |
| `TIKTOK_BUSINESS_APP_ID`, `TIKTOK_BUSINESS_SECRET`, `TIKTOK_BUSINESS_ACCESS_TOKEN` | ⛔ | ✅ | ⛔ |
| `KOCHAVA_API_KEY`, `KOCHAVA_APP_GUID` | ⛔ | ✅ | ⛔ |
| `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY` | ⛔ | ✅ | ⛔ |
| `MODASH_API_KEY`, `MODASH_BASE_URL`, `HYPEAUDITOR_API_TOKEN`, `HYPEAUDITOR_BASE_URL` | ⛔ | ✅ | ⛔ |
| `TIKTOK_DM_ACCESS_TOKEN`, `OUTREACH_EMAIL_API_KEY` | ⛔ | ✅ | ⛔ |

✅ set · ⛔ must **not** be present (boot guard fails the deploy) · — n/a
