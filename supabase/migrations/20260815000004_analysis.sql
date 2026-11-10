-- ============================================================================
-- Phase 2 — content analysis
-- ============================================================================

-- Format archetypes discovered by clustering, labelled by an LLM.
create table if not exists format_cluster (
  id                     integer primary key,
  label                  text        not null,
  definition             text,
  distinguishing_features text[],
  member_count           integer     not null default 0,
  median_views           bigint,
  median_z               numeric(10,4),
  updated_at             timestamptz not null default now()
);

comment on table format_cluster is
  'HDBSCAN cluster -1 is the outlier bucket and is stored as id = -1. In competitor intelligence the outliers are the novel-format alert queue, not noise.';

alter table video_analysis
  add column if not exists format_summary       text,
  add column if not exists spoken_hook_words    jsonb,
  add column if not exists cost_usd             numeric(10,6),
  add column if not exists duplicate_of_video_id bigint references tracked_video(id) on delete set null,
  add column if not exists analysis_errors      text[];

-- Wire the cluster id to the cluster table now that one exists.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'video_analysis_format_cluster_fk'
  ) then
    alter table video_analysis
      add constraint video_analysis_format_cluster_fk
      foreign key (format_cluster_id) references format_cluster(id) on delete set null;
  end if;
end $$;

create index if not exists video_analysis_hook_idx
  on video_analysis (hook_type) where hook_type is not null;
create index if not exists video_analysis_dupe_idx
  on video_analysis (duplicate_of_video_id) where duplicate_of_video_id is not null;

-- Work queue for the analysis worker: videos worth spending money on.
create table if not exists analysis_queue (
  video_id     bigint primary key references tracked_video(id) on delete cascade,
  priority     smallint    not null default 5,   -- 0 = highest
  reason       text,                              -- 'alert' | 'corpus' | 'manual'
  enqueued_at  timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz,
  attempts     smallint    not null default 0,
  last_error   text
);

create index if not exists analysis_queue_pending_idx
  on analysis_queue (priority, enqueued_at) where completed_at is null;

alter table format_cluster  enable row level security;
alter table analysis_queue  enable row level security;
