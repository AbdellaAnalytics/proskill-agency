-- ============================================================================
-- ProSkill Store — عروض المنتجات
--
-- شغّله مرة واحدة في Supabase SQL Editor. آمن للتشغيل أكتر من مرة.
--
-- عمود واحد بس: سعر العرض. فاضي = مفيش عرض.
--
-- ليه سعر مش نسبة: الرقم اللي بيفرق مع العميل هو اللي هيدفعه، والنسبة بتطلع
-- أرقام زي 7.63. النسبة اللي بتظهر على الشارة بتتحسب من الرقمين للعرض بس.
--
-- الكود محصّن: لو اترفع قبل الملف ده، المتجر بيشتغل بالأسعار العادية بدل ما يقع.
-- ============================================================================

begin;

alter table products add column if not exists sale_price_usd numeric(10,2);

comment on column products.sale_price_usd is
  'Offer price. NULL, zero, or anything not BELOW price_usd means no offer — a typo that adds a zero must never raise the price. Coupons do not apply while this is live.';

commit;

-- ============================================================================
-- التحقق: لازم يرجّع صف واحد.
-- ============================================================================
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'products' and column_name = 'sale_price_usd';
