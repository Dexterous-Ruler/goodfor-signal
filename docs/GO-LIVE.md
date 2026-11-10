# Go-Live Runbook

Everything is built and the database is live. Going "fully live" just means **turning on real
data sources one at a time**. This guide is ordered **cheapest + fastest value first** — you do
**not** need to do it all at once. Stop whenever you have enough.

**The golden rule:** every secret goes in `.env.local` (which is gitignored — never committed,
never pasted in chat). It already holds your Supabase + AI keys. You edit it, save, and re-run a
command to verify.

**How "verify a wire shape" works** (the `// UNVERIFIED` items): the code was written from each
vendor's docs, not a live call. So the first time you run a command against a real key, the
response *might* have a slightly different field name than expected. If a command errors, **paste
me the error** and I fix the code in minutes. That's the whole loop — set key → run `--once` →
paste any error → I patch. Nothing scary.

| Legend | |
|---|---|
| 🟢 **You** | sign-ups / credentials (your accounts — I can't and shouldn't do these) |
| 🔵 **Me** | code, config, verification, fixes (say the word) |
| ⏱️ | rough time to get the credential |

---

## STEP 1 — Turn on real competitor data (the core product) 🟢 + 🔵

**This is the one that matters most.** It lights up the entire intelligence engine — real
competitor videos → outperformance alerts → AI hook/format analysis (Groq/Gemini/OpenAI are
already live). One credential, ~$200/mo, and you have a working "mega TikTok machine."

1. 🟢 Go to **https://ensembledata.com** → sign up → open the dashboard → copy your **API token**. ⏱️ ~10 min. Start on the **Bronze** plan (~$200/mo) — that's the tier the whole cost model assumes.
2. 🔵 Paste it into `.env.local`:
   ```
   ENSEMBLEDATA_TOKEN=your_token_here
   ```
