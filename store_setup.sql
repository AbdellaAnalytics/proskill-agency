-- ============================================================================
-- ProSkill Storefront — database setup
-- Safe to run once. Shares all existing bot tables (products, users, orders...).
-- ============================================================================

-- 1) Storefront fields on products (dashboard-editable; independent of the bot)
alter table products add column if not exists image_url text;
alter table products add column if not exists store_description text;   -- overrides vendor desc on the website
alter table products add column if not exists store_visible boolean not null default true;
alter table products add column if not exists is_featured boolean not null default false;
alter table products add column if not exists slug text;                -- clean URL: /p/chatgpt-plus
alter table products add column if not exists seo_title text;
alter table products add column if not exists seo_description text;

-- Unique slug when present
create unique index if not exists uniq_products_slug on products (slug) where slug is not null;

-- 2) Website customer accounts (linked to the SAME users row as the bot).
--    A customer can exist on the website without ever using the bot.
alter table users add column if not exists email text;
alter table users add column if not exists auth_user_id uuid;           -- Supabase Auth id (website login)
create unique index if not exists uniq_users_email on users (lower(email)) where email is not null;
create unique index if not exists uniq_users_auth on users (auth_user_id) where auth_user_id is not null;

-- 3) Mark where an order came from (bot vs website) for the dashboard
alter table orders add column if not exists channel text not null default 'bot'
  check (channel in ('bot','web'));
alter table orders add column if not exists customer_email text;

-- 4) Storage bucket for product images (public read).
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- 5) Auto-generate a slug from the product name if none is set
create or replace function set_product_slug()
returns trigger language plpgsql as $$
begin
  if new.slug is null or new.slug = '' then
    new.slug :=
      lower(regexp_replace(coalesce(new.name,'product'), '[^a-zA-Z0-9]+', '-', 'g'))
      || '-' || substr(new.id::text, 1, 6);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_product_slug on products;
create trigger trg_product_slug
  before insert or update on products
  for each row execute function set_product_slug();

-- Backfill slugs for existing products
update products set slug = null where slug is null;
update products set updated_at = now() where slug is null;  -- fires the trigger
