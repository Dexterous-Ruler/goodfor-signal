/**
 * @goodfor/publishing — the heart of the write plane.
 *
 * Turns a produced video into a TikTok INBOX DRAFT (scope `video.upload`,
 * `POST /v2/post/publish/inbox/video/init/`) where a human taps publish. It
 * NEVER uses Direct Post (`video.publish`) — that scope is the prohibited-app
 * shape and appears nowhere in this package.
 *
 * Everything is injectable for tests (HTTP via `fetchImpl`, the Publisher and
 * `onTransition` into the state machine) and does NO DB writes — packages stay
 * pure; the `worker-write` app composes them with `@goodfor/db`.
 *
 * ── UNVERIFIED boundaries (validate against a live/sandbox response) ─────────
 * All TikTok request/response SHAPES, endpoint paths, error-code strings,
 * status strings, the OAuth token-response layout, and the chunk-size numbers
 * are written from docs, not a live API — each is flagged `// UNVERIFIED` at
 * its site. See the return summary for the full list.
 */

// Token vault (AES-256-GCM envelope encryption)
export { sealToken, openToken, PublishingKeyError } from './token.js'

// OAuth (Login Kit v2)
export { TikTokOAuthClient } from './oauth.js'
export type { TikTokOAuthConfig, TikTokTokens } from './oauth.js'

// Publisher abstraction + implementations
export {
  InboxPublisher,
  VendorPublisher,
  planChunks,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  DEFAULT_CHUNK_SIZE,
} from './publisher.js'
export type {
  Publisher,
  PublisherAccount,
  PublisherResult,
  CreatorInfo,
  InitInboxRequest,
  InitResult,
  ChunkRange,
  UploadOptions,
  UploadResult,
  PublishStatus,
  ChunkPlan,
  InboxPublisherConfig,
} from './publisher.js'

// State machine
export {
  PublishStateMachine,
  classifyErrorCode,
  classifyPublishStatus,
  isInboxTerminal,
} from './statemachine.js'
export type {
  PublishStep,
  TransitionInfo,
  OnTransition,
  ErrorClass,
  PublishJob,
  PublishOutcome,
  PublishResultStatus,
  PublishStateMachineConfig,
} from './statemachine.js'

// Governor (anti-spam)
export {
  Governor,
  MAX_POSTS_PER_24H,
  MAX_IN_FLIGHT_UPLOADS,
  QUARANTINE_MS,
} from './governor.js'
export type {
  AccountPostingState,
  RateLimit,
  PostDecision,
  PostRefusalReason,
  ResultInput,
  ResultOutcome,
  GovernorOptions,
} from './governor.js'

// Shared error
export { PublishingError } from './http.js'
