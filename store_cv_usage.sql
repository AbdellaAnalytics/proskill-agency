-- ============================================================================
-- ProSkill — تتبّع استهلاك وتكلفة خدمة السيرة الذاتية
-- شغّله مرة واحدة في Supabase SQL Editor. آمن للتشغيل أكثر من مرة.
--
-- لماذا:
--   التكلفة كانت تُحسب لحظة الإشعار ثم تُنسى، فلا يوجد تاريخ يُبنى عليه قرار
--   "أشحن بكام وكل قد إيه". هذه الأعمدة تحفظ الاستهلاك الفعلي لكل طلب، فتصبح
--   لوحة التحكم قادرة على عرض متوسط حقيقي بدل تقدير.
-- ============================================================================

alter table ps_cv_orders add column if not exists tokens_in    integer;
alter table ps_cv_orders add column if not exists tokens_out   integer;
alter table ps_cv_orders add column if not exists api_cost_usd numeric(10,4);

comment on column ps_cv_orders.api_cost_usd is
  'Estimated Anthropic API cost for this rewrite, in USD. Used for the burn-rate panel.';
