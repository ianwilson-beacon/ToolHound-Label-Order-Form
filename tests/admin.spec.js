const { test, expect } = require('@playwright/test');
const { installStub, calls } = require('./support/stub-db');

/**
 * End-to-end tests for the staff hardware console.
 *
 * The parts worth pinning down are the ones that touch money: what the pricing
 * grid says the price should become, and whether a distributor price file maps
 * onto the right products at the right cost.
 */

const SETTINGS = {
  id: true,
  display_currency: 'CAD',
  fx_usd_to_cad: 1.37,
  default_markup_pct: 25,
  stale_after_hours: 48,
  round_price_to_cents: 100
};

const VENDORS = [
  { code: 'bluestar', name: 'BlueStar', active: true },
  { code: 'scansource', name: 'ScanSource', active: true }
];

const PRODUCTS = [
  {
    id: 'p-scanner', sku: 'TH-CT47', name: 'Honeywell CT47 Mobile Computer',
    category: 'Mobile Computers', sort_order: 10, pricing_mode: 'auto',
    markup_pct: null, min_margin_cents: 0, price_override_cents: null,
    lead_time_days: 5, is_published: true, short_description: null,
    long_description: null, image_url: null
  },
  {
    id: 'p-printer', sku: 'TH-ZD421', name: 'Zebra ZD421 Label Printer',
    category: 'Printers', sort_order: 10, pricing_mode: 'auto',
    markup_pct: 30, min_margin_cents: 0, price_override_cents: null,
    lead_time_days: 10, is_published: false, short_description: null,
    long_description: null, image_url: null
  }
];

const PRICING = [
  {
    ...PRODUCTS[0],
    published_price_cents: 179900, published_currency: 'CAD',
    published_cost_cents: 140000, published_vendor_code: 'bluestar',
    published_availability: 'in_stock', published_at: new Date().toISOString(),
    best_vendor_code: 'scansource', best_vendor_sku: 'SS-99881',
    best_cost_cents: 105000, best_cost_currency: 'USD',
    best_landed_cost_cents: 143850, best_availability: 'in_stock',
    best_stock_qty: 44, best_quoted_at: new Date().toISOString(),
    suggested_price_cents: 180000
  },
  {
    ...PRODUCTS[1],
    published_price_cents: null, published_currency: null,
    published_cost_cents: null, published_vendor_code: null,
    published_availability: null, published_at: null,
    best_vendor_code: null, best_vendor_sku: null,
    best_cost_cents: null, best_cost_currency: null,
    best_landed_cost_cents: null, best_availability: null,
    best_stock_qty: null,
    // Older than the 48 hour window, so there is no suggestion to publish.
    best_quoted_at: new Date(Date.now() - 96 * 3600 * 1000).toISOString(),
    suggested_price_cents: null
  }
];

const OFFERS = [
  {
    id: 'o1', product_id: 'p-scanner', vendor_code: 'scansource',
    vendor_sku: 'SS-99881', cost_cents: 105000, currency: 'USD',
    landed_add_cents: 0, availability: 'in_stock', stock_qty: 44,
    quoted_at: new Date().toISOString(), source: 'csv'
  }
];

function staffFixtures(overrides = {}) {
  return {
    session: { user: { id: 'u1', email: 'dean@toolhound.com' } },
    rpc: { hw_is_staff: { data: true, error: null } },
    tables: {
      hardware_settings: { data: [SETTINGS], error: null },
      hardware_vendors: { data: VENDORS, error: null },
      hardware_pricing_admin: { data: PRICING, error: null },
      hardware_vendor_offers: { data: OFFERS, error: null },
      hardware_products: { data: PRODUCTS, error: null }
    },
    writes: {},
    ...overrides
  };
}

async function openConsole(page, overrides) {
  await installStub(page, staffFixtures(overrides));
  await page.goto('/admin.html');
  await expect(page.getByRole('heading', { name: 'Pricing' })).toBeVisible();
}

