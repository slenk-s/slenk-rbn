-- Supabase-only hardening, applied by apply-schema.mjs when the anon /
-- authenticated Data API roles exist. Not portable to TiDB Cloud or a plain
-- local PostgreSQL, which is why it lives outside schema.sql.

-- Access model: the backend connects as the table owner and is the only client.
-- RLS with no policies keeps anon/authenticated at zero rows, but Supabase grants
-- those roles on new public tables by default, so the grants have to be revoked
-- explicitly below to take the tables off the Data API surface.
alter table slenk_notes_users enable row level security;
alter table slenk_notes_user_settings enable row level security;
alter table slenk_notes_providers enable row level security;
alter table slenk_notes_tasks enable row level security;
alter table slenk_notes_notes enable row level security;
alter table slenk_notes_xhs_accounts enable row level security;

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
revoke all on slenk_notes_xhs_accounts from anon, authenticated;
revoke all on slenk_notes_xhs_accounts from public;
