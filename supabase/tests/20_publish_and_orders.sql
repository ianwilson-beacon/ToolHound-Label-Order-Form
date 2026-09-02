-- Publishing, the repricing trigger, and what anon can actually reach.
--
-- The storefront is a public page holding an INSERT-only key, so these are the
-- assertions that stand between us and either leaking distributor cost or
-- selling a $2,000 scanner for a dollar.

begin;

insert into auth.users (id, email)
  values ('11111111-1111-1111-1111-111111111111', 'staff@toolhound.test');
insert into public.hardware_staff (user_id, email)
  values ('11111111-1111-1111-1111-111111111111', 'staff@toolhound.test');

update public.hardware_settings
   set display_currency = 'CAD', fx_usd_to_cad = 1.40,
       default_markup_pct = 25, stale_after_hours = 48,
       round_price_to_cents = 100
 where id;

insert into public.hardware_products (id, sku, name, category)
values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'TH-CT47', 'Honeywell CT47', 'Mobile Computers'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'TH-NOCOST', 'No Cost Anywhere', 'Printers');

insert into public.hardware_vendor_offers
  (product_id, vendor_code, vendor_sku, cost_cents, currency, availability, stock_qty)
values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bluestar', 'BS-1', 100000, 'CAD', 'in_stock', 12);

-- 1. Publishing snapshots the suggestion onto the product ------------------
do $$
declare
  results record;
  product public.hardware_products;
begin
  select count(*) filter (where published) as published,
         count(*) filter (where not published) as skipped
    into results
    from public.hw_publish_prices(null);

  assert results.published = 1, format('expected 1 published, got %s', results.published);
  assert results.skipped = 1, format('expected 1 skipped, got %s', results.skipped);

  select * into product from public.hardware_products
   where id = 'bbbbbbbb-0000-0000-0000-000000000001';

  assert product.is_published, 'the priced product should be live';
  assert product.published_price_cents = 125000,
    format('expected 125000, got %s', product.published_price_cents);
  assert product.published_cost_cents = 100000, 'cost should be snapshotted for margin reporting';
  assert product.published_vendor_code = 'bluestar', 'the winning vendor should be recorded';
  assert product.published_currency = 'CAD', 'published currency should be the selling currency';

  select * into product from public.hardware_products
   where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  assert not product.is_published, 'a product with no cost must not be on the storefront';
end
$$;

-- 2. A product whose cost goes stale comes off the shelf on the next publish
do $$
declare product public.hardware_products;
begin
  update public.hardware_vendor_offers
     set quoted_at = now() - interval '10 days'
   where product_id = 'bbbbbbbb-0000-0000-0000-000000000001';

  perform public.hw_publish_prices(null);

  select * into product from public.hardware_products
   where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  assert not product.is_published,
    'yesterday''s price cannot be honoured once the feed goes quiet';

  -- Put it back for the order tests below.
  update public.hardware_vendor_offers set quoted_at = now()
   where product_id = 'bbbbbbbb-0000-0000-0000-000000000001';
  perform public.hw_publish_prices(null);
end
$$;

-- 3. The line item trigger discards client-supplied prices -----------------
insert into public.hardware_orders
  (id, order_ref, company_name, contact_name, contact_email, address, city,
   state_province, postal_code, country, authorized_name, approval_date)
values
  ('cccccccc-0000-0000-0000-000000000001', 'THH-TEST-000001', 'Northgate Mining',
   'Priya Nadeau', 'priya@northgate.example', '18 Shaft Road', 'Sudbury', 'ON',
   'P3E 5J1', 'Canada', 'Priya Nadeau', current_date);

do $$
declare line public.hardware_order_items;
begin
  -- A forged request: one dollar, and a product name of their choosing.
  insert into public.hardware_order_items
    (order_id, product_id, sku, name, quantity, unit_price_cents, currency)
  values
    ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'WHATEVER', 'Free Scanner', 2, 100, 'USD');

  select * into line from public.hardware_order_items
   where order_id = 'cccccccc-0000-0000-0000-000000000001';

  assert line.unit_price_cents = 125000,
    format('the trigger must reprice from the catalog, got %s', line.unit_price_cents);
  assert line.currency = 'CAD', 'currency comes from the catalog, not the client';
  assert line.sku = 'TH-CT47', 'sku comes from the catalog, not the client';
  assert line.name = 'Honeywell CT47', 'name comes from the catalog, not the client';
  assert line.quantity = 2, 'quantity is the one thing the client does decide';
end
$$;

-- 4. An unpublished product cannot be ordered ------------------------------
do $$
declare failed boolean := false;
begin
  begin
    insert into public.hardware_order_items
      (order_id, product_id, sku, name, quantity, unit_price_cents, currency)
    values
      ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002',
       'TH-NOCOST', 'No Cost Anywhere', 1, 1000, 'CAD');
  exception when check_violation then
    failed := true;
  end;
  assert failed, 'ordering an unpublished product must be refused';
end
$$;

-- 5. What anon can and cannot reach ----------------------------------------
-- These run as the storefront's own role, which is the only role a customer's
-- browser ever holds.
do $$
declare
  visible integer;
  blocked boolean;
