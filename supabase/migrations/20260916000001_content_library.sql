-- Content Library: the one screen in the UI with no backing table.
--
-- A saved item is a POINTER, never a copy. We store a reference (a tracked_video
-- id, a term, a sound id, a brief id) plus the note the operator added — never
-- the media itself, which is ephemeral CDN-signed and must be re-resolved at use
-- time (see packages/tiktok-source TikTokVideo.mediaUrl).
--
-- Service-role only, consistent with every other table in this schema: RLS is
-- enabled with no policies, so the anon/authenticated keys are denied by default
-- and only the server-side service-role client can read or write.

create table if not exists library_item (
  id            bigserial primary key,
  -- What kind of thing was saved. Kept as text + check so adding a kind is a
  -- migration, not a schema rewrite.
  kind          text        not null
                check (kind in ('video', 'creator', 'trend', 'brief', 'sound', 'hashtag', 'idea')),
  -- Human-facing title and subtitle, denormalised so the library renders
  -- without fanning out to five tables.
  title         text        not null,
  meta          text,
  -- Optional typed references. All nullable: a saved hashtag has none of them.
  video_id      bigint      references tracked_video (id) on delete set null,
  brief_id      bigint      references brief (id)         on delete set null,
  creator_id    bigint      references creator_account (id) on delete set null,
  term          text,
  -- Free-form grouping. Array rather than a join table: tags are a UI
  -- convenience, not a domain entity.
  tags          text[]      not null default '{}',
  collection    text        not null default 'All saved',
  notes         text,
  created_at    timestamptz not null default now()
);

-- The library is browsed newest-first, and filtered by collection then kind.
create index if not exists library_item_created_idx    on library_item (created_at desc);
create index if not exists library_item_collection_idx on library_item (collection, kind);

-- Saving the same video twice is a no-op, not a duplicate row.
create unique index if not exists library_item_video_uniq
  on library_item (kind, video_id) where video_id is not null;

alter table library_item enable row level security;

comment on table  library_item is 'Saved references for the Content Library screen. Pointers only - never media bytes.';
comment on column library_item.tags is 'Free-form UI tags; not a domain entity, hence an array rather than a join table.';
