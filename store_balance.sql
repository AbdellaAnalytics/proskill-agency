-- ============================================================================
-- Vendor balance monitoring + retryable orders
-- ============================================================================

-- Note left by the fulfilment code: why an order stalled, and whether a retry
-- is safe (i.e. the vendor definitely charged nothing).
alter table web_orders add column if not exists admin_note text;

-- Threshold is editable from the dashboard, per vendor.
insert into store_settings (key, value)
values ('low_balance_threshold', '10')
on conflict (key) do nothing;

-- Cached balances so the dashboard doesn't hammer vendor APIs on every load.
insert into store_settings (key, value)
values ('vendor_balances', '{}')
on conflict (key) do nothing;
