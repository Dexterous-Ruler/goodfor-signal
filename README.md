# Goodfor TikTok Machine

Competitor outperformance detection, keyword/hashtag trend tracking, and (later)
multi-account publishing for Goodfor.

Full technical spec: [completion.md](completion.md).

---

## Quick start

```bash
npm install
cp .env.example .env.local     # fill in the blanks
npm run demo                   # backfill a demo account and score it
npm run dev                    # dashboard at http://localhost:3000
```

## Layout

```
apps/
  dashboard/       Next.js — alerts, trends, accounts
  worker-read/     polling, scoring, trend tracking
packages/
  db/              typed Supabase client, generated from the live schema
  scoring/         robust z-score, velocity, trend classification
  tiktok-source/   vendor abstraction (EnsembleData | Fixture)
supabase/
  migrations/      schema, applied with `npm run db:push`
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dashboard on :3000 |
| `npm run seed -- user1 user2` | Register competitor accounts |
| `npm run poll` | Poll loop, every 60s |
| `npm run poll:once` | Single poll pass |
| `npm run trends -- --add hashtag:fyp` | Track a term |
| `npm run trends:once` | Single trend pass |
| `npm run demo` | Backfill synthetic history and score it |
| `npm test` | Scoring test suite |
| `npm run db:push` | Apply migrations |
| `npm run db:types` | Regenerate types from the live DB |

## How detection works

A video is scored against **its own account's other videos at the same age**, in
log space, using median and MAD rather than mean and standard deviation.

```
z = 0.6745 × (ln(views+1) − median(baseline)) / MAD(baseline)
```

Three choices matter, and each has a failure mode attached:

- **Median, not mean.** An account that has already had a viral run inflates its
  own mean and sigma until nothing registers — "masking". That is exactly the
  account you most want alerts on.
- **Age-matched.** Comparing a 3-hour-old video against lifetime totals makes
  every new post look like a failure.
- **Log space.** View distributions are heavy-tailed. In raw space, large
  accounts fire constantly and small-account breakouts never do.

An alert fires when `z ≥ 2.5`, age `≤ 12h`, views `≥ 10,000`, and acceleration
is still positive. That last condition is what separates "act on this" from
"too late" — by the time you could ship a response, a decelerating video is spent.

Velocity and acceleration are measured in a **strictly causal window** — only
snapshots at or before the age being scored. Looking forward makes a climbing
video read as decelerating and silently kills every alert.

Nothing is scored until at least 8 comparable videos exist. A three-video
account with one fluke must not produce a "40× outlier".

## Cost note

Per-video metrics are derived from **profile listing payloads**, never from
per-video metric calls. The listing already carries every video's counts.
Calling per-video costs 2 units each on EnsembleData and moves the bill from
roughly $200/month to $800/month. This constrains the ingestion schema: persist
raw listings and diff them.

## Read plane / write plane

Competitor data collection and publishing must never share infrastructure,
credentials, egress IPs, or TikTok accounts. See completion.md §1.3 and §11.
The read plane carries contract risk with TikTok; the write plane must stay
clean and auditable.

## Known gaps

- `mapEnsembleVideo()` is written from EnsembleData's documented response shape
  but **has never seen a live response**. Verify it on the first real call
  before trusting any score computed from real data.
- No vendor bake-off has been run. Outperformance depends on absolute view-count
  accuracy and no two vendors have been shown to agree. See completion.md §4.5.
- Node 20 needs the `ws` shim in `packages/db`; remove it once on Node 22+.
