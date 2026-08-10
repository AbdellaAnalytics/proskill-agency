-- ============================================================================
-- ProSkill Store — Admin dashboard setup
-- ============================================================================

-- 1) Who is allowed into the dashboard. Server-side check ONLY.
create table if not exists store_admins (
  auth_user_id uuid primary key,
  email text not null,
  created_at timestamptz not null default now()
);
alter table store_admins enable row level security;
-- No policies → unreachable with the anon key. Only the service key reads it.

-- 2) Live USD→EGP exchange rate (cached; refreshed by the server).
create table if not exists store_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table store_settings enable row level security;

insert into store_settings (key, value)
values
  ('fx_usd_egp', '{"rate": 48.5, "markup_percent": 2, "fetched_at": null}'::jsonb)
on conflict (key) do nothing;

-- 3) Helpful views for the dashboard
create index if not exists idx_web_orders_created on web_orders (created_at desc);

-- ============================================================================
-- AFTER creating your admin user in Supabase → Authentication → Users,
-- run this once with YOUR email (replace both values):
--
--   insert into store_admins (auth_user_id, email)
--   select id, email from auth.users where email = 'you@example.com';
-- ============================================================================
