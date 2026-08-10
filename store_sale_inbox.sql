-- ============================================================================
-- ProSkill — وارد مبيعات المتجر  (شغّله في Supabase بتاع **نظام الإدارة**)
--
-- ⚠️ مش قاعدة المتجر. دي القاعدة اللي البرنامج بيقرا منها:
--    jsemibrimkacjbbsdozm.supabase.co
--
-- آمن للتشغيل أكتر من مرة.
-- ============================================================================
--
-- ليه جدول منفصل ومش كتابة في proskill_workspace مباشرة:
--
--   البرنامج كله محفوظ في عمود jsonb واحد. أي كتابة فيه معناها اقرا الملف كله
--   → عدّل → ارجّعه. ولو المتجر عمل كده وإنت فاتح البرنامج في نفس اللحظة، اللي
--   بيحفظ أخيرًا بيمسح شغل التاني بالكامل — مش صف، الـ637 مبيعة كلها.
--
--   وكمان البرنامج بيكتب نسختين في كل حفظة (الـUUID + فهرس الإيميل)، فأي كاتب
--   من برّه لازم يقلّد ده بالظبط وإلا النسختين يختلفوا في صمت.
--
--   فالمتجر بيكتب هنا، والبرنامج — وهو الوحيد اللي بيلمس الـjsonb — بيقرا من هنا
--   ويدخّل بعد موافقتك. مفيش تصادم ممكن يحصل أصلًا.
-- ============================================================================

begin;

create table if not exists store_sale_inbox (
  -- رقم طلب المتجر. مفتاح أساسي عشان نفس الطلب عمره ما يتسجّل مرتين مهما
  -- اتبعت كام مرة — التكرار بيتمنع في الداتابيز مش في الكود.
  order_number   text primary key,

  customer_name  text,
  customer_email text,
  customer_phone text,

  product_name   text,
  quantity       integer not null default 1,

  -- بالدولار زي ما المتجر بيسجّلها. البرنامج بيحوّل للجنيه بسعره وقت الموافقة.
  price_usd      numeric(10,2),
  cost_usd       numeric(10,2),

  payment_method text,
  coupon_code    text,
  geo_country    text,
  geo_city       text,
  paid_at        timestamptz,

  -- pending → approved | ignored. البرنامج هو اللي بيغيّرها.
  status         text not null default 'pending'
                 check (status in ('pending', 'approved', 'ignored')),
  handled_at     timestamptz,
  -- معرّف المبيعة اللي اتعملت في البرنامج، عشان الرجوع من الاتنين لبعض.
  sale_id        text,

  created_at     timestamptz not null default now()
);

-- الشاشة بتعرض المعلّق الأحدث الأول.
create index if not exists idx_store_sale_inbox_pending
  on store_sale_inbox (status, created_at desc);

-- --- الصلاحيات --------------------------------------------------------------
-- الجدول ده فيه إيميلات وتليفونات عملاء، والمفتاح العام بتاع البرنامج موجود
-- في كود الصفحة وأي حد يقدر يقراه. فمن غير الحماية دي، أي زائر يسحب قايمة
-- عملائك. القراءة لمن سجّل دخول بس؛ والكتابة للمتجر بمفتاح الخدمة اللي بيتخطّى
-- الحماية دي أصلًا — فمفيش سياسة كتابة هنا عن قصد.
alter table store_sale_inbox enable row level security;

drop policy if exists "signed-in can read inbox"   on store_sale_inbox;
drop policy if exists "signed-in can update inbox" on store_sale_inbox;

create policy "signed-in can read inbox"
  on store_sale_inbox for select to authenticated using (true);

create policy "signed-in can update inbox"
  on store_sale_inbox for update to authenticated using (true) with check (true);

commit;

-- ============================================================================
-- التحقق: لازم يرجّع صف واحد فيه اسم الجدول و rls_enabled = true
-- ============================================================================
select c.relname as table_name, c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.tablename = 'store_sale_inbox') as policies
from pg_class c
where c.relname = 'store_sale_inbox';