begin
  set local role anon;

  -- The catalog view works and shows the published product.
  select count(*) into visible from public.hardware_catalog;
  assert visible = 1, format('anon should see 1 published product, saw %s', visible);

  -- Distributor cost is not reachable at all.
  blocked := false;
  begin
    perform 1 from public.hardware_vendor_offers;
  exception when insufficient_privilege then
    blocked := true;
  end;
  assert blocked, 'anon must not be able to read hardware_vendor_offers';

  -- Nor is it reachable column by column off the products table.
  blocked := false;
  begin
    perform published_cost_cents from public.hardware_products;
  exception when insufficient_privilege then
    blocked := true;
  end;
  assert blocked, 'anon must not be able to read published_cost_cents';

  blocked := false;
  begin
    perform markup_pct from public.hardware_products;
  exception when insufficient_privilege then
    blocked := true;
  end;
  assert blocked, 'anon must not be able to read markup_pct';

  -- Orders are write-only for anon: filing one is allowed, reading is not.
  blocked := false;
  begin
    perform 1 from public.hardware_orders;
  exception when insufficient_privilege then
    blocked := true;
  end;
  assert blocked, 'anon must not be able to read orders back';

  -- And the cost functions refuse anon outright.
  blocked := false;
  begin
    perform public.hw_best_offer('bbbbbbbb-0000-0000-0000-000000000001');
  exception when insufficient_privilege then
    blocked := true;
  end;
  assert blocked, 'anon must not be able to call hw_best_offer';

  reset role;
end
$$;

-- 5b. The storefront's own role can file a complete order -----------------
-- The full production path: anon inserts the header with a client-generated
-- id, then the line items that reference it, with no ability to read either
-- back. The trigger still reprices, and status still comes from the default.
do $$
declare
  line    public.hardware_order_items;
  header  public.hardware_orders;
begin
  set local role anon;

  insert into public.hardware_orders
    (id, order_ref, company_name, contact_name, contact_email, address, city,
     state_province, postal_code, country, authorized_name, approval_date)
  values
    ('cccccccc-0000-0000-0000-000000000002', 'THH-TEST-000002', 'Kirkland Fabrication',
     'Owen Marsh', 'owen@kirkland.example', '9 Weld Way', 'Timmins', 'ON',
     'P4N 1A1', 'Canada', 'Owen Marsh', current_date);

  insert into public.hardware_order_items
    (order_id, product_id, sku, name, quantity, unit_price_cents, currency)
  values
    ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001',
     'FORGED', 'Forged Name', 1, 1, 'USD');

  reset role;

  select * into line from public.hardware_order_items
   where order_id = 'cccccccc-0000-0000-0000-000000000002';
  assert line.unit_price_cents = 125000,
    format('anon-submitted line should be repriced, got %s', line.unit_price_cents);
  assert line.sku = 'TH-CT47', 'anon cannot choose the sku either';

  select * into header from public.hardware_orders
   where id = 'cccccccc-0000-0000-0000-000000000002';
  assert header.status = 'new', 'status must come from the default, not the client';
end
$$;

-- 5c. anon cannot mark an order shipped ------------------------------------
do $$
declare blocked boolean := false;
begin
  set local role anon;
  begin
    insert into public.hardware_orders
      (id, order_ref, company_name, contact_name, contact_email, address, city,
       state_province, postal_code, country, authorized_name, approval_date, status)
    values
      ('cccccccc-0000-0000-0000-000000000003', 'THH-TEST-000003', 'Kirkland Fabrication',
       'Owen Marsh', 'owen@kirkland.example', '9 Weld Way', 'Timmins', 'ON',
       'P4N 1A1', 'Canada', 'Owen Marsh', current_date, 'shipped');
  exception when insufficient_privilege then
    blocked := true;
  end;
  reset role;
  assert blocked, 'anon must not be able to set an order status';
end
$$;

-- 6. A signed-in user who is not staff sees no cost ------------------------
do $$
declare best record;
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

  select * into best from public.hw_best_offer('bbbbbbbb-0000-0000-0000-000000000001');
  assert best.vendor_code is null,
    'an authenticated non-staff user must not see distributor cost';

  reset role;
end
$$;

-- 7. Staff do see cost, and can publish -----------------------------------
do $$
declare best record;
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

  assert public.hw_is_staff(), 'the fixture user should be staff';

  select * into best from public.hw_best_offer('bbbbbbbb-0000-0000-0000-000000000001');
  assert best.vendor_code = 'bluestar', 'staff should see the winning vendor';

  perform public.hw_publish_prices(array['bbbbbbbb-0000-0000-0000-000000000001'::uuid]);

  reset role;
end
$$;

-- 8. The staff order view rolls up the lines -------------------------------
do $$
declare summary record;
begin
  select * into summary from public.hardware_orders_admin
   where id = 'cccccccc-0000-0000-0000-000000000001';

  assert summary.line_count = 1, format('expected 1 line, got %s', summary.line_count);
  assert summary.unit_count = 2, format('expected 2 units, got %s', summary.unit_count);
  assert summary.subtotal_cents = 250000,
    format('expected 250000 subtotal, got %s', summary.subtotal_cents);
  assert summary.est_cost_cents = 200000,
    format('expected 200000 estimated cost, got %s', summary.est_cost_cents);
end
$$;

rollback;
