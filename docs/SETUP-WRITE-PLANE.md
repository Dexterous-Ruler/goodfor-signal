# Write-plane setup — what Karim must provide (C8 + C9)

The read plane (competitor intelligence) is **live**. The write plane — Publishing (C8)
and Attribution + Creator CRM (C9) — needs third-party accounts and keys that only an
authorised human can create. Claude cannot create accounts, accept terms, or complete
OAuth. This is the exact list of what to obtain and where each value goes.

> **Plane isolation.** These are WRITE-plane secrets. Keep them OUT of the read-plane
> `apps/.env.local` (which holds `ENSEMBLEDATA_TOKEN`). The boot guards
> `assertWritePlane` / `assertReadPlane` hard-fail if the two planes' secrets mix. Put
> these in a separate `env/write.env` (gitignored) for local dev, or as Fly secrets on
> the `goodfor-signal-write` app.

---

## C8 — Publishing (TikTok Content Posting API)

**Why draft-only:** our app category cannot auto-publish, so we request `video.upload`
(pushes to the user's TikTok **inbox** for a human to tap Publish) and **never**
`video.publish`. The DB trigger + `assertWritePlane` enforce this; do not add publish scope.

1. Go to **developers.tiktok.com** → log in → **Manage apps** → **Connect an app**.
2. Add the **Content Posting API** product. Under **Scopes**, request exactly:
   `user.info.basic`, `video.upload`.  *(Do NOT request `video.publish`.)*
3. Set the **Redirect URI** to your callback, e.g. `https://<your-domain>/api/tiktok/callback`.
4. Submit for **app review** (TikTok requires a review + demo video for Content Posting;
   allow a few days). Sandbox works for your own test account before approval.
5. Copy the **Client key** and **Client secret**.
6. Set these write-plane env vars:

   | Var | Value |
   |---|---|
   | `TIKTOK_CLIENT_KEY` | from the app |
   | `TIKTOK_CLIENT_SECRET` | from the app |
   | `TIKTOK_REDIRECT_URI` | your callback URL (must match step 3) |
   | `TIKTOK_SCOPES` | `user.info.basic,video.upload` |
   | `TOKEN_ENCRYPTION_KEY` | generate: `openssl rand -hex 32` (encrypts stored OAuth tokens) |

7. *(Optional — Business accounts / sounds compliance)* create a TikTok Business app and add
   `TIKTOK_BUSINESS_APP_ID`, `TIKTOK_BUSINESS_SECRET`, `TIKTOK_BUSINESS_ACCESS_TOKEN`.

Once set, `npm run publish:oauth` connects an owned account and the publisher takes over
(draft → compliance gate → inbox).

---

## C9 — Attribution + Creator CRM

### Attribution (does a TikTok view become an install/subscription?)
| Var | Where to get it |
|---|---|
| `KOCHAVA_API_KEY`, `KOCHAVA_APP_GUID` | Kochava dashboard → your app → API/settings |
| `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY` | App Store Connect → Users and Access → Integrations → App Store Connect API (download the `.p8`) |

### Creator CRM (discovery + credibility + outreach)
| Var | Where to get it |
|---|---|
| `MODASH_API_KEY`, `MODASH_BASE_URL` | Modash account → API |
| `HYPEAUDITOR_API_TOKEN`, `HYPEAUDITOR_BASE_URL` | HypeAuditor account → API |
| `TIKTOK_DM_ACCESS_TOKEN` | TikTok Business Messaging (outreach DMs) |
| `OUTREACH_EMAIL_API_KEY` | your transactional email provider (outreach email) |

Once set, `npm run creators:discovery` sources creators from Modash and the pipeline begins;
`npm run attribute` starts the attribution ingest loop.

---

## Fastest path
The **Connections** page in the dashboard (`/connections`) already lists every one of these
with a live **Test** button — paste a value, click Test, get a ✓ before wiring it fully.
Start with **C8** (Publishing is the higher-leverage half); C9 can follow.
