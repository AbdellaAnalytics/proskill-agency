-- ============================================================================
-- ProSkill — separate Arabic / English product descriptions
-- Run ONCE in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- products.store_description already holds a custom description that overrode
-- BOTH languages, so an Arabic write-up was shown to English visitors too.
-- This adds an Arabic counterpart. Existing rows keep working unchanged:
-- store_description stays the default/English text, and store_description_ar
-- is used for Arabic when it's filled in.
-- ============================================================================

alter table products add column if not exists store_description_ar text;

comment on column products.store_description    is
  'Custom store description (English / default). Falls back to the vendor description when empty.';
comment on column products.store_description_ar is
  'Custom store description in Arabic. Falls back to store_description, then the vendor description.';
