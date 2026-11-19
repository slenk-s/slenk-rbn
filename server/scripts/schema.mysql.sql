-- ============================================================================
-- Slenk Notes — MySQL 8.0 版建表脚本（替代 PostgreSQL/TiDB 版）
-- ----------------------------------------------------------------------------
-- 来源：server/scripts/schema.sql（PostgreSQL），按 MySQL 8.0 语法转换。
--
-- 需要的 MySQL 版本：8.0.13+（JSON 列 DEFAULT 表达式），8.0+（索引 DESC）。
-- 引擎统一 InnoDB，字符集 utf8mb4（utf8mb4_0900_ai_ci 默认，LIKE 大小写不敏感，
-- 与 pg 的 ilike 行为一致）。
--
-- 关键类型转换（PG → MySQL）：
--   text primary key        → varchar(64)   （MySQL 不允许 TEXT 做主键/唯一索引）
--   boolean                 → tinyint(1)    （mysql2 返回 0/1 数字，代码里避免 === true）
--   timestamptz             → datetime(3)   （无时区；见下方"时区约定"）
--   jsonb                   → json          （mysql2 读取自动解析为 JS 对象；写入须 JSON.stringify）
--   text[] (tags)           → json          （PG 数组 → JSON 数组；写入须 JSON.stringify）
--   text (content/notes…)   → longtext      （PG text 无上限；MySQL text 仅 64KB）
--   now() 默认值            → UTC_TIMESTAMP(3)
--
-- 时区约定：MySQL DATETIME 无时区。连接必须把会话时区固定为 UTC（mysql2 连接配置
-- timezone: 'Z' 或 '+00:00'，且默认值用 UTC_TIMESTAMP(3) 时要求会话时区为 UTC），
-- 应用层读写统一 UTC，才能和原 PG timestamptz 行为一致，否则会出现 +8 小时偏移。
--
-- 迁移注意（PG 专属 SQL → MySQL）：
--   insert … returning *        → 不支持；用 ResultSetHeader.insertId/affectedRows + 重新 select
--   … on conflict (x) do …      → … on duplicate key update … / insert ignore …
--   $1,$2 占位符                → ? 占位符（mysql2）
--   create index if not exists  → 不支持；索引直接写在 CREATE TABLE 内（下方已内联）
--   jsonb 默认 '[]'::jsonb      → default (json_array())（8.0.13+）
-- ============================================================================

-- 表前缀沿用 slenk_notes_，与原库同名。
create table if not exists slenk_notes_users (
  id varchar(64) not null,
  username varchar(255) not null,
  password_hash varchar(255) not null,
  is_admin tinyint(1) not null default 0,
  created_at datetime(3) not null default (UTC_TIMESTAMP(3)),
  primary key (id),
  unique key slenk_notes_users_username_key (username)
) engine = InnoDB default charset = utf8mb4;

create table if not exists slenk_notes_user_settings (
  user_id varchar(64) not null,
  active_provider_id varchar(64) null,
  active_text_provider_id varchar(64) null,
  active_image_provider_id varchar(64) null,
  primary key (user_id),
  constraint slenk_notes_user_settings_user_fk
    foreign key (user_id) references slenk_notes_users(id) on delete cascade
) engine = InnoDB default charset = utf8mb4;

create table if not exists slenk_notes_providers (
  id varchar(64) not null,
  name varchar(255) not null default 'Custom Provider',
  provider_type varchar(64) not null default 'openai-compatible',
  app_type varchar(64) not null default 'openai',
  base_url varchar(512) not null default '',
  api_key varchar(512) not null default '',
  mode varchar(64) not null default 'image',
  text_model varchar(512) not null default '',
  image_model varchar(512) not null default '',
  -- 生图接口形态：json = OpenAI 兼容 JSON（SenseNova 等）；form = GPT-image 中转站（编辑走 multipart/form-data）。
  image_api varchar(64) not null default 'json',
  notes longtext not null default (''),
  is_active tinyint(1) not null default 0,
  created_at datetime(3) not null default (UTC_TIMESTAMP(3)),
  updated_at datetime(3) not null default (UTC_TIMESTAMP(3)),
  primary key (id)
) engine = InnoDB default charset = utf8mb4;

