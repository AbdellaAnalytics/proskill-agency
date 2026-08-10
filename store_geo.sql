-- ============================================================================
-- ProSkill Store — البلاد والمدن في لوحة التحكم
--
-- شغّله مرة واحدة في Supabase SQL Editor. آمن للتشغيل أكتر من مرة.
--
-- بيضيف بس: ما بيمسحش ولا بيغيّر أي عمود موجود، وكل الأعمدة nullable
-- فالصفوف القديمة بتفضل زي ما هي من غير ما تتلمس.
--
-- الكود محصّن: لو اترفع قبل الملف ده، الطلبات بتتسجّل عادي من غير موقع،
-- واللوحة بتشتغل من غير الكروت الجديدة — بدل ما تقع.
-- ============================================================================

begin;

-- --- الطلبات (منتجات) -------------------------------------------------------
-- بتتملى من هيدرز Vercel وقت إنشاء الطلب.
alter table web_orders   add column if not exists geo_country text;
alter table web_orders   add column if not exists geo_region  text;
alter table web_orders   add column if not exists geo_city    text;

comment on column web_orders.geo_country is
  'ISO-3166 alpha-2 from the Vercel geo header at order time. Approximate: IP geolocation places a buyer near their exit node.';

-- --- طلبات السيرة الذاتية ---------------------------------------------------
alter table ps_cv_orders add column if not exists geo_country text;
alter table ps_cv_orders add column if not exists geo_region  text;
alter table ps_cv_orders add column if not exists geo_city    text;

-- --- الزيارات ---------------------------------------------------------------
-- الزيارة بتتكتب من المتصفح على Supabase مباشرة — مفيش request بيوصل السيرفر،
-- فمفيش هيدرز نقراها. المنطقة الزمنية هي الإشارة الوحيدة المتاحة من غير ما كل
-- فتح صفحة يتحوّل لاستدعاء دالة. بتدّي الدولة بدقة معقولة، مش المدينة.
alter table store_views  add column if not exists tz text;

comment on column store_views.tz is
  'IANA timezone from the browser (e.g. Africa/Cairo). Country-level signal only — a visitor in Alexandria reports Africa/Cairo.';

-- فهارس على اللي بيتجمّع فعلًا في اللوحة.
create index if not exists idx_web_orders_geo   on web_orders  (geo_country, created_at desc);
create index if not exists idx_cv_orders_geo    on ps_cv_orders (geo_country, created_at desc);
create index if not exists idx_store_views_tz   on store_views (tz, created_at desc);

-- --- سياسة الزيارات ---------------------------------------------------------
-- إعادة إنشاء سياسة الإدخال عشان تحُدّ طول العمود الجديد زي باقي الأعمدة.
-- الكود القديم اللي مش بيبعت tz بيعدّي عادي: coalesce(null,'') طوله صفر.
drop policy if exists "public insert a view" on store_views;
create policy "public insert a view"
  on store_views for insert
  to anon, authenticated
  with check (
    char_length(coalesce(path, ''))     <= 200 and
    char_length(coalesce(kind, ''))     <= 20  and
    char_length(coalesce(source, ''))   <= 20  and
    char_length(coalesce(device, ''))   <= 20  and
    char_length(coalesce(referrer, '')) <= 200 and
    char_length(coalesce(tz, ''))       <= 60
  );

commit;

-- ============================================================================
-- التحقق: لازم يرجّع 7 صفوف — 3 لكل جدول طلبات، و tz للزيارات.
-- ============================================================================
select table_name, column_name
from information_schema.columns
where (table_name = 'web_orders'   and column_name in ('geo_country', 'geo_region', 'geo_city'))
   or (table_name = 'ps_cv_orders' and column_name in ('geo_country', 'geo_region', 'geo_city'))
   or (table_name = 'store_views'  and column_name = 'tz')
order by table_name, column_name;
