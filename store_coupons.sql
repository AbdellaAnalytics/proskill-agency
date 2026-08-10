-- ============================================================================
-- ProSkill Store — discount coupons
-- ============================================================================

create table if not exists coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                    -- always stored UPPERCASE
  type text not null check (type in ('percent','fixed')),
  value numeric(10,2) not null check (value > 0),

  min_order_usd numeric(10,2) not null default 0,
  max_discount_usd numeric(10,2),               -- caps a percent coupon
  max_uses integer,                             -- null = unlimited
  used_count integer not null default 0,
  max_uses_per_email integer default 1,         -- null = unlimited

  starts_at timestamptz,
  expires_at timestamptz,
  is_active boolean not null default true,

  created_at timestamptz not null default now()
);

alter table coupons enable row level security;
-- No policies: the anon key can never read coupon rows (no code guessing).

-- Which order used which coupon (also enforces per-email limits).
alter table web_orders add column if not exists coupon_code text;
alter table web_orders add column if not exists discount_usd numeric(10,2) not null default 0;
alter table web_orders add column if not exists subtotal_usd numeric(12,2);

create index if not exists idx_web_orders_coupon on web_orders (coupon_code)
  where coupon_code is not null;

-- ----------------------------------------------------------------------------
-- Validate a coupon for a given subtotal + email. Returns the discount amount.
-- Pure function: it never mutates anything, so it is safe to call from the
-- "preview" endpoint the customer hits while typing.
-- ----------------------------------------------------------------------------
create or replace function validate_coupon(
  p_code text,
  p_subtotal numeric,
  p_email text
)
returns table (valid boolean, reason text, discount numeric, final_total numeric)
language plpgsql
security definer
as $$
declare
  c coupons%rowtype;
  v_email_uses integer;
  v_discount numeric;
begin
  select * into c from coupons where code = upper(trim(p_code));

  if not found or not c.is_active then
    return query select false, 'الكود غير صحيح', 0::numeric, p_subtotal;
    return;
  end if;

  if c.starts_at is not null and now() < c.starts_at then
    return query select false, 'الكود لم يبدأ بعد', 0::numeric, p_subtotal;
    return;
  end if;

  if c.expires_at is not null and now() > c.expires_at then
    return query select false, 'انتهت صلاحية الكود', 0::numeric, p_subtotal;
    return;
  end if;

  if c.max_uses is not null and c.used_count >= c.max_uses then
    return query select false, 'تم استهلاك هذا الكود', 0::numeric, p_subtotal;
    return;
  end if;

  if p_subtotal < c.min_order_usd then
    return query select false,
      'الحد الأدنى للطلب $' || trim(to_char(c.min_order_usd, 'FM999990.00')),
      0::numeric, p_subtotal;
    return;
  end if;

  if c.max_uses_per_email is not null and p_email is not null then
    select count(*) into v_email_uses
    from web_orders
    where coupon_code = c.code
      and lower(customer_email) = lower(p_email)
      and payment_status = 'paid';

    if v_email_uses >= c.max_uses_per_email then
      return query select false, 'استخدمت هذا الكود من قبل', 0::numeric, p_subtotal;
      return;
    end if;
  end if;

  -- compute
  if c.type = 'percent' then
    v_discount := round(p_subtotal * c.value / 100.0, 2);
    if c.max_discount_usd is not null and v_discount > c.max_discount_usd then
      v_discount := c.max_discount_usd;
    end if;
  else
    v_discount := c.value;
  end if;

  -- never discount below the gateway minimum of $1
  if p_subtotal - v_discount < 1 then
    v_discount := greatest(p_subtotal - 1, 0);
  end if;

  return query select true, 'ok', v_discount, round(p_subtotal - v_discount, 2);
end;
$$;

-- ----------------------------------------------------------------------------
-- Increment usage. Called ONLY after a payment is confirmed, so abandoned
-- checkouts never consume a coupon.
-- ----------------------------------------------------------------------------
create or replace function consume_coupon(p_code text)
returns void
language plpgsql
security definer
as $$
begin
  update coupons
  set used_count = used_count + 1
  where code = upper(trim(p_code));
end;
$$;

-- Example coupon (uncomment to create):
-- insert into coupons (code, type, value, min_order_usd, max_discount_usd, max_uses, expires_at)
-- values ('WELCOME10', 'percent', 10, 3, 5, 100, now() + interval '30 days');
