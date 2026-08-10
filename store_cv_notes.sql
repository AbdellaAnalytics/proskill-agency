-- ============================================================================
-- ProSkill — إضافة خانة ملاحظات العميل لطلبات السيرة الذاتية
-- شغّله مرة واحدة في Supabase SQL Editor. آمن للتشغيل أكثر من مرة.
-- ============================================================================

alter table ps_cv_orders add column if not exists customer_notes text;

comment on column ps_cv_orders.customer_notes is
  'Free-text requests from the customer (tone, emphasis, what to leave out). Passed to the rewrite as DATA, never as instructions.';
