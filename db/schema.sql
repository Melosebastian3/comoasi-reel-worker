-- Schema of the ¿Cómo Así? database (schema "comoasi"), copied from Neon project
-- como-asi (branch actions-test, a copy of main) on 2026-10-08.
-- Idempotent: only for creating EMPTY databases (tests, new environments).
create schema if not exists comoasi;

create table if not exists comoasi.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists comoasi.reels (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  topic text not null,
  title text,
  hook text,
  status text not null default 'draft' check (status in ('draft','researching','generating','rendering','ready','queued','published','failed','archived')),
  duration_seconds integer not null default 60 check (duration_seconds > 0),
  scene_count integer not null default 20 check (scene_count > 0),
  viral_score numeric,
  visual_score numeric,
  research jsonb not null default '{}'::jsonb,
  narration text,
  storyboard jsonb not null default '[]'::jsonb,
  cover jsonb not null default '{}'::jsonb,
  publishing_kit jsonb not null default '{}'::jsonb,
  worker_job_id text unique,
  video_object_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reels_category_created_idx on comoasi.reels (category, created_at desc);
create index if not exists reels_status_created_idx on comoasi.reels (status, created_at desc);

create table if not exists comoasi.reel_jobs (
  id uuid primary key default gen_random_uuid(),
  external_job_id text unique,
  reel_id uuid references comoasi.reels(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed','cancelled')),
  stage text not null default 'queued',
  progress integer not null default 0 check (progress >= 0 and progress <= 100),
  error text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists reel_jobs_status_created_idx on comoasi.reel_jobs (status, created_at desc);

create table if not exists comoasi.daily_plans (
  id uuid primary key default gen_random_uuid(),
  plan_date date not null unique,
  timezone text not null default 'America/Argentina/Buenos_Aires',
  slots jsonb not null default '[]'::jsonb,
  strategy jsonb not null default '{}'::jsonb,
  status text not null default 'planned' check (status in ('planned','approved','executing','completed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists comoasi.editorial_memory (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  normalized_topic text not null,
  category text not null,
  protagonist text,
  event_key text,
  angle text,
  subtopic text,
  period_label text,
  narrative_question text,
  status text not null default 'generated' check (status in ('candidate','generated','published','archived','rejected')),
  source text not null default 'comoasi',
  platforms text[] not null default array[]::text[],
  published_at timestamptz,
  performance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists editorial_memory_category_created_idx on comoasi.editorial_memory (category, created_at desc);
create index if not exists editorial_memory_normalized_topic_idx on comoasi.editorial_memory (normalized_topic);
create index if not exists editorial_memory_protagonist_created_idx on comoasi.editorial_memory (protagonist, created_at desc);

create table if not exists comoasi.metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  source text not null default 'metricool',
  strategy jsonb not null default '{}'::jsonb,
  category_scores jsonb not null default '{}'::jsonb,
  signals jsonb not null default '{}'::jsonb,
  top_posts jsonb not null default '[]'::jsonb,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (snapshot_date, source)
);
create index if not exists metric_snapshots_date_idx on comoasi.metric_snapshots (snapshot_date desc);

create table if not exists comoasi.platform_posts (
  id uuid primary key default gen_random_uuid(),
  reel_id uuid references comoasi.reels(id) on delete set null,
  platform text not null,
  external_post_id text not null,
  url text,
  published_at timestamptz,
  metrics jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_post_id)
);

create table if not exists comoasi.publishing_queue (
  id uuid primary key default gen_random_uuid(),
  reel_id uuid not null references comoasi.reels(id) on delete cascade,
  platform text not null check (platform in ('instagram','tiktok','youtube','facebook','other')),
  account_key text,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','publishing','published','failed','cancelled')),
  publish_payload jsonb not null default '{}'::jsonb,
  external_post_id text,
  published_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists publishing_queue_buffer_reel_platform_unique on comoasi.publishing_queue (reel_id, platform, account_key) where account_key = 'buffer';
create unique index if not exists publishing_queue_metricool_unique_schedule on comoasi.publishing_queue (reel_id, platform, account_key, scheduled_at) where account_key = 'metricool';
create index if not exists publishing_queue_due_idx on comoasi.publishing_queue (status, scheduled_at);

create table if not exists comoasi.viral_learning (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  pattern_type text not null,
  pattern_key text not null,
  score numeric not null default 0,
  sample_size integer not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  notes jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (category, pattern_type, pattern_key)
);
create index if not exists viral_learning_category_score_idx on comoasi.viral_learning (category, score desc);
