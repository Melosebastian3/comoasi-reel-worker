-- Inferred from the queries in job-runner.js and pipeline.js (the original schema lives only in Neon).
-- Covers the production path (topic -> research -> story -> scenes -> voice -> cover -> render -> kit).
-- Idempotent: safe to run against an empty database. Do NOT run against the production Neon branch.
create schema if not exists comoasi;

create table if not exists comoasi.reels (
  id uuid primary key default gen_random_uuid(),
  category text,
  topic text,
  title text,
  hook text,
  narration text,
  viral_score numeric,
  visual_score numeric,
  status text not null default 'draft',
  worker_job_id text,
  research jsonb,
  storyboard jsonb,
  scene_count int,
  cover jsonb,
  publishing_kit jsonb,
  video_object_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reels_worker_job_idx on comoasi.reels(worker_job_id);

create table if not exists comoasi.reel_jobs (
  id uuid primary key default gen_random_uuid(),
  reel_id uuid references comoasi.reels(id),
  status text not null default 'queued',
  stage text not null default 'queued',
  progress int not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reel_jobs_status_idx on comoasi.reel_jobs(status, created_at);

create table if not exists comoasi.editorial_memory (
  id bigserial primary key,
  topic text not null,
  normalized_topic text not null,
  category text,
  protagonist text,
  event_key text,
  angle text,
  subtopic text,
  period_label text,
  narrative_question text,
  status text not null default 'generated',
  source text,
  created_at timestamptz not null default now()
);
create index if not exists editorial_memory_norm_idx on comoasi.editorial_memory(normalized_topic, status);

create table if not exists comoasi.viral_learning (
  id bigserial primary key,
  category text,
  pattern_type text,
  pattern_key text,
  score numeric not null default 0,
  sample_size int not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
