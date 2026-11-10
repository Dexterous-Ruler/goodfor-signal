# Goodfor TikTok Machine — Documentation

The in-house "mega TikTok machine" for **Goodfor** (the team's own consumer mobile app):
competitor/keyword/hashtag intelligence, outperformance detection, content-format &
hook analysis, a multi-app UGC creator CRM, multi-account scheduling/publishing, and
TikTok → install → signup → subscription attribution.

The full research + decision record is [`../completion.md`](../completion.md) (v1.0, 6 Aug 2026).
These docs turn that spec into a **sequential architecture** and a **phased build plan**.

---

## Read in this order

| # | Doc | What it answers |
|---|---|---|
| 1 | [**00-ARCHITECTURE.md**](./00-ARCHITECTURE.md) | *How is the whole thing built, end to end, and what is the exact tech stack at every layer?* Start here. |
| 2 | [**01-BUILD-STATE.md**](./01-BUILD-STATE.md) | *What is already built vs stubbed vs not started, right now?* The honest current-state audit. |
| 3 | [**UI-UX-DASHBOARD.md**](./UI-UX-DASHBOARD.md) | *What should the Goodfor dashboard look like?* Surface-by-surface spec, grounded in real products via Mobbin. |
| 4 | [**phases/**](./phases/) | *In what order do we build it?* Six gated phases, each a standalone build doc. |

## The six phases

| Phase | Doc | Weeks | State |
|---|---|---|---|
| 0 — Foundations | [PHASE-0-foundations.md](./phases/PHASE-0-foundations.md) | 1–2 | Largely done — hardening gates remain |
| 1 — See | [PHASE-1-see.md](./phases/PHASE-1-see.md) | 3–6 | Mostly done — running on `FixtureSource` |
| 2 — Understand | [PHASE-2-understand.md](./phases/PHASE-2-understand.md) | 7–10 | ✅ Code-complete — live-smoke-verified |
| 3 — Act (publishing) | [PHASE-3-act-publishing.md](./phases/PHASE-3-act-publishing.md) | 11–14 | ✅ Code-complete |
| 4 — Attribute | [PHASE-4-attribute.md](./phases/PHASE-4-attribute.md) | 15–18 | ✅ Code-complete |
| 5 — Scale creators | [PHASE-5-scale-creators.md](./phases/PHASE-5-scale-creators.md) | 19–24 | ✅ Code-complete |

> **All six phases are code-complete** as of 2026-08-16: whole monorepo typechecks clean, **373 unit tests green across 41 files**. What remains is operational — apply the 4 written migrations (`…05`–`…08`), add the remaining live credentials, and verify each `// UNVERIFIED` external-API boundary against its real endpoint. See [01-BUILD-STATE.md](./01-BUILD-STATE.md).

---

## The two facts everything is built around

1. **TikTok's Research API is closed to commercial users.** It is the only official surface
   with keyword/hashtag search and competitor video data, so **all** competitor intelligence
   runs on purchased third-party data (EnsembleData primary, ScrapeCreators failover). The
   exposure is **contract** risk with TikTok, not criminal.
2. **"A utility tool to upload content to accounts you manage" is a prohibited app category.**
   That is this product's exact shape — so publishing routes through the **draft/inbox** flow
   (`video.upload`, not audit-gated), where a human taps publish, never the audit-gated
   Direct Post (`video.publish`).

From these follows the cardinal rule: the **read plane** (competitor collection) and the
**write plane** (publishing to Goodfor's own accounts) share no compute, egress IPs,
credentials, or TikTok accounts.

> These are verified against TikTok's own docs. Do not re-litigate them without new evidence
> — see the memory note and `completion.md` §2 / §11.
