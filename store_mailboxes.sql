-- ============================================================================
-- ProSkill — صندوق بريد الحسابات المُباعة
-- شغّله مرة واحدة في Supabase SQL Editor. آمن للتشغيل أكثر من مرة.
--
-- الغرض:
--   الحسابات التي تُباع ببريدها (Adobe، ChatGPT، SuperGrok…) تصلها أكواد تحقق
--   على صندوق لا يستطيع العميل فتحه — معه كلمة مرور الخدمة لا كلمة مرور البريد.
--   هذا الجدول يحفظ بيانات الدخول للصندوق (مشفّرة) حتى يتمكن الموقع من عرض
--   آخر رسالة للعميل صاحب الطلب، بدل أن يظل ينتظرك.
--
-- الأمان:
--   * كلمة مرور التطبيق تُخزَّن مشفّرة بنفس مفتاح المخزون (ENCRYPTION_KEY).
--   * RLS مفعّل بلا أي policy — لا قراءة عامة إطلاقاً. كل وصول عبر الـ API
--     بمفتاح الخدمة، وبعد التحقق أن الطالب هو صاحب الطلب فعلاً.
-- ============================================================================

create table if not exists ps_mailboxes (
  id            uuid primary key default gen_random_uuid(),

  -- عنوان البريد كما هو مكتوب في المخزون، بحروف صغيرة للمطابقة
  email         text not null unique,

  -- كلمة مرور التطبيق (App Password) مشفّرة — ليست كلمة مرور الحساب
  secret_enc    text not null,

  provider      text not null default 'outlook'
    check (provider in ('outlook', 'gmail', 'other')),

  is_active     boolean not null default true,
  last_read_at  timestamptz,
  error_note    text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_ps_mailboxes_email on ps_mailboxes (lower(email));

create or replace function ps_mailboxes_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_ps_mailboxes_touch on ps_mailboxes;
create trigger trg_ps_mailboxes_touch
  before update on ps_mailboxes
  for each row execute function ps_mailboxes_touch();

alter table ps_mailboxes enable row level security;
-- بلا policies = ممنوع تماماً على anon key. مقصود.
