-- ============================================================================
-- ProSkill Store — first-party visit & funnel analytics (BI)
--
-- Powers the admin dashboard's BI section (قمع التحويل / مصادر الزيارات /
-- الأجهزة / أداء المنتجات / الفرص الضائعة) WITHOUT Meta or GA4.
--
-- Design:
--   * Browser inserts one row per tracked event (anon key) → no new serverless
--     function is consumed (store stays at 11/12).
--   * RLS = INSERT only. The public can write an event but can NEVER read the
--     table. The dashboard reads aggregates with the service key (bypasses RLS).
--   * product_id has NO foreign key on purpose: analytics must never block on a
--     stale id; an orphan row is harmless.
--   * Idempotent: safe to run on a fresh DB or on top of an earlier version of
--     this table (ADD COLUMN IF NOT EXISTS fills in the BI columns).
-- ============================================================================

begin;

create table if not exists store_views (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  session_id  text,                    -- one browser session (sessionStorage)
  path        text,                    -- '/', '/p/<slug>', '/c/<slug>'
  product_id  uuid,                    -- set for product / checkout events
  kind        text default 'page',     -- 'page' | 'product' | 'checkout'
  source      text default 'direct',   -- 'direct'|'ad'|'social'|'search'|'referral'
  device      text default 'desktop',  -- 'mobile' | 'desktop'
  referrer    text                     -- referring hostname, if any
);

-- Backfill BI columns when running on top of the first (pre-BI) version.
alter table store_views add column if not exists kind     text default 'page';
alter table store_views add column if not exists source   text default 'direct';
alter table store_views add column if not exists device   text default 'desktop';
alter table store_views add column if not exists referrer text;

create index if not exists idx_store_views_created on store_views (created_at desc);
create index if not exists idx_store_views_product on store_views (product_id, created_at desc);
create index if not exists idx_store_views_kind    on store_views (kind, created_at desc);

alter table store_views enable row level security;

-- Public may INSERT an event (fields capped so columns can't be abused as
-- free-form storage). No SELECT policy → the public cannot read the table.
drop policy if exists "public insert a view" on store_views;
create policy "public insert a view"
  on store_views for insert
  to anon, authenticated
  with check (
    char_length(coalesce(path, ''))     <= 200 and
    char_length(coalesce(kind, ''))     <= 20  and
    char_length(coalesce(source, ''))   <= 20  and
    char_length(coalesce(device, ''))   <= 20  and
    char_length(coalesce(referrer, '')) <= 200
  );

commit;

-- Verification: table exists with RLS on.
select relname, relrowsecurity from pg_class where relname = 'store_views';
