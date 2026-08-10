-- ============================================================================
-- ProSkill Storefront — public read access (RLS)
-- The website runs in the customer's browser with the ANON key, so we open
-- ONLY what the catalog needs: active, visible products + categories.
-- Everything else (users, orders, stock, invoices) stays locked.
-- ============================================================================

-- Products: anyone may READ active + store-visible rows. No insert/update/delete.
drop policy if exists "public read active products" on products;
create policy "public read active products"
  on products for select
  to anon, authenticated
  using (is_active = true and store_visible = true);

-- Categories: anyone may READ active categories.
drop policy if exists "public read active categories" on categories;
create policy "public read active categories"
  on categories for select
  to anon, authenticated
  using (is_active = true);

-- Everything else stays closed by default (RLS is enabled with no policies),
-- so the anon key can NOT read users, orders, stock_items, transactions,
-- crypto_invoices, support_tickets, or pending_deliveries.

-- Product images bucket: public read only.
drop policy if exists "public read product images" on storage.objects;
create policy "public read product images"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'product-images');
