-- ============================================================================
-- Phase 5 — Scale creators (the UGC Creator CRM). WRITE-PLANE schema.
--
-- Runs a multi-app UGC creator programme end to end: source -> qualify ->
-- contact -> negotiate -> contract -> deliver -> live, with rights and payments
-- tracked and Spark Ads wired so paid amplification accrues to the creator's
-- organic post (PHASE-5-scale-creators.md §9.5).
--
-- All tables are write-plane. RLS is enabled with NO policies (service-role
-- only), matching the existing convention. THREE schema rules are enforced
-- structurally (§9.5):
--   1. Key on platform_user_id, NEVER username -> creator_account UNIQUE is
--      (platform, platform_user_id).
--   2. Never UPDATE metrics in place -> creator_metric_snapshot and
--      performance_fact are append-only (no surrogate id on the snapshot; keyed
--      by capture time).
--   3. Stamp vendor provenance + sync timestamp on every enriched row -> Modash
--      on-demand vs Phyllo bi-weekly staleness must never be confused.
--
-- credibility_score (Modash) is captured at SEARCH time only and persisted
-- immediately — a report re-fetch never returns it (§9.1). rights_grant ships
-- IN v1 (not a follow-up) because a live paid ad on an expired licence is the
-- single largest routine legal exposure.
-- ============================================================================

-- Dedupes one human across platforms and handle changes.
create table if not exists creator_identity (
  id                bigint generated always as identity primary key,
  display_name      text,
  primary_email     text,
  country           text,
  timezone          text,
  payment_entity_id bigint,
  notes             text,
  created_at        timestamptz not null default now()
);

-- KEY ON platform_user_id, NEVER username (§9.5).
create table if not exists creator_account (
  id                   bigint generated always as identity primary key,
  creator_identity_id  bigint references creator_identity(id) on delete set null,
  platform             text not null,
  platform_user_id     text not null,
  username             text,
  url                  text,
  followers            bigint,
  engagement_rate      numeric(6,4),          -- er_views convention
  avg_views            bigint,
  is_verified          boolean,
  last_posted_at       timestamptz,
  source_vendor        text not null,         -- provenance stamp
  vendor_last_synced_at timestamptz not null,
  unique (platform, platform_user_id)
);

create table if not exists creator_metric_snapshot (   -- append-only, never UPDATE
  creator_account_id bigint not null references creator_account(id) on delete cascade,
  captured_at        timestamptz not null,
  followers          bigint,
  avg_views          bigint,
  engagement_rate    numeric(6,4),
  primary key (creator_account_id, captured_at)
);

-- credibility_score is NULLABLE and captured at SEARCH time only — re-fetch never returns it.
create table if not exists creator_audience (
  id                  bigint generated always as identity primary key,
  creator_account_id  bigint not null references creator_account(id) on delete cascade,
  captured_at         timestamptz not null,
  gender_split        jsonb,
  age_split           jsonb,
  geo_countries       jsonb,
  languages           jsonb,
  interests           jsonb,
  credibility_score   numeric(5,2),           -- Modash query-time-only signal — persist NOW
  audience_quality_score numeric(5,2),        -- HypeAuditor AQS
  audience_reachability numeric(5,2)
);

-- Goodfor is one of several apps.
create table if not exists app (
  id        bigint generated always as identity primary key,
  slug      text not null unique,
  name      text not null
);

create table if not exists campaign (
  id           bigint generated always as identity primary key,
  app_id       bigint not null references app(id) on delete cascade,
  objective    text,
  budget_cents integer,
  start_date   date,
  end_date     date,
  brief_url    text
);

-- THE moving entity. Same creator, different stage per app, simultaneously.
create table if not exists collaboration (
  id                 bigint generated always as identity primary key,
  campaign_id        bigint not null references campaign(id) on delete cascade,
  creator_account_id bigint not null references creator_account(id) on delete cascade,
  stage              text not null default 'sourced' check (stage in
                       ('sourced','qualified','contacted','replied','negotiating',
                        'contracted','delivered','live','paid','renewed','archived','rejected')),
  owner_user_id      bigint,
  rate_cents         integer,
  currency           text default 'USD',
  first_contacted_at timestamptz,
  replied_at         timestamptz,
  contracted_at      timestamptz,
  next_action_at     timestamptz,             -- drives the day 2 / day 5 / day 28 cadence
  source             text,
  created_at         timestamptz not null default now()
);
create index if not exists collaboration_stage_idx on collaboration (stage, next_action_at);

create table if not exists deliverable (
  id                     bigint generated always as identity primary key,
  collaboration_id       bigint not null references collaboration(id) on delete cascade,
  type                   text,
  due_date               date,
  status                 text,
  asset_url              text,
  posted_url             text,
  platform_post_id       text,                -- organic post id = Spark join key
  is_spark_ads_authorized boolean not null default false,
  spark_ads_code         text,
  spark_ads_expires_at   timestamptz
);

-- SHIP IN v1. A live paid ad on an expired licence is the top routine legal exposure.
create table if not exists rights_grant (
  id                     bigint generated always as identity primary key,
  collaboration_id       bigint not null references collaboration(id) on delete cascade,
  usage_scope            text not null check (usage_scope in
                           ('organic_only','paid_ads','whitelisting','perpetual')),
  territories            text[],
  starts_at              timestamptz not null,
  expires_at             timestamptz,          -- licence_end — alert on this
  exclusivity_window_days integer,
  renewal_price_cents    integer
);
create index if not exists rights_grant_expiry_idx on rights_grant (expires_at)
  where expires_at is not null;

create table if not exists payment (
  id                bigint generated always as identity primary key,
  collaboration_id  bigint not null references collaboration(id) on delete cascade,
  amount_cents      integer not null,
  currency          text not null default 'USD',
  platform_fee_cents integer,
  method            text,
  status            text,
  invoice_url       text,
  tax_form_status   text
);

-- append-only per capture; reuses Phase 4 funnel counters for one-ruler ROI.
create table if not exists performance_fact (
  id                 bigint generated always as identity primary key,
  deliverable_id     bigint not null references deliverable(id) on delete cascade,
  captured_at        timestamptz not null,
  views              bigint,
  likes              integer,
  comments           integer,
  shares             integer,
  saves              integer,
  install_count      integer,
  signup_count       integer,
  trial_count        integer,
  subscription_count integer,
  revenue_cents      integer
);

-- ----------------------------------------------------------------------------
-- RLS: service-role only, no policies (matches the existing convention).
-- ----------------------------------------------------------------------------
alter table creator_identity        enable row level security;
alter table creator_account         enable row level security;
alter table creator_metric_snapshot enable row level security;
alter table creator_audience        enable row level security;
alter table app                     enable row level security;
alter table campaign                enable row level security;
alter table collaboration           enable row level security;
alter table deliverable             enable row level security;
alter table rights_grant            enable row level security;
alter table payment                 enable row level security;
alter table performance_fact        enable row level security;
