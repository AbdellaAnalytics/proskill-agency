-- ============================================================================
-- ProSkill — إصلاح سحب الأكواد من المخزون
-- شغّله مرة واحدة في Supabase SQL Editor. آمن للتشغيل أكثر من مرة.
--
-- المشكلة:
--   دالة claim_stock_for_web_order كانت بتعمل "order by created_at" على جدول
--   stock_items، والعمود ده غير موجود في الجدول (الجدول أُنشئ من نظام آخر
--   بأعمدة مختلفة). النتيجة: كل محاولة سحب كود ترجع الخطأ
--   'column "created_at" does not exist' — فالتسليم التلقائي من المخزون
--   لم يعمل أبداً، والتسليم من لوحة التحكم كان يفشل كذلك.
--
-- الإصلاح:
--   1) إضافة العمود (لو ناقص) — يفيد كذلك في معرفة تاريخ إضافة كل كود.
--   2) إعادة تعريف الدالة بترتيب حاسم (الأقدم أولاً، ثم id للحسم) —
--      دوران مخزون سليم: الكود الأقدم يُسلَّم أولاً.
-- ============================================================================

alter table stock_items
  add column if not exists created_at timestamptz not null default now();

comment on column stock_items.created_at is
  'When this code was added to inventory. Used for FIFO rotation on delivery.';

-- ----------------------------------------------------------------------------
-- سحب كود واحد متاح وتعليمه مبيعاً — ذرّي (for update skip locked) بحيث لا
-- يمكن أن يحصل طلبان على نفس الكود، حتى مع طلبات متزامنة.
-- ----------------------------------------------------------------------------
create or replace function claim_stock_for_web_order(
  p_order_id uuid,
  p_product_id uuid
)
returns table (success boolean, message text, content_encrypted text)
language plpgsql
security definer
as $$
declare
  v_item stock_items%rowtype;
begin
  select * into v_item
  from stock_items
  where product_id = p_product_id
    and status = 'available'
  order by created_at, id          -- FIFO، وid يحسم أي تعادل
  for update skip locked
  limit 1;

  if not found then
    return query select false, 'Out of stock', null::text;
    return;
  end if;

  update stock_items
  set status = 'sold', sold_at = now()
  where id = v_item.id;

  return query select true, 'OK', v_item.content_encrypted;
end;
$$;
