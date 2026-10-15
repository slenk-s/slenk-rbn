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
revoke all on slenk_notes_user_settings from anon, authenticated;
revoke all on slenk_notes_providers from anon, authenticated;
revoke all on slenk_notes_tasks from anon, authenticated;
revoke all on slenk_notes_notes from anon, authenticated;
