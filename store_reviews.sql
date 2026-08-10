-- ============================================================================
-- ProSkill Store — verified-buyer reviews
--
-- Core rule: a review can only exist for an order that was actually PAID and
-- DELIVERED, by the person who bought it. No anonymous reviews, ever.
-- ============================================================================

create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  order_number text not null references web_orders(order_number),

  rating smallint not null check (rating between 1 and 5),
  comment text check (char_length(comment) <= 600),
  author_name text,                              -- display name, may be trimmed

  is_published boolean not null default true,    -- admin can hide abuse
  created_at timestamptz not null default now(),

  -- one review per order
  constraint uniq_review_per_order unique (order_number)
);

create index if not exists idx_reviews_product on reviews (product_id, created_at desc);

alter table reviews enable row level security;

-- Anyone may READ published reviews (needed for the public product page).
drop policy if exists "public read published reviews" on reviews;
create policy "public read published reviews"
  on reviews for select
  to anon, authenticated
  using (is_published = true);

-- Nobody may write directly. Only the server (service key) inserts, after it
-- has verified the order belongs to the reviewer and was delivered.

-- ----------------------------------------------------------------------------
-- Submit a review. SECURITY DEFINER so it can check web_orders, but it
-- verifies ownership itself: order must be paid + delivered + email match.
-- ----------------------------------------------------------------------------
create or replace function submit_review(
  p_order_number text,
  p_email text,
  p_rating smallint,
  p_comment text,
  p_author text
)
returns table (ok boolean, message text)
language plpgsql
security definer
as $$
declare
  o web_orders%rowtype;
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    return query select false, 'التقييم من 1 إلى 5';
    return;
  end if;

  select * into o
  from web_orders
  where order_number = upper(trim(p_order_number))
    and lower(customer_email) = lower(trim(p_email));

  if not found then
    return query select false, 'لم نجد طلباً بهذه البيانات';
    return;
  end if;

  if o.payment_status <> 'paid' then
    return query select false, 'هذا الطلب غير مدفوع';
    return;
  end if;

  if o.fulfilment_status <> 'delivered' then
    return query select false, 'يمكنك التقييم بعد استلام المنتج';
    return;
  end if;

  if exists (select 1 from reviews where order_number = o.order_number) then
    return query select false, 'قيّمت هذا الطلب من قبل';
    return;
  end if;

  insert into reviews (product_id, order_number, rating, comment, author_name)
  values (
    o.product_id,
    o.order_number,
    p_rating,
    nullif(trim(coalesce(p_comment, '')), ''),
    nullif(trim(coalesce(p_author, '')), '')
  );

  return query select true, 'ok';
end;
$$;

-- ----------------------------------------------------------------------------
-- Aggregated rating per product, for the catalog + product page.
-- ----------------------------------------------------------------------------
create or replace view product_ratings as
select
  product_id,
  round(avg(rating)::numeric, 1) as avg_rating,
  count(*)::int as review_count
from reviews
where is_published = true
group by product_id;
