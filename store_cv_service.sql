-- ============================================================================
-- ProSkill — خدمة CV ATS الفورية
-- شغّله مرة واحدة في Supabase SQL Editor. آمن للتشغيل أكثر من مرة.
--
-- كل صف = طلب واحد لإعادة صياغة سيرة ذاتية. مفصول عن web_orders لأن هذه
-- خدمة وليست منتجاً من الكتالوج: لا مخزون، ولا كود يُسلَّم، والمخرج نص طويل
-- يُنتَج بعد الدفع.
-- ============================================================================

create table if not exists ps_cv_orders (
  id             uuid primary key default gen_random_uuid(),
  order_number   text not null unique,          -- CV-XXXXXX

  -- ما أدخله العميل
  customer_email text not null,
  customer_name  text,
  customer_phone text,
  target_role    text not null,                 -- الوظيفة المستهدفة
  job_description text,                         -- الوصف الوظيفي (يرفع الجودة كثيراً)
  with_photo     boolean not null default false,
  photo_url      text,                          -- في حال اختار "بصورة"
  source_text    text not null,                 -- النص المستخرج من ملفه

  -- الدفع
  price_usd      numeric(10,2) not null,
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid','paid','failed','refunded')),
  payment_method text,
  easykash_ref   text,

  -- المخرج
  status text not null default 'pending'
    check (status in ('pending','processing','ready','failed')),
  result_cv      text,                          -- السيرة الذاتية الجاهزة
  result_report  jsonb,                         -- التحليل: الكلمات الناقصة، نسبة المطابقة
  error_note     text,

  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  updated_at     timestamptz not null default now()
);

create index if not exists idx_ps_cv_orders_email on ps_cv_orders (lower(customer_email));
create index if not exists idx_ps_cv_orders_created on ps_cv_orders (created_at desc);

create or replace function ps_cv_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_ps_cv_touch on ps_cv_orders;
create trigger trg_ps_cv_touch
  before update on ps_cv_orders
  for each row execute function ps_cv_touch();

-- ---------------------------------------------------------------------------
-- RLS: لا قراءة عامة إطلاقاً.
-- الصف يحتوي على السيرة الذاتية الكاملة للعميل وبياناته الشخصية — وهذه بيانات
-- أكثر حساسية من أي شيء آخر في المتجر. كل وصول يمر عبر الـ API بمفتاح
-- service_role بعد التحقق من رقم الطلب + البريد، أو من لوحة التحكم.
-- ---------------------------------------------------------------------------
alter table ps_cv_orders enable row level security;
-- بلا أي policy = ممنوع تماماً على anon key. مقصود.
