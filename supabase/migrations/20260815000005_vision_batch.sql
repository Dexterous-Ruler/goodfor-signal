-- ============================================================================
-- Phase 2 — Gemini Batch re-submit path
-- ============================================================================
--
-- Gemini Batch jobs expire after 48h and their results are then unrecoverable
-- (completion.md §6.3). A poll alone is not enough: an expired job must be
-- re-submitted for the still-unanalysed videos. This table tracks each batch
-- job so `worker-analyse --poll-batch` can find expired ones and re-submit.

create table if not exists vision_batch_job (
  id            text primary key,            -- Gemini batch job id
  video_ids     bigint[]    not null,        -- videos included in this batch
  submitted_at  timestamptz not null default now(),
  expires_at    timestamptz not null,        -- submitted_at + 48h
  status        text        not null default 'pending'
                  check (status in ('pending','succeeded','expired','failed','resubmitted')),
  resubmit_of   text references vision_batch_job(id),
  cost_usd      numeric(10,6)
);

create index if not exists vision_batch_pending_idx
  on vision_batch_job (expires_at) where status = 'pending';

alter table vision_batch_job enable row level security;
