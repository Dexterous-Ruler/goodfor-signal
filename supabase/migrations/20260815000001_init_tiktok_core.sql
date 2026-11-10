-- ============================================================================
-- Goodfor TikTok Machine — core schema
--
-- NOTE ON PARTITIONING: the build spec assumed TimescaleDB hypertables.
-- Supabase does not offer TimescaleDB. This uses native declarative range
-- partitioning by month instead, which gives the same practical benefits
-- (partition pruning on time-range queries, O(1) retention drops) with no
-- extension dependency. Monthly partitions are created by
-- ensure_metric_partitions(), scheduled via pg_cron in a later migration.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector   with schema extensions;

-- ============================================================================
-- READ PLANE — competitor intelligence
-- ============================================================================

create table if not exists competitor_account (
  id                    bigint generated always as identity primary key,
  platform_user_id      text        not null unique,
  sec_uid               text,                       -- cached at onboarding: cheaper polling
  username              text        not null,
  display_name          text,
  follower_count        bigint,
  is_tracked            boolean     not null default true,
  tracking_tier         smallint    not null default 1,
  notes                 text,
  added_at              timestamptz not null default now(),
  vendor_last_synced_at timestamptz
);

comment on column competitor_account.sec_uid is
  'TikTok secUid. Polling by secUid costs 1 unit less per call than by username.';

create table if not exists tracked_video (
  id                  bigint generated always as identity primary key,
  competitor_account_id bigint    not null references competitor_account(id) on delete cascade,
  platform_video_id   text        not null unique,
  created_at_tiktok   timestamptz not null,
  duration_s          integer,
  description         text,
  music_id            text,
  hashtags            text[]      not null default '{}',
  due_at              timestamptz not null default now(),
  tracking_active     boolean     not null default true,
  poll_tier           smallint    not null default 0,
  first_seen_at       timestamptz not null default now()
);

-- The scheduler's hot path: one indexed lookup per 60s tick.
create index if not exists tracked_video_due_idx
  on tracked_video (due_at) where tracking_active;
create index if not exists tracked_video_account_idx
  on tracked_video (competitor_account_id, created_at_tiktok desc);

