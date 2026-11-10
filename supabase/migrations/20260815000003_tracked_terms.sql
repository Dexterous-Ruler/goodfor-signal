-- ============================================================================
-- Registry of keywords / hashtags / sounds under active tracking.
--
-- keyword_trend stores the observed time series; this table is the list of
-- what to go and look at, with its own poll cadence.
-- ============================================================================

create table if not exists tracked_term (
  id            bigint generated always as identity primary key,
  term          text        not null,
  term_type     text        not null check (term_type in ('keyword','hashtag','sound')),
  is_tracked    boolean     not null default true,
  -- Rising terms are worth checking more often than dormant ones.
  poll_interval_minutes integer not null default 360,
  due_at        timestamptz not null default now(),
  added_at      timestamptz not null default now(),
  last_synced_at timestamptz,
  notes         text,
  unique (term, term_type)
);

create index if not exists tracked_term_due_idx
  on tracked_term (due_at) where is_tracked;

alter table tracked_term enable row level security;

-- keyword_trend.term/term_type currently float free of the registry.
-- Add the link so a term can be deleted cleanly.
alter table keyword_trend
  add column if not exists tracked_term_id bigint references tracked_term(id) on delete cascade;

create index if not exists keyword_trend_term_ts_idx
  on keyword_trend (tracked_term_id, ts desc);
