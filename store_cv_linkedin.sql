-- ============================================================================
-- ProSkill — إضافة رابط LinkedIn لطلبات السيرة الذاتية
-- شغّله مرة واحدة في Supabase SQL Editor. آمن للتشغيل أكثر من مرة.
--
-- منفصل عن store_cv_service.sql لأن الجدول قد يكون أُنشئ بالفعل — تشغيل ملف
-- الإنشاء من جديد لن يضيف عموداً إلى جدول موجود.
-- ============================================================================

alter table ps_cv_orders add column if not exists linkedin_url text;

comment on column ps_cv_orders.linkedin_url is
  'Optional LinkedIn profile URL, normalised before storage. Included in the rewritten CV contact block.';