-- ----------------------------------------------------------------------------
-- Metric snapshots — WIDE, not EAV. All six counters arrive in one API
-- response; a narrow table would 6x the row count and force a self-join for
-- every velocity query.
--
-- ts is the FLOORED slot timestamp, so ON CONFLICT DO NOTHING makes queue
-- redelivery a no-op. At-least-once delivery is therefore sufficient and no
-- dedupe table is needed.
--
-- view_count is bigint (int64 in TikTok's schema); the other three are
-- integer (int32). Getting this wrong silently truncates at 2,147,483,647.
-- ----------------------------------------------------------------------------

create table if not exists video_metric_snapshot (
  video_id        bigint      not null references tracked_video(id) on delete cascade,
  ts              timestamptz not null,
  view_count      bigint      not null,
  like_count      integer     not null,
  comment_count   integer     not null,
  share_count     integer     not null,
  favorites_count integer,
  primary key (video_id, ts)
) partition by range (ts);

-- Creates the current month plus `months_ahead` future partitions.
-- Idempotent: safe to run on every cron tick.
create or replace function ensure_metric_partitions(months_ahead integer default 2)
returns void
language plpgsql
as $$
declare
  start_month date := date_trunc('month', now())::date;
  i integer;
  p_start date;
  p_end   date;
  p_name  text;
begin
  for i in 0..months_ahead loop
    p_start := (start_month + (i || ' month')::interval)::date;
    p_end   := (p_start + interval '1 month')::date;
    p_name  := format('video_metric_snapshot_%s', to_char(p_start, 'YYYY_MM'));

    if not exists (select 1 from pg_class where relname = p_name) then
      execute format(
        'create table %I partition of video_metric_snapshot for values from (%L) to (%L)',
        p_name, p_start, p_end
      );
    end if;
  end loop;
end;
$$;

select ensure_metric_partitions(3);

-- ----------------------------------------------------------------------------
-- Derived scores. Recomputed, never authoritative — the snapshots are truth.
-- ----------------------------------------------------------------------------

create table if not exists video_score (
  video_id              bigint      not null references tracked_video(id) on delete cascade,
  age_hours             integer     not null,
  z_score               numeric(10,4),
  multiplier_vs_median  numeric(10,3),
  velocity_vph          numeric(14,2),
  acceleration          numeric(14,2),
  baseline_n            integer     not null,
  computed_at           timestamptz not null default now(),
  primary key (video_id, age_hours)
);

create index if not exists video_score_alert_idx
  on video_score (z_score desc, age_hours)
  where z_score >= 2.5;

-- ----------------------------------------------------------------------------
-- Content analysis. embedding is halfvec: ~3 KB/vector vs ~6 KB for float32,
-- which halves the index footprint at 1M+ vectors.
-- ----------------------------------------------------------------------------

create table if not exists video_analysis (
  video_id            bigint primary key references tracked_video(id) on delete cascade,
  transcript          text,
  hook_type           text,
  hook_text_sequence  jsonb,
  spoken_hook         text,
  face_present        boolean,
  face_screen_fraction numeric(5,3),
  cut_count_first_3s  integer,
  caption_style       text,
  audio_type          text,
  format_cluster_id   integer,
  embedding           extensions.halfvec(1536),
  phash_frames        bytea,
  model_version       text        not null,
  analysed_at         timestamptz not null default now()
);

create index if not exists video_analysis_embedding_idx
  on video_analysis using hnsw (embedding extensions.halfvec_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists video_analysis_cluster_idx
  on video_analysis (format_cluster_id) where format_cluster_id is not null;

-- ----------------------------------------------------------------------------
-- Keyword / hashtag / sound trend series.
-- ----------------------------------------------------------------------------

create table if not exists keyword_trend (
  id           bigint generated always as identity primary key,
  term         text        not null,
  term_type    text        not null check (term_type in ('keyword','hashtag','sound')),
  ts           timestamptz not null,
  post_count   bigint,
  view_count   bigint,
  velocity     numeric(14,2),
  acceleration numeric(14,2),
  burst_weight numeric(10,4),
  state        text check (state in ('rising','peaked','decaying','bottoming')),
  unique (term, term_type, ts)
);

create index if not exists keyword_trend_rising_idx
  on keyword_trend (ts desc, burst_weight desc) where state = 'rising';

-- ============================================================================
-- WRITE PLANE — Goodfor's own accounts
-- ============================================================================

create table if not exists owned_account (
  id                  bigint generated always as identity primary key,
  app_slug            text        not null,          -- Goodfor is one of several apps
  tiktok_open_id      text        not null unique,
  username            text        not null,
  -- Gates sound selection at brief-generation time. Business accounts are
  -- restricted to the Commercial Music Library; Creator accounts get trending
  -- sounds but cannot publish via API. No account can have both.
  account_type        text        not null check (account_type in ('business','creator')),
  access_token        bytea,                          -- encrypted, never plaintext
  access_expires_at   timestamptz,
  refresh_token       bytea,                          -- encrypted
  refresh_expires_at  timestamptz,
  -- Re-auth prompt is computed from THIS, not from the latest refresh.
  -- The 365-day window runs from initial issuance; refreshing does not extend it.
  original_granted_at timestamptz,
  posts_last_24h      smallint    not null default 0,
  quarantined_until   timestamptz,
  created_at          timestamptz not null default now()
);

comment on column owned_account.original_granted_at is
  'TikTok refresh tokens expire 365 days after INITIAL issuance. Refreshing does not extend this.';

create table if not exists scheduled_post (
  id                  bigint generated always as identity primary key,
  owned_account_id    bigint      not null references owned_account(id) on delete cascade,
  scheduled_for       timestamptz not null,
  status              text        not null default 'draft'
                        check (status in ('draft','queued','uploading','pending','published','failed','cancelled')),
  video_asset_url     text,
  caption             text,
  privacy_level       text check (privacy_level in
                        ('PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR','SELF_ONLY')),
  -- Non-bypassable compliance gate
  disclosure_type     text        not null default 'none'
                        check (disclosure_type in ('none','your_brand','branded_content')),
  disclosure_verified boolean     not null default false,
  sound_id            text,
  sound_is_cml        boolean,                        -- validated against account_type
  -- TikTok's own misspelling of this field — kept verbatim to match the API
  publish_id          text,
  publicaly_available_post_id text,
  fail_reason         text,
  source_brief_id     bigint,
  competitor_inspiration_id bigint references tracked_video(id) on delete set null,
  created_at          timestamptz not null default now(),
  published_at        timestamptz
);

create index if not exists scheduled_post_due_idx
  on scheduled_post (scheduled_for) where status in ('draft','queued');
create index if not exists scheduled_post_reconcile_idx
  on scheduled_post (publish_id) where status = 'pending';

create table if not exists account_health (
  id                   bigint generated always as identity primary key,
  owned_account_id     bigint      not null references owned_account(id) on delete cascade,
  ts                   timestamptz not null default now(),
  strike_count_by_area jsonb       not null default '{}',
  fyf_traffic_share    numeric(5,4),
  originality_status   text,
  suppression_flag     boolean     not null default false,
  unique (owned_account_id, ts)
);

-- ============================================================================
-- RLS — these are internal service tables reached with the service role only.
-- Enable RLS with no policies so the anon and authenticated keys are denied
-- by default. Add policies deliberately if a client ever needs read access.
-- ============================================================================

alter table competitor_account    enable row level security;
alter table tracked_video         enable row level security;
alter table video_metric_snapshot enable row level security;
alter table video_score           enable row level security;
alter table video_analysis        enable row level security;
alter table keyword_trend         enable row level security;
alter table owned_account         enable row level security;
alter table scheduled_post        enable row level security;
alter table account_health        enable row level security;
