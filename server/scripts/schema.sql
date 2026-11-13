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

-- Access model: the backend connects as the table owner and is the only client.
-- RLS with no policies keeps anon/authenticated at zero rows, but Supabase grants
-- those roles on new public tables by default, so the grants have to be revoked
-- explicitly below to take the tables off the Data API surface.
alter table slenk_notes_users enable row level security;
alter table slenk_notes_user_settings enable row level security;
alter table slenk_notes_providers enable row level security;
alter table slenk_notes_tasks enable row level security;
alter table slenk_notes_notes enable row level security;

-- Least privilege: remove the default Data API grants on the tables above.
revoke all on slenk_notes_users from anon, authenticated;
-- The backend is the only client and connects as the table owner, so removing PUBLIC cannot affect it.
revoke all on slenk_notes_users from public;
revoke all on slenk_notes_user_settings from anon, authenticated;
revoke all on slenk_notes_user_settings from public;
revoke all on slenk_notes_providers from anon, authenticated;
revoke all on slenk_notes_providers from public;
revoke all on slenk_notes_tasks from anon, authenticated;
revoke all on slenk_notes_tasks from public;
revoke all on slenk_notes_notes from anon, authenticated;
revoke all on slenk_notes_notes from public;

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
alter table slenk_notes_xhs_accounts enable row level security;
revoke all on slenk_notes_xhs_accounts from anon, authenticated;
revoke all on slenk_notes_xhs_accounts from public;

-- 管理员只读接口的角色前提
alter table slenk_notes_users add column if not exists role text not null default 'user';
