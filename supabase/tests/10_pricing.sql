-- Pricing rules: cheapest landed cost, currency, staleness, availability.
--
-- These are the assertions that matter commercially. If the "cheapest of two
-- distributors" logic is wrong, the storefront sells at a loss and nothing in
-- the browser tests would notice.

begin;

-- Fixtures ------------------------------------------------------------------
insert into auth.users (id, email)
  values ('11111111-1111-1111-1111-111111111111', 'staff@toolhound.test');
insert into public.hardware_staff (user_id, email)
  values ('11111111-1111-1111-1111-111111111111', 'staff@toolhound.test');

update public.hardware_settings
   set display_currency = 'CAD',
       fx_usd_to_cad = 1.40,
       default_markup_pct = 25,
       stale_after_hours = 48,
       round_price_to_cents = 100
 where id;

insert into public.hardware_products (id, sku, name, category)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'TH-CT47', 'Honeywell CT47', 'Mobile Computers'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'TH-ZD421', 'Zebra ZD421', 'Printers'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'TH-STALE', 'Stale Only', 'Printers'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'TH-MANUAL', 'Manually Priced', 'Printers'),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'TH-DISC', 'Discontinued Everywhere', 'Printers');

-- 1. Currency conversion decides which vendor is actually cheaper -----------
-- BlueStar quotes CAD 1,450.00; ScanSource quotes USD 1,030.00, which lands at
-- CAD 1,442.00 at 1.40. The USD number looks smaller before conversion and is
-- also genuinely cheaper after it — but only by CAD 8.
insert into public.hardware_vendor_offers
  (product_id, vendor_code, vendor_sku, cost_cents, currency, availability, stock_qty)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'bluestar', 'BS-1', 145000, 'CAD', 'in_stock', 20),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'scansource', 'SS-1', 103000, 'USD', 'in_stock', 15);

do $$
declare best record;
begin
  select * into best from public.hw_best_offer('aaaaaaaa-0000-0000-0000-000000000001');
  assert best.vendor_code = 'scansource',
    format('expected scansource to win, got %s', best.vendor_code);
  assert best.landed_cost_cents = 144200,
    format('expected landed 144200, got %s', best.landed_cost_cents);
end
$$;

-- 2. Freight and duty are part of "cheapest" -------------------------------
-- Same quotes, but the US shipment carries CAD 150 of freight and duty per
-- unit. Converted and added, ScanSource is now the expensive one.
update public.hardware_vendor_offers
   set landed_add_cents = 15000
 where product_id = 'aaaaaaaa-0000-0000-0000-000000000001'
   and vendor_code = 'scansource';

do $$
declare best record;
begin
  select * into best from public.hw_best_offer('aaaaaaaa-0000-0000-0000-000000000001');
  assert best.vendor_code = 'bluestar',
    format('freight should flip the winner to bluestar, got %s', best.vendor_code);
end
$$;

update public.hardware_vendor_offers
   set landed_add_cents = 0
 where product_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- 3. An in-stock offer beats a cheaper backordered one ---------------------
-- The point of drop-shipping is that the box ships. A backordered saving is
-- not a saving.
insert into public.hardware_vendor_offers
  (product_id, vendor_code, vendor_sku, cost_cents, currency, availability, stock_qty)
values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'bluestar', 'BS-2', 50000, 'CAD', 'backorder', 0),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'scansource', 'SS-2', 58000, 'CAD', 'in_stock', 9);

do $$
declare best record;
begin
  select * into best from public.hw_best_offer('aaaaaaaa-0000-0000-0000-000000000002');
  assert best.vendor_code = 'scansource',
    format('in-stock should beat cheaper backorder, got %s', best.vendor_code);
end
$$;

-- 4. A stale quote is not used at all --------------------------------------
insert into public.hardware_vendor_offers
  (product_id, vendor_code, vendor_sku, cost_cents, currency, availability, quoted_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000003', 'bluestar', 'BS-3', 30000, 'CAD', 'in_stock',
   now() - interval '5 days');

do $$
declare best record;
begin
  select * into best from public.hw_best_offer('aaaaaaaa-0000-0000-0000-000000000003');
  assert best.vendor_code is null,
    'a quote older than the staleness window must not price anything';
  assert public.hw_suggested_price_cents('aaaaaaaa-0000-0000-0000-000000000003') is null,
    'no fresh cost must mean no suggested price';
end
$$;

-- 5. Discontinued is excluded even when fresh ------------------------------
insert into public.hardware_vendor_offers
  (product_id, vendor_code, vendor_sku, cost_cents, currency, availability)
values
  ('aaaaaaaa-0000-0000-0000-000000000005', 'bluestar', 'BS-5', 20000, 'CAD', 'discontinued');

do $$
declare best record;
begin
  select * into best from public.hw_best_offer('aaaaaaaa-0000-0000-0000-000000000005');
  assert best.vendor_code is null, 'discontinued stock must not be priced';
end
$$;

-- 6. Markup, rounding and the margin floor --------------------------------
do $$
declare suggested integer;
begin
  -- 144200 × 1.25 = 180250, rounded up to the whole dollar.
  suggested := public.hw_suggested_price_cents('aaaaaaaa-0000-0000-0000-000000000001');
  assert suggested = 180300, format('expected 180300, got %s', suggested);

  -- A per-product markup overrides the default.
  update public.hardware_products set markup_pct = 40
   where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  suggested := public.hw_suggested_price_cents('aaaaaaaa-0000-0000-0000-000000000001');
  assert suggested = 201900, format('expected 201900 at 40%%, got %s', suggested);

  -- A margin floor wins over a markup that would earn less than it.
  update public.hardware_products
     set markup_pct = 1, min_margin_cents = 50000
   where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  suggested := public.hw_suggested_price_cents('aaaaaaaa-0000-0000-0000-000000000001');
  assert suggested = 194200, format('expected cost+50000, got %s', suggested);

  -- Rounding never lands below the floor.
  assert suggested >= 144200 + 50000, 'rounding must not eat the margin floor';

  update public.hardware_products
     set markup_pct = 25, min_margin_cents = 0
   where id = 'aaaaaaaa-0000-0000-0000-000000000001';
end
$$;

-- 7. A manual price ignores cost entirely ---------------------------------
do $$
begin
  update public.hardware_products
     set pricing_mode = 'manual', price_override_cents = 99900
   where id = 'aaaaaaaa-0000-0000-0000-000000000004';

  assert public.hw_suggested_price_cents('aaaaaaaa-0000-0000-0000-000000000004') = 99900,
    'a manual override is the price, with or without a vendor cost';
end
$$;

-- 8. Rounding increment is configurable -----------------------------------
do $$
declare suggested integer;
begin
  update public.hardware_settings set round_price_to_cents = 1 where id;
  suggested := public.hw_suggested_price_cents('aaaaaaaa-0000-0000-0000-000000000001');
  assert suggested = 180250, format('expected the exact figure 180250, got %s', suggested);
  update public.hardware_settings set round_price_to_cents = 100 where id;
end
$$;

rollback;
