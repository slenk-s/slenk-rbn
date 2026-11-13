-- Slenk Notes schema. The slenk_notes_ prefix keeps these tables namespaced.
create table if not exists slenk_notes_users (
  id text primary key,
  username text not null unique,
  password_hash text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists slenk_notes_user_settings (
  user_id text primary key references slenk_notes_users(id) on delete cascade,
  active_provider_id text,
  active_text_provider_id text,
  active_image_provider_id text
);

create table if not exists slenk_notes_providers (
  id text primary key,
  name text not null default 'Custom Provider',
  provider_type text not null default 'openai-compatible',
  app_type text not null default 'openai',
  base_url text not null default '',
  api_key text not null default '',
  mode text not null default 'image',
  text_model text not null default '',
  image_model text not null default '',
  -- 生图接口形态：json = OpenAI 兼容 JSON（SenseNova 等）；form = GPT-image 中转站（编辑走 multipart/form-data）。
  image_api text not null default 'json',
  notes text not null default '',
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists slenk_notes_tasks (
  id text primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  type text not null,
  label text,
  status text not null default 'queued',
  payload jsonb,
  provider_id text,
  tab text,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists slenk_notes_tasks_user_created_idx
  on slenk_notes_tasks (user_id, created_at desc);

create table if not exists slenk_notes_notes (
  id text primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  title text not null default '',
  content text not null default '',
  tags text[] not null default '{}',
  images jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists slenk_notes_notes_user_created_idx
  on slenk_notes_notes (user_id, created_at desc);

-- Upgrades for databases created before a column existed. Safe to re-run.
alter table slenk_notes_providers add column if not exists image_api text not null default 'json';

-- Supabase-specific hardening (RLS + revoking the anon/authenticated Data API
-- grants) lives in supabase-hardening.sql; apply-schema.mjs runs it only when
-- those roles exist (Supabase), so this file stays portable to TiDB Cloud or
-- a plain local PostgreSQL.

-- 小红书账号绑定：open_id 扫码成功后回填，NULL 表示待绑定。credential_dir 全局唯一，
-- 一个凭证目录只属于一个账号；unique(user_id, open_id) 中 NULL 互不冲突，允许同用户多个待绑定。
create table if not exists slenk_notes_xhs_accounts (
  id text primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  credential_dir text not null unique,
  open_id text,                          -- 扫码回填；NULL 表示待绑定
  nickname text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, open_id)              -- NULL 互不冲突，允许同用户多个待绑定
);
create index if not exists slenk_notes_xhs_accounts_user_idx
  on slenk_notes_xhs_accounts (user_id, created_at desc);

