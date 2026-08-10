-- ============================================================================
-- ProSkill Storefront — EasyKash payments + web orders
-- ============================================================================

-- Web orders live in their own table (bot `orders` stays untouched).
create table if not exists web_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  product_id uuid not null references products(id),
  quantity int not null check (quantity > 0 and quantity <= 10),
  unit_price_usd numeric(12,2) not null,
  total_usd numeric(12,2) not null,

  customer_email text not null,
  customer_name text,
  customer_phone text,
  user_id uuid references users(id),        -- linked when the customer has an account

  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid','paid','failed','amount_mismatch','refunded')),
  payment_method text,                      -- easykash | wallet | usdt | binance
  easykash_ref text,                        -- provider transaction reference
  paid_at timestamptz,

  -- Fulfilment is SEPARATE from payment: a paid order may still be delivering.
  fulfilment_status text not null default 'pending'
    check (fulfilment_status in ('pending','delivering','delivered','manual_pending','failed')),
  delivered_content text,                   -- plaintext codes shown to the buyer
  vendor_order_id text,
  fulfilled_at timestamptz,
  error_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_web_orders_email on web_orders (lower(customer_email), created_at desc);
create index if not exists idx_web_orders_status on web_orders (payment_status, fulfilment_status);
create unique index if not exists uniq_web_orders_easykash_ref
  on web_orders (easykash_ref) where easykash_ref is not null;

alter table web_orders enable row level security;
-- No policies → the anon key cannot read orders. Only the server (service key) can.

-- ----------------------------------------------------------------------------
-- Atomically claim ONE available stock item for an order (own instant products).
-- Returns the encrypted content; marks the item sold. Prevents double-selling.
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
  where product_id = p_product_id and status = 'available'
  order by created_at, id   -- see store_fix_stock_claim.sql: created_at was
                            -- missing on stock_items and broke every claim
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

-- ----------------------------------------------------------------------------
-- Idempotent: mark a web order paid exactly once, and lock it for delivery.
-- Returns did_transition=true ONLY for the first caller — so a duplicate
-- EasyKash callback can never deliver (or charge a vendor) twice.
-- ----------------------------------------------------------------------------
create or replace function mark_web_order_paid(
  p_order_number text,
  p_ref text,
  p_method text
)
returns table (did_transition boolean, order_id uuid, total_usd numeric, product_id uuid, quantity int)
language plpgsql
security definer
as $$
declare
  v_o web_orders%rowtype;
begin
  select * into v_o from web_orders where order_number = p_order_number for update;
  if not found then
    return query select false, null::uuid, 0::numeric, null::uuid, 0;
    return;
  end if;

  if v_o.payment_status = 'paid' then
    -- already processed by an earlier callback
    return query select false, v_o.id, v_o.total_usd, v_o.product_id, v_o.quantity;
    return;
  end if;

  update web_orders
  set payment_status   = 'paid',
      paid_at          = now(),
      easykash_ref     = p_ref,
      payment_method   = coalesce(p_method, payment_method),
      fulfilment_status= 'delivering',
      updated_at       = now()
  where id = v_o.id;

  return query select true, v_o.id, v_o.total_usd, v_o.product_id, v_o.quantity;
end;
$$;
