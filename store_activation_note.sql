-- ============================================================================
-- ProSkill — editable "how you receive it" line per product
-- Run ONCE in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- The storefront shows a short activation line under each product ("A code you
-- redeem on your own account"). It was derived automatically from
-- delivery_type, which is wrong for products delivered as an invite, a ready
-- account, or anything custom. These columns let the dashboard override that
-- line per product. Leave them empty and the automatic wording is used.
-- ============================================================================

alter table products add column if not exists activation_note    text;
alter table products add column if not exists activation_note_ar text;

comment on column products.activation_note is
  'Optional English override for the storefront activation line. Empty = auto from delivery_type.';
comment on column products.activation_note_ar is
  'Optional Arabic override for the storefront activation line. Empty = auto from delivery_type.';
