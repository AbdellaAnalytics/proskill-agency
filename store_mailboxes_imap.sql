-- ============================================================================
-- ProSkill Store — قارئ صناديق البريد على سيرفر مخصص
--
-- شغّله مرة واحدة في Supabase SQL Editor. آمن للتشغيل أكتر من مرة.
--
-- ليه:
--   مايكروسوفت بتقفل الدخول بكلمة مرور التطبيق على IMAP تدريجيًا. البديل إن كل
--   حساب هوتميل يحوّل رسايله تلقائيًا لعنوان على دومينك، والنظام يقرا صندوقك
--   إنت — IMAP عادي بكلمة مرور، بلا مايكروسوفت في المعادلة.
--
--   بس صندوقك واحد وبيستقبل بريد كل الحسابات مع بعض. فالقارئ لازم يعرف حاجتين:
--     imap_user  → يدخل بأنهي حساب (support@…)
--     email      → يقرا بريد أنهي حساب (superproskill@outlook.com)
--   ولما الاتنين يختلفوا، الصندوق **مشترك**، والقارئ بيفلتر الرسايل ويسيب بس
--   اللي فيها عنوان حساب العميل ده. أي رسالة تانية عمرها ما بتخرج من الدالة.
--
-- الأعمدة كلها nullable: الصفوف القديمة بتشتغل بالظبط زي ما هي من غير ما تتلمس،
-- والكود محصّن — لو اترفع قبل الملف ده بيرجع للسلوك القديم بدل ما يقع.
-- ============================================================================

begin;

-- سيرفر الـ IMAP. فاضي = استخدم سيرفر المزوّد المعروف (outlook / gmail).
alter table ps_mailboxes add column if not exists imap_host text;

-- حساب الدخول للصندوق. فاضي = ادخل بنفس عنوان الحساب (السلوك القديم).
alter table ps_mailboxes add column if not exists imap_user text;

comment on column ps_mailboxes.imap_host is
  'Custom IMAP hostname, e.g. imap.hostinger.com. NULL falls back to the provider default.';

-- عنوان بديل يثبت ملكية الرسالة، لو التحويل شال العنوان الأصلي من كل الهيدرز.
-- تحطه لو عملت alias لكل حساب: تحوّل عليه، وتكتبه هنا.
alter table ps_mailboxes add column if not exists match_extra text;

comment on column ps_mailboxes.match_extra is
  'A second address that also proves a message belongs to this account — typically a per-account forwarding alias. Used when the forward strips the original recipient from every header.';

comment on column ps_mailboxes.imap_user is
  'Login for a SHARED mailbox that receives forwarded mail for many accounts. When it differs from email, the reader filters messages down to those addressed to email. NULL means the mailbox is dedicated to this one account.';

commit;

-- ============================================================================
-- التحقق: لازم يرجّع 3 صفوف — imap_host و imap_user و match_extra.
-- ============================================================================
select column_name, is_nullable
from information_schema.columns
where table_name = 'ps_mailboxes'
  and column_name in ('imap_host', 'imap_user', 'match_extra')
order by column_name;