test('asks for a sign in before showing anything', async ({ page }) => {
  await installStub(page, { session: null });
  await page.goto('/admin.html');

  await expect(page.getByRole('heading', { name: 'Staff Sign In' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pricing' })).toHaveCount(0);
});

test('reports a bad password instead of a blank screen', async ({ page }) => {
  await installStub(page, { session: null, signInError: 'Invalid login credentials' });
  await page.goto('/admin.html');

  await page.getByLabel('Email').fill('dean@toolhound.com');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('Invalid login credentials')).toBeVisible();
});

test('a signed-in account that is not on the allowlist is told why', async ({ page }) => {
  await installStub(page, {
    session: { user: { id: 'u9', email: 'someone@example.com' } },
    rpc: { hw_is_staff: { data: false, error: null } }
  });
  await page.goto('/admin.html');

  await expect(page.getByRole('heading', { name: 'No Access' })).toBeVisible();
  await expect(page.getByText('not on the hardware staff')).toBeVisible();
});

test('shows the cheapest vendor, the suggestion, and the change it implies', async ({ page }) => {
  await openConsole(page);

  const row = page.locator('tbody tr', { hasText: 'TH-CT47' });
  await expect(row).toContainText('ScanSource');
  await expect(row).toContainText('SS-99881');
  // Landed cost is shown in the selling currency, not the USD the file quoted.
  await expect(row).toContainText('$1,438.50');
  await expect(row).toContainText('$1,800.00');   // suggested
  await expect(row).toContainText('$1,799.00');   // live
  await expect(row.locator('.delta-up')).toContainText('+$1.00');
  await expect(row).toContainText('live');

  // Nothing fresh for the printer, so there is no suggestion and the cost age
  // is flagged rather than quietly ignored.
  const stale = page.locator('tbody tr', { hasText: 'TH-ZD421' });
  await expect(stale).toContainText('none');
  await expect(stale.locator('.badge.bad').first()).toBeVisible();
  await expect(stale).toContainText('hidden');
});

test('publishes only the selected products', async ({ page }) => {
  await openConsole(page, staffFixtures({
    rpc: {
      hw_is_staff: { data: true, error: null },
      hw_publish_prices: {
        data: [{ product_id: 'p-scanner', sku: 'TH-CT47', price_cents: 180000, published: true }],
        error: null
      }
    }
  }));

  const row = page.locator('tbody tr', { hasText: 'TH-CT47' });
  await row.getByLabel('Select TH-CT47').check();
  await page.getByRole('button', { name: 'Publish selected (1)' }).click();

  await expect(page.getByText('1 price published to the storefront')).toBeVisible();

  const recorded = await calls(page);
  const publish = recorded.find((c) => c.rpc === 'hw_publish_prices');
  expect(publish.params.p_product_ids).toEqual(['p-scanner']);
});

test('warns when a publish takes products off the storefront', async ({ page }) => {
  await openConsole(page, staffFixtures({
    rpc: {
      hw_is_staff: { data: true, error: null },
      hw_publish_prices: {
        data: [
          { product_id: 'p-scanner', sku: 'TH-CT47', price_cents: 180000, published: true },
          { product_id: 'p-printer', sku: 'TH-ZD421', price_cents: null, published: false }
        ],
        error: null
      }
    }
  }));

  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Publish all' }).click();

  await expect(page.getByText('1 product had no fresh distributor cost')).toBeVisible();

  const recorded = await calls(page);
  const publish = recorded.find((c) => c.rpc === 'hw_publish_prices');
  expect(publish.params.p_product_ids).toBeNull();
});

test('a markup edit is saved against the product, not published straight away', async ({ page }) => {
  await openConsole(page);

  const row = page.locator('tbody tr', { hasText: 'TH-CT47' });
  await row.getByLabel('Markup percent for TH-CT47').fill('32');
  await row.getByLabel('Markup percent for TH-CT47').blur();

  await page.getByRole('button', { name: 'Save 1 change' }).click();
  await expect(page.getByText('Publish to push the new prices')).toBeVisible();

  const recorded = await calls(page);
  const update = recorded.find((c) => c.table === 'hardware_products' && c.op === 'update');
  expect(update.payload.markup_pct).toBe(32);
  expect(recorded.some((c) => c.rpc === 'hw_publish_prices')).toBe(false);
});

test('imports a distributor price file, matching on ToolHound SKU', async ({ page }) => {
  await openConsole(page);
  await page.getByRole('button', { name: 'Distributor Costs' }).click();

  await expect(page.getByRole('heading', { name: 'Import a Distributor Price File' })).toBeVisible();

  // Deliberately awkward: a quoted description containing a comma, a dollar
  // sign in the price, and a SKU that is not in the catalog.
  const csv = [
    'Item Number,Mfg Part Number,Description,Reseller Price,Qty Available',
    'SS-99881,TH-CT47,"Handheld, rugged","$1,020.00",88',
    'SS-77123,TH-ZD421,"Printer, desktop",$540.50,2',
    'SS-00000,TH-NOPE,"Not ours",$10.00,5'
  ].join('\n');

  await page.locator('textarea').fill(csv);
  await page.getByRole('button', { name: 'Read pasted CSV' }).click();

  await expect(page.getByText('3 data rows detected')).toBeVisible();
  // The header guesser should find the SKU and price columns unaided.
  await expect(page.getByLabel('ToolHound SKU *')).toHaveValue('1');
  await expect(page.getByLabel('Unit cost *')).toHaveValue('3');

  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('2 lines would import, 1 skipped')).toBeVisible();

  await page.getByRole('button', { name: 'Import costs' }).click();
  await expect(page.getByText('2 costs imported for BlueStar')).toBeVisible();

  const recorded = await calls(page);
  const upsert = recorded.find((c) => c.table === 'hardware_vendor_offers' && c.op === 'upsert');

  expect(upsert.options.onConflict).toBe('product_id,vendor_code');
  expect(upsert.payload).toHaveLength(2);

  const scanner = upsert.payload.find((o) => o.product_id === 'p-scanner');
  expect(scanner.vendor_sku).toBe('SS-99881');
  expect(scanner.cost_cents).toBe(102000);
  expect(scanner.availability).toBe('in_stock');
  expect(scanner.stock_qty).toBe(88);

  // Two available is below the low-stock threshold, so the file's bare number
  // still produces a sensible status.
  const printer = upsert.payload.find((o) => o.product_id === 'p-printer');
  expect(printer.cost_cents).toBe(54050);
  expect(printer.availability).toBe('low_stock');

  // The unmatched SKU is reported, not silently dropped.
  await expect(page.getByRole('heading', { name: 'Skipped Lines' })).toBeVisible();
  await expect(page.getByText('no product with this SKU')).toBeVisible();
});

test('refuses to import when the cost column is not mapped', async ({ page }) => {
  await openConsole(page);
  await page.getByRole('button', { name: 'Distributor Costs' }).click();

  await page.locator('textarea').fill('Widget,Notes\nTH-CT47,nothing useful here');
  await page.getByRole('button', { name: 'Read pasted CSV' }).click();
  await page.getByRole('button', { name: 'Import costs' }).click();

  await expect(page.getByText('Map at least the ToolHound SKU and the cost column')).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.some((c) => c.op === 'upsert')).toBe(false);
});

