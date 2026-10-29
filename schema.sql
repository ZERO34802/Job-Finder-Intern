-- Paste into the Supabase SQL editor when STORE=supabase.
-- The poller and the dashboard both use the service role, server-side.

create table if not exists targets (
  id text primary key,
  company text not null,
  ats text not null check (ats in ('greenhouse', 'lever', 'workday')),
  board_token text,
  workday_host text,
  workday_tenant text,
  workday_site text,
  enabled integer not null default 1,
  interval_minutes integer not null default 360,
  last_polled_at timestamptz,
  last_status text,
  last_error text,
  last_ok_at timestamptz,
  created_at timestamptz not null default now()
);

-- Safe to re-run this whole file. This line upgrades databases created before last_ok_at existed.
alter table targets add column if not exists last_ok_at timestamptz;
update targets set last_ok_at = last_polled_at where last_ok_at is null and last_status = 'ok';

create table if not exists jobs (
  id text primary key,
  canonical_url text not null unique,
  title text not null,
  company text not null,
  location text,
  ats text not null,
  target_id text,
  external_id text,
  posted_at text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  source_urls jsonb not null default '[]'::jsonb,
  title_key text not null,
  is_intern integer,
  role_family text,
  seniority text,
  score double precision,
  classify_reason text,
  classify_model text,
  alerted_at timestamptz
);

create index if not exists jobs_title_key_idx on jobs (title_key);
create index if not exists jobs_first_seen_idx on jobs (first_seen_at desc);
create index if not exists jobs_score_idx on jobs (score desc);
create index if not exists jobs_classify_model_idx on jobs (classify_model);

create table if not exists classifications (
  cache_key text primary key,
  title text not null,
  is_intern integer not null,
  role_family text not null,
  seniority text not null,
  score double precision not null,
  reason text not null,
  model text not null,
  created_at timestamptz not null default now()
);

create table if not exists applications (
  job_id text primary key references jobs (id) on delete cascade,
  status text not null check (status in ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn')),
  notes text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists poll_runs (
  id bigint generated always as identity primary key,
  target_id text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  jobs_seen integer not null,
  jobs_new integer not null,
  error text
);

create index if not exists poll_runs_started_idx on poll_runs (started_at);

-- RLS on with no policies: the public anon key gets nothing.
-- The service role / secret key bypasses RLS, so the app is unaffected.
alter table targets enable row level security;
alter table jobs enable row level security;
alter table classifications enable row level security;
alter table applications enable row level security;
alter table poll_runs enable row level security;