3. 🔵 Register a few competitors and pull real data (I'll run these with you):
   ```bash
   npm run seed -- competitor_handle_1 competitor_handle_2
   npm run poll:once
   ```
4. 🔵 **This is where we verify the read-plane `// UNVERIFIED` shape** (`mapEnsembleVideo` — flagged in the README as never having seen a live response). If `poll:once` errors or the numbers look wrong, paste me the output and I reconcile the parser to the real payload.

**Done when:** `npm run poll:once` writes real videos + scores into Supabase with no errors.

> Optional failover: `SCRAPECREATORS_API_KEY` (https://scrapecreators.com) — not needed to start.

---

## STEP 2 — See it: the dashboard 🔵

Once real data is flowing, look at it.

```bash
npm run dev        # opens http://localhost:3000
```

The **Alerts, Trends, Accounts, and Formats** pages already work against the live DB. The
**write-plane / attribution / creator** pages are not built yet — **I can build all of them for
you** (see "What I can build right now" at the bottom). Recommended: do this right after Step 1 so
there's real data to look at.

---

## STEP 3 — Publishing to your own TikTok accounts (write plane) 🟢 + 🔵

More involved than Step 1, but no third-party cost. This lets the system draft posts into your
Goodfor accounts' inboxes for a human to tap "publish."

1. 🟢 Go to **https://developers.tiktok.com** → **Manage apps** → **Create app**. ⏱️ ~30 min + review time.
   - Add the **Content Posting API** product.
   - Request scopes **exactly**: `user.info.basic, video.list, video.upload`. **Do not add `video.publish`** — the code refuses it on purpose (it triggers the audit that rejects this product category).
   - Copy the **Client key** and **Client secret**.
2. 🔵 I generate your token-encryption key (local, not a third-party secret):
   ```bash
   openssl rand -base64 32
   ```
3. 🔵 Fill `.env.local`:
   ```
   TIKTOK_CLIENT_KEY=...
   TIKTOK_CLIENT_SECRET=...
   TIKTOK_REDIRECT_URI=https://localhost:3000/api/auth/tiktok/callback   (must match the portal exactly)
   TOKEN_ENCRYPTION_KEY=...(from step 2)
   ```
4. 🔵 Connect a Goodfor account (runs the OAuth flow in `worker-write`):
   ```bash
   npm run publish:oauth
   ```
   → it opens a TikTok consent page → you approve → it stores the encrypted tokens in `owned_account`.
5. 🔵 Verify with a draft. We schedule a test post; it lands in the account's TikTok inbox; a human publishes it. **Always confirm the post is actually public out-of-band** (the spec's §2.3 trap).

**Also (parallel, no code):** 🟢 submit the **own-audit (path C)** in the developer portal — a screen recording of your composer flow. It's free, takes 2–4 weeks of back-and-forth, and runs in the background.

---

## STEP 4 — Attribution (installs → subscriptions) 🟢 + 🔵 + 📱 mobile team

This is the **slowest** one because it needs changes inside the Goodfor mobile apps, which live in
a **different codebase** (not this repo). **Book the mobile work early** — it's the critical path.

1. 📱 **Android app team:** add `com.android.installreferrer:installreferrer:2.2`, read the referrer on first launch, POST it to the attribution worker. (I can write the exact snippet + endpoint contract for them.)
2. 📱 **iOS app team:** add the post-paywall **"How did you hear about us?"** survey + a "which video?" follow-up screen.
3. 🟢 **Kochava** (free MMP): https://www.kochava.com → free account → app GUID + API key.
   ```
   KOCHAVA_API_KEY=...
   KOCHAVA_APP_GUID=...
   ```
   ⚠️ Confirm **in writing** that owned-media links bill **$0** before ever touching a paid tier.
4. 🟢 **Apple App Store Connect API key**: App Store Connect → Users and Access → Integrations → App Store Connect API → generate a key with the **Admin** role → download the `.p8` file. ⏱️ ~15 min.
   ```
   APP_STORE_CONNECT_KEY_ID=...
   APP_STORE_CONNECT_ISSUER_ID=...
   APP_STORE_CONNECT_PRIVATE_KEY=...(contents of the .p8, or its base64)
   ```
5. 🔵 Verify: `npm run attribute:apple` (Apple pull) and `npm run attribute:once` (install ingest). Paste any shape error; I fix the Kochava/Apple parsers.
6. 🟢 Run **one single-channel pause test** (pause posting on one account 2–4 weeks) → that produces your first real, defensible **organic CPI** — the phase's whole point.

---

## STEP 5 — Creator CRM (do this LAST) 🟢 + 🔵

The biggest commitment: **Modash is a $16,200/yr floor** — a signed contract, not a metered cost.
Only start when you're ready to actually run a creator programme.

1. 🟢 **Get budget sign-off on the $16,200/yr** first.
2. 🟢 **Modash** (https://www.modash.io) → Discovery API key.
   ```
   MODASH_API_KEY=...
   MODASH_BASE_URL=...(from their docs)
   ```
3. 🟢 **HypeAuditor** (https://hypeauditor.com) → API token; start on the **free sandbox**.
   ```
   HYPEAUDITOR_API_TOKEN=...
   HYPEAUDITOR_BASE_URL=...
   ```
4. 🟢 For outreach + Spark Ads you'll also need `TIKTOK_DM_ACCESS_TOKEN`, `OUTREACH_EMAIL_API_KEY`, and `TIKTOK_BUSINESS_ACCESS_TOKEN` (Business Center) — but only when you reach that stage.
5. 🔵 Verify: `npm run creators:discovery`. Critical check: confirm `credibility_score` is captured on the first search (it's never returned again). Paste any shape error; I fix the Modash/HypeAuditor clients.

---

## What I (Claude) can build for you right now — no credentials needed

- **The dashboard UI pages** that don't exist yet: write-plane (brief review + compliance checklist + one-tap "send to inbox" + account health), attribution (per-video installs, control-total reconciliation, incrementality/CPI), and creator (shortlist, pipeline board, rights calendar, creator ROI). This is the single biggest chunk of remaining in-repo work.
- **The mobile integration contract** — the exact endpoint + payload the Android/iOS teams POST to, so they don't have to guess.
- **A Redis token bucket** for real polling rate-limits (currently absent; fine for testing, needed at scale).
- **Fixing any `// UNVERIFIED` wire shape** the moment a live call reveals a mismatch.

## Suggested path for you

1. **Today:** get the **EnsembleData** token (Step 1). That alone gives you a working product.
2. **This week:** I build the dashboard pages (Step 2) so you can see everything.
3. **Next:** TikTok app for publishing (Step 3) + book the mobile team for attribution (Step 4).
4. **Later, when ready:** creators (Step 5).

Tell me which step you want to start, and I'll walk you through it live.