test('rejects an FX rate that would price everything at zero', async ({ page }) => {
  await openConsole(page);
  await page.getByRole('button', { name: 'Settings' }).click();

  await page.getByLabel('USD → CAD Rate').fill('0');
  await page.getByRole('button', { name: 'Save settings' }).click();

  await expect(page.getByText('FX rate must be a positive number')).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.some((c) => c.table === 'hardware_settings')).toBe(false);
});

test('lists orders with the margin they imply', async ({ page }) => {
  await openConsole(page, staffFixtures({
    tables: {
      hardware_settings: { data: [SETTINGS], error: null },
      hardware_vendors: { data: VENDORS, error: null },
      hardware_pricing_admin: { data: PRICING, error: null },
      hardware_vendor_offers: { data: OFFERS, error: null },
      hardware_products: { data: PRODUCTS, error: null },
      hardware_orders_admin: {
        data: [{
          id: 'ord-1', order_ref: 'THH-20260902-ABC123',
          submitted_at: new Date().toISOString(),
          company_name: 'Northgate Mining', contact_name: 'Priya Nadeau',
          contact_email: 'priya@northgate.example', contact_phone: null,
          address: '18 Shaft Road', city: 'Sudbury', state_province: 'ON',
          postal_code: 'P3E 5J1', country: 'Canada', po_number: 'PO-4412',
          notes: null, status: 'new', line_count: 1, unit_count: 2,
          subtotal_cents: 359800, est_cost_cents: 287700
        }],
        error: null
      },
      hardware_order_items: {
        data: [{
          id: 'i1', order_id: 'ord-1', product_id: 'p-scanner', sku: 'TH-CT47',
          name: 'Honeywell CT47 Mobile Computer', quantity: 2,
          unit_price_cents: 179900, currency: 'CAD'
        }],
        error: null
      }
    }
  }));

  await page.getByRole('button', { name: 'Orders' }).click();

  const row = page.locator('tbody tr', { hasText: 'THH-20260902-ABC123' });
  await expect(row).toContainText('Northgate Mining');
  await expect(row).toContainText('$3,598.00');
  await expect(row.locator('.delta-up')).toContainText('$721.00');

  await row.getByRole('button', { name: 'Show lines' }).click();
  await expect(page.getByText('18 Shaft Road, Sudbury, ON, P3E 5J1, Canada · PO PO-4412')).toBeVisible();
  const lines = page.locator('tbody tr', { hasText: 'Honeywell CT47 Mobile Computer' }).last();
  await expect(lines).toContainText('$1,799.00');
  await expect(lines).toContainText('$3,598.00');
});
