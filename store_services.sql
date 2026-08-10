-- ============================================================================
-- ProSkill Digital Agency — Career Services
-- Run ONCE in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- Powers the "Career services" section on the storefront and its admin tab.
-- Each row is one service card (LinkedIn optimization, CV ATS, Cover Letter,
-- CV Canadian, CV Europass, ...). Managed entirely from the admin dashboard.
-- ============================================================================

create table if not exists ps_services (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,                       -- e.g. "CV ATS"
  title_ar      text,                                -- Arabic title (optional)
  description   text,                                -- English description
  description_ar text,                               -- Arabic description
  icon          text default '📄',                   -- emoji fallback / SVG key
  image_url     text,                                -- uploaded logo; overrides icon when set
  price_usd     numeric(10,2),                       -- optional; null = "quote on WhatsApp"
  wa_message    text,                                -- prefilled WhatsApp order text
  sort_order    int  not null default 0,             -- display order (asc)
  is_active     boolean not null default true,       -- shown on the storefront
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- keep updated_at fresh
create or replace function ps_services_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_ps_services_touch on ps_services;
create trigger trg_ps_services_touch
  before update on ps_services
  for each row execute function ps_services_touch();

-- ---------------------------------------------------------------------------
-- RLS: public may READ active services; only admins may write.
-- Writes happen through the admin API (service_role), which bypasses RLS, so
-- the public policies below only need to cover anon SELECT of active rows.
-- ---------------------------------------------------------------------------
alter table ps_services enable row level security;

drop policy if exists ps_services_read_active on ps_services;
create policy ps_services_read_active
  on ps_services for select
  using (is_active = true);

-- ---------------------------------------------------------------------------
-- Seed the five launch services (only if the table is empty).
-- ---------------------------------------------------------------------------
insert into ps_services (title, title_ar, description, description_ar, icon, wa_message, sort_order)
select * from (values
  ('LinkedIn Profile Optimization', 'تحسين بروفايل LinkedIn',
   'A recruiter-magnet headline, a compelling About, and the right keywords so recruiters find you.',
   'عنوان احترافي، قسم About مقنع، وكلمات مفتاحية تخلّي المسؤولين يوصلولك — بروفايل يجذب فرص العمل.',
   'linkedin', 'مرحبًا، عايز أطلب خدمة تحسين بروفايل LinkedIn', 10),
  ('CV ATS', 'CV احترافي (ATS)',
   'A resume that passes ATS filters and reaches a human — tailored to your target role.',
   'سيرة ذاتية تعدّي أنظمة الفرز الآلي (ATS) وتوصل لعين مسؤول التوظيف — مصمّمة لوظيفتك المستهدفة.',
   'ats', 'مرحبًا، عايز أطلب خدمة كتابة CV احترافي (ATS)', 20),
  ('Cover Letter', 'خطاب تقديم (Cover Letter)',
   'A persuasive, role-specific cover letter that complements your CV and gets you noticed.',
   'خطاب تقديم مقنع ومخصّص للوظيفة، يكمّل سيرتك الذاتية ويلفت الانتباه ليك.',
   'cover', 'مرحبًا، عايز أطلب خدمة كتابة Cover Letter', 30),
  ('CV Canadian', 'CV كندي',
   'A Canadian-format CV aligned with local hiring norms — ready for jobs and PR applications.',
   'سيرة ذاتية بالصيغة الكندية المتوافقة مع معايير التوظيف هناك — جاهزة للوظائف وطلبات الإقامة.',
   'canada', 'مرحبًا، عايز أطلب خدمة CV كندي', 40),
  ('CV Europass', 'CV أوروبي (Europass)',
   'A Europass-format CV accepted across Europe — ready for EU jobs and study applications.',
   'سيرة ذاتية بصيغة Europass المعتمدة أوروبيًا — جاهزة للتقديم على الوظائف والدراسة في أوروبا.',
   'europe', 'مرحبًا، عايز أطلب خدمة CV أوروبي (Europass)', 50)
) as v(title, title_ar, description, description_ar, icon, wa_message, sort_order)
where not exists (select 1 from ps_services);
