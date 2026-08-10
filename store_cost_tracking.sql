-- ============================================================================
-- ProSkill — cost tracking (gross profit)
-- Run ONCE in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- The dashboard could only show revenue. A product selling $1,000 might be
-- earning $50 or $500 and the numbers looked identical. Vendor cost was already
-- known at import time but thrown away, so nothing could compute margin.
--
--   products.cost_usd    — what WE pay for one unit (vendor price, or your own)
--   web_orders.cost_usd  — total cost captured AT THE MOMENT OF SALE
--
-- The order copy matters: vendor prices change. Without it, raising a cost
-- tomorrow would silently rewrite last month's profit.
-- Existing orders keep cost_usd = NULL and are simply excluded from profit,
-- with the dashboard reporting how much of the period it could measure.
-- ============================================================================

alter table products   add column if not exists cost_usd numeric(12,2);
alter table web_orders add column if not exists cost_usd numeric(12,2);

comment on column products.cost_usd is
  'Unit cost to us in USD. Auto-filled from the vendor on import; editable in the dashboard. NULL = unknown.';
comment on column web_orders.cost_usd is
  'Total cost of this order at the time of sale (unit cost x quantity). NULL = cost was unknown then.';
