-- Slenk Notes — SQLite 建表脚本（默认后端）。
-- 表结构即数据层契约；时间统一 UTC ISO-8601 文本。

create table if not exists slenk_notes_users (
  id text not null primary key,
  username text not null unique,
  password_hash text not null,
  is_admin integer not null default 0 check (is_admin in (0, 1)),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists slenk_notes_user_settings (
  user_id text not null primary key references slenk_notes_users(id) on delete cascade,
  active_provider_id text null,
  active_text_provider_id text null,
  active_image_provider_id text null
);

create table if not exists slenk_notes_providers (
  id text not null primary key,
  name text not null default 'Custom Provider',
  provider_type text not null default 'openai-compatible',
  app_type text not null default 'openai',
  base_url text not null default '',
  api_key text not null default '',
  mode text not null default 'image',
  text_model text not null default '',
  image_model text not null default '',
  image_api text not null default 'json',
  notes text not null default '',
  is_active integer not null default 0 check (is_active in (0, 1)),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists slenk_notes_tasks (
  id text not null primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  type text not null,
  label text null,
  status text not null default 'queued',
  payload text null,
  provider_id text null,
  tab text null,
  result text null,
  error text null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists slenk_notes_tasks_user_created_idx
  on slenk_notes_tasks (user_id, created_at desc);

create table if not exists slenk_notes_notes (
  id text not null primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  title text not null default '',
  content text not null default '',
  tags text not null default '[]',
  images text not null default '[]',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists slenk_notes_notes_user_created_idx
  on slenk_notes_notes (user_id, created_at desc);

create table if not exists slenk_notes_xhs_accounts (
  id text not null primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  credential_dir text not null unique,
  open_id text null,
  nickname text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (user_id, open_id)
);

create index if not exists slenk_notes_xhs_accounts_user_idx
  on slenk_notes_xhs_accounts (user_id, created_at desc);

create table if not exists slenk_notes_media (
  id text not null primary key,
  task_id text null references slenk_notes_tasks(id) on delete set null,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  size_bytes integer not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists slenk_notes_media_task_idx on slenk_notes_media (task_id);
create index if not exists slenk_notes_media_user_created_idx
  on slenk_notes_media (user_id, created_at desc);

create table if not exists slenk_notes_meta (
  key text not null primary key,
  value text not null
);
