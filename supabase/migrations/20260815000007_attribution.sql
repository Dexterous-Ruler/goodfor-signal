-- ============================================================================
-- Phase 4 — Attribute. WRITE-PLANE schema.
--
-- Turns "we published a video" into "that video drove N installs -> M signups
-- -> K subscriptions worth $X" — fully deterministic on Android, essentially
-- never per-video on iOS (PHASE-4-attribute.md §10.1).
--
-- All tables are write-plane. RLS is enabled with NO policies (service-role
-- only), matching the existing convention. NO UPDATE-in-place on
-- attributed_install / app_conversion / apple_analytics_daily — attribution is
-- a derivative that needs history; Apple corrections arrive as new
-- processing_date rows, not overwrites (§12).
-- ============================================================================

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

-- ----------------------------------------------------------------------------
-- RLS: service-role only, no policies (matches the existing convention).
-- ----------------------------------------------------------------------------
alter table bio_link            enable row level security;
alter table bio_link_rotation   enable row level security;
alter table attributed_install  enable row level security;
alter table app_conversion      enable row level security;
alter table hdyhau_response     enable row level security;
alter table apple_analytics_daily enable row level security;
alter table custom_product_page enable row level security;
alter table format_lift         enable row level security;
alter table incrementality_test enable row level security;
