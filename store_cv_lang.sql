-- ============================================================================
-- ProSkill — لغة إخراج السيرة الذاتية
-- شغّله مرة واحدة في Supabase SQL Editor. آمن للتشغيل أكثر من مرة.
-- ============================================================================

alter table ps_cv_orders add column if not exists output_lang text default 'en';

comment on column ps_cv_orders.output_lang is
  'Requested output language: ar, en, de, it, es, tr, nl. Drives both translation and market conventions.';