create table if not exists slenk_notes_tasks (
  id varchar(64) not null,
  user_id varchar(64) not null,
  type varchar(64) not null,
  label varchar(255) null,
  status varchar(64) not null default 'queued',
  payload json null,
  provider_id varchar(64) null,
  tab varchar(255) null,
  result json null,
  error longtext null,
  created_at datetime(3) not null default (UTC_TIMESTAMP(3)),
  updated_at datetime(3) not null default (UTC_TIMESTAMP(3)),
  primary key (id),
  key slenk_notes_tasks_user_created_idx (user_id, created_at desc),
  constraint slenk_notes_tasks_user_fk
    foreign key (user_id) references slenk_notes_users(id) on delete cascade
) engine = InnoDB default charset = utf8mb4;

create table if not exists slenk_notes_notes (
  id varchar(64) not null,
  user_id varchar(64) not null,
  title varchar(512) not null default '',
  content longtext not null default (''),
  -- PG 的 text[] → MySQL json（JSON 字符串数组）。写入须 JSON.stringify。
  tags json not null default (json_array()),
  images json not null default (json_array()),
  created_at datetime(3) not null default (UTC_TIMESTAMP(3)),
  primary key (id),
  key slenk_notes_notes_user_created_idx (user_id, created_at desc),
  constraint slenk_notes_notes_user_fk
    foreign key (user_id) references slenk_notes_users(id) on delete cascade
) engine = InnoDB default charset = utf8mb4;

-- 小红书账号绑定：open_id 扫码成功后回填，NULL 表示待绑定。credential_dir 全局唯一，
-- 一个凭证目录只属于一个账号；unique(user_id, open_id) 中 NULL 互不冲突（MySQL 唯一索引
-- 允许多个 NULL，行为与 PG 一致），允许同用户多个待绑定。
create table if not exists slenk_notes_xhs_accounts (
  id varchar(64) not null,
  user_id varchar(64) not null,
  credential_dir varchar(512) not null,
  open_id varchar(255) null,               -- 扫码回填；NULL 表示待绑定
  nickname varchar(255) not null default '',
  created_at datetime(3) not null default (UTC_TIMESTAMP(3)),
  updated_at datetime(3) not null default (UTC_TIMESTAMP(3)),
  primary key (id),
  unique key slenk_notes_xhs_accounts_credential_dir_key (credential_dir),
  unique key slenk_notes_xhs_accounts_user_openid_key (user_id, open_id),
  key slenk_notes_xhs_accounts_user_idx (user_id, created_at desc),
  constraint slenk_notes_xhs_accounts_user_fk
    foreign key (user_id) references slenk_notes_users(id) on delete cascade
) engine = InnoDB default charset = utf8mb4;

-- 媒体字节存 <mediaDir>/<id> 文件，本表只存元数据。
-- 升级路径：先跑 node scripts/migrate-media-files.mjs --drop-column。
create table if not exists slenk_notes_media (
  id varchar(64) not null,
  task_id varchar(64) null,               -- 所属任务，可空兼容独立媒体
  user_id varchar(64) not null,
  filename varchar(512) not null,         -- 原文件名（下载时用）
  mime_type varchar(128) not null,
  size_bytes bigint not null,
  created_at datetime(3) not null default (UTC_TIMESTAMP(3)),
  primary key (id),
  key slenk_notes_media_task_idx (task_id),
  key slenk_notes_media_user_created_idx (user_id, created_at desc),
  constraint slenk_notes_media_task_fk
    foreign key (task_id) references slenk_notes_tasks(id) on delete set null,
  constraint slenk_notes_media_user_fk
    foreign key (user_id) references slenk_notes_users(id) on delete cascade
) engine = InnoDB default charset = utf8mb4;
