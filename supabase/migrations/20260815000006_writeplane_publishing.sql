-- The brief is what crosses the plane boundary: a structured finding, never an asset.
create table if not exists brief (
  id                        bigint generated always as identity primary key,
  app_slug                  text not null,
  competitor_inspiration_id bigint references tracked_video(id) on delete set null,
  format_cluster_id         bigint,                    -- Phase 2 format taxonomy
  hook_type                 text,                      -- constrained enum from packages/contracts
  target_account_type       text not null check (target_account_type in ('business','creator')),
  sound_id                  text,
  sound_is_cml              boolean,                   -- gated vs target_account_type AT BRIEF TIME
  competitor_claims         jsonb not null default '[]',  -- [{claim, figure, as_of_date, verified_by}]
  status                    text not null default 'draft'
                              check (status in ('draft','ready','in_production','scheduled','rejected')),
  created_at                timestamptz not null default now()
);

-- One-generation token retention + in-flight governor
alter table owned_account
  add column if not exists uploads_in_flight smallint not null default 0,
  add column if not exists prev_access_token  bytea,
  add column if not exists prev_refresh_token bytea,
  add column if not exists token_generation   integer  not null default 0,
  add column if not exists quarantine_reason  text;

-- Region-aware disclosure + appeal SLA + idempotency + brief FK + spam trace
alter table scheduled_post
  add column if not exists brief_id                 bigint references brief(id) on delete set null,
  add column if not exists disclosure_region        text,          -- 'US' | 'UK' | 'EU' | ...
  add column if not exists tiktok_disclosure_toggle text,          -- which in-app toggle was set
  add column if not exists appeal_deadline_at       timestamptz,   -- published_at + 24h
  add column if not exists idempotency_key          text unique,   -- redelivery cannot double-post
  add column if not exists spam_risk_code           text;

-- Auditable transition log — one row per state-machine step (§11 legal position)
create table if not exists publish_attempt (
  id                bigint generated always as identity primary key,
  scheduled_post_id bigint not null references scheduled_post(id) on delete cascade,
  owned_account_id  bigint not null references owned_account(id),
  step              text   not null,   -- creator_info | init | upload | status_poll | reconcile
  error_code        text,              -- TikTok error-code STRING, never the HTTP status
  http_status       smallint,
  raw_response      jsonb,
  ts                timestamptz not null default now()
);

-- Search-traffic breakout for the suppression detector (verify Search is broken out first)
alter table account_health
  add column if not exists search_traffic_share numeric(5,4);

-- THE NON-BYPASSABLE DISCLOSURE GATE — enforced in the DB, not just app code.
-- Any post that promotes (disclosure_type <> 'none') cannot leave 'draft' without
-- a verified, region-stamped disclosure. App bugs cannot route around this.
create or replace function enforce_disclosure_gate() returns trigger as $$
begin
  if new.status <> 'draft'
     and new.disclosure_type <> 'none'
     and (new.disclosure_verified is not true or new.disclosure_region is null) then
    raise exception
      'disclosure gate: post % cannot advance past draft without verified region-aware disclosure',
      new.id;
  end if;
  return new;
end $$ language plpgsql;

create trigger scheduled_post_disclosure_gate
  before insert or update on scheduled_post
  for each row execute function enforce_disclosure_gate();

alter table brief           enable row level security;
alter table publish_attempt enable row level security;
