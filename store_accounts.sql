-- ============================================================================
-- ProSkill Store — customer accounts (website only, separate from the bot)
-- ============================================================================

-- Link a web order to a Supabase Auth account.
alter table web_orders add column if not exists auth_user_id uuid;
create index if not exists idx_web_orders_auth on web_orders (auth_user_id);

-- ----------------------------------------------------------------------------
-- Let a signed-in customer read ONLY their own orders.
--
-- Two ways an order belongs to them:
--   1. auth_user_id matches (bought while signed in), OR
--   2. customer_email matches their verified account email — this makes orders
--      placed as a guest BEFORE signing up appear automatically.
--
-- Codes are still only exposed for paid+delivered orders (enforced in the API).
-- ----------------------------------------------------------------------------
drop policy if exists "customers read own orders" on web_orders;
create policy "customers read own orders"
  on web_orders for select
  to authenticated
  using (
    auth_user_id = auth.uid()
    or lower(customer_email) = lower(auth.jwt() ->> 'email')
  );

-- Customers may never insert/update/delete orders directly.
-- (Only the server, using the service key, writes to this table.)

-- ----------------------------------------------------------------------------
-- Claim guest orders when a customer signs up / signs in with the same email.
-- Runs server-side with the service key.
-- ----------------------------------------------------------------------------
create or replace function claim_orders_for_user(p_user_id uuid, p_email text)
returns integer
language plpgsql
security definer
as $$
declare
  v_count integer;
begin
  update web_orders
  set auth_user_id = p_user_id
  where auth_user_id is null
    and lower(customer_email) = lower(p_email);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
