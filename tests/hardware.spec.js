const { test, expect } = require('@playwright/test');
const { installStub, calls } = require('./support/stub-db');

/**
 * End-to-end tests for the customer hardware portal.
 *
 * Hermetic: the Supabase client is stubbed before page scripts run, so there
 * is no network, no credentials, and nothing written to a real project.
 */

const CATALOG = [
  {
    id: 'p-scanner',
    sku: 'TH-CT47',
    name: 'Honeywell CT47 Mobile Computer',
    category: 'Mobile Computers',
    short_description: 'Rugged Android handheld for tool room check-in and check-out.',
    long_description: null,
    image_url: null,
    spec: null,
    sort_order: 10,
    price_cents: 189900,
    currency: 'CAD',
    lead_time_days: 5,
    availability_label: 'In stock',
    ships_now: true
  },
  {
    id: 'p-printer',
    sku: 'TH-ZD421',
    name: 'Zebra ZD421 Label Printer',
    category: 'Printers',
    short_description: 'Desktop thermal transfer printer for polypropylene tool labels.',
    long_description: null,
    image_url: null,
    spec: null,
    sort_order: 10,
    price_cents: 74900,
    currency: 'CAD',
    lead_time_days: 10,
    availability_label: 'On backorder',
    ships_now: false
  }
];

function fixtures(overrides = {}) {
  return {
    tables: { hardware_catalog: { data: CATALOG, error: null } },
    writes: {},
    ...overrides
  };
}

async function openPortal(page, overrides) {
  await installStub(page, fixtures(overrides));
  await page.goto('/hardware.html');
  await expect(page.getByRole('heading', { name: 'Hardware Catalog' })).toBeVisible();
}

async function addScanner(page, qty = '2') {
  const card = page.locator('.prod', { hasText: 'Honeywell CT47' });
  await card.getByLabel('Quantity of Honeywell CT47 Mobile Computer').fill(qty);
  await card.getByRole('button', { name: /^Add/ }).click();
}

async function fillDetails(page, overrides = {}) {
  const v = {
    company: 'Northgate Mining',
    contact: 'Priya Nadeau',
    email: 'priya@northgate.example',
    address: '18 Shaft Road',
    city: 'Sudbury',
    region: 'ON',
    postal: 'P3E 5J1',
    country: 'Canada',
    ...overrides
  };
  await page.getByLabel('Company Name *').fill(v.company);
  await page.getByLabel('Contact Name *').fill(v.contact);
  await page.getByLabel('Contact Email *').fill(v.email);
  await page.getByLabel('Shipping Address *').fill(v.address);
  await page.getByLabel('City *').fill(v.city);
  await page.getByLabel('State / Province *').fill(v.region);
  await page.getByLabel('Postal / ZIP Code *').fill(v.postal);
  await page.getByLabel('Country *').fill(v.country);
}

async function authorize(page, name = 'Priya Nadeau') {
  await page.getByLabel('Authorized Name *').fill(name);
  await page.getByLabel('I have read and agree').check();
}

test('lists the published catalog with prices and availability', async ({ page }) => {
  await openPortal(page);

  await expect(page.getByRole('heading', { name: 'Mobile Computers' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Printers' })).toBeVisible();

  const scanner = page.locator('.prod', { hasText: 'Honeywell CT47' });
  await expect(scanner).toContainText('$1,899.00');
  await expect(scanner).toContainText('In stock');
  await expect(scanner).toContainText('approx. 5 day lead time');

  const printer = page.locator('.prod', { hasText: 'Zebra ZD421' });
  await expect(printer).toContainText('$749.00');
  await expect(printer).toContainText('On backorder');
});

test('says so plainly when nothing is published', async ({ page }) => {
  await installStub(page, fixtures({
    tables: { hardware_catalog: { data: [], error: null } }
  }));
  await page.goto('/hardware.html');
  await expect(page.getByText('No hardware is listed right now')).toBeVisible();
});

test('surfaces a catalog load failure rather than an empty shelf', async ({ page }) => {
  await installStub(page, fixtures({
    tables: { hardware_catalog: { data: null, error: { message: 'boom' } } }
  }));
  await page.goto('/hardware.html');
  await expect(page.getByText('The hardware catalog could not be loaded')).toBeVisible();
});

test('totals the cart and keeps quantities editable', async ({ page }) => {
  await openPortal(page);
  await addScanner(page, '2');

  const cart = page.locator('.cart-panel');
  await expect(cart).toContainText('Honeywell CT47');
  // 2 × $1,899.00
  await expect(cart).toContainText('$3,798.00');
  await expect(cart).toContainText('2 units');

  await cart.getByLabel('Quantity of Honeywell CT47 Mobile Computer').fill('3');
  await cart.getByLabel('Quantity of Honeywell CT47 Mobile Computer').blur();
  await expect(cart).toContainText('$5,697.00');

  await cart.getByRole('button', { name: 'Remove' }).click();
  await expect(cart).toContainText('Nothing added yet');
});

test('requires delivery details before review', async ({ page }) => {
  await openPortal(page);
  await addScanner(page, '1');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Delivery & Contact' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Review & Authorize' })).toHaveCount(0);

  // A malformed email gets its own message rather than a bare "Required".
  await fillDetails(page, { email: 'not-an-email' });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Enter a valid email address')).toBeVisible();

  await page.getByLabel('Contact Email *').fill('priya@northgate.example');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Review & Authorize' })).toBeVisible();
});

test('submits the order and its line items, then confirms', async ({ page }) => {
  await openPortal(page);
  await addScanner(page, '2');

  const printer = page.locator('.prod', { hasText: 'Zebra ZD421' });
  await printer.getByLabel('Quantity of Zebra ZD421 Label Printer').fill('1');
  await printer.getByRole('button', { name: /^Add/ }).click();

  await page.getByRole('button', { name: 'Continue' }).click();
  await fillDetails(page);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('Northgate Mining')).toBeVisible();
  // 2 × 1,899 + 1 × 749
  await expect(page.locator('tfoot').first()).toContainText('$4,547.00');

  await authorize(page);
  await page.getByRole('button', { name: 'Submit order' }).click();

  await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();
  // The reference appears twice — on screen and in the print-only record.
  await expect(page.locator('.ref')).toHaveText(/Reference: THH-\d{8}-[A-Z2-9]{6}/);

  const recorded = await calls(page);
  const header = recorded.find((c) => c.table === 'hardware_orders' && c.op === 'insert');
  const items = recorded.find((c) => c.table === 'hardware_order_items' && c.op === 'insert');

  expect(header).toBeTruthy();
  expect(header.payload.company_name).toBe('Northgate Mining');
  expect(header.payload.contact_email).toBe('priya@northgate.example');
  expect(header.payload.authorized_name).toBe('Priya Nadeau');
  expect(header.payload.order_ref).toMatch(/^THH-\d{8}-[A-Z2-9]{6}$/);
  expect(header.payload.id).toMatch(/^[0-9a-f-]{36}$/);

  expect(items.payload).toHaveLength(2);
  // Every line hangs off the order id the client generated, which is the only
  // way to file both without SELECT access.
  items.payload.forEach((line) => expect(line.order_id).toBe(header.payload.id));

  const scannerLine = items.payload.find((l) => l.sku === 'TH-CT47');
  expect(scannerLine.quantity).toBe(2);
  expect(scannerLine.unit_price_cents).toBe(189900);
  expect(scannerLine.product_id).toBe('p-scanner');
});

test('explains a price that moved under the customer mid-session', async ({ page }) => {
  // check_violation is what the line-item trigger raises when a product is no
  // longer published at the price the page was showing.
  await openPortal(page, {
    tables: { hardware_catalog: { data: CATALOG, error: null } },
    writes: {
      'hardware_order_items.insert': { data: null, error: { code: '23514' } }
    }
  });

  await addScanner(page, '1');
  await page.getByRole('button', { name: 'Continue' }).click();
  await fillDetails(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await authorize(page);
  await page.getByRole('button', { name: 'Submit order' }).click();

  await expect(page.getByText('no longer available at the price shown')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Order Submitted' })).toHaveCount(0);
});

test('a retry lands on the same order rather than opening a second one', async ({ page }) => {
  await openPortal(page, {
    tables: { hardware_catalog: { data: CATALOG, error: null } },
    writes: {
      // Fail the line items once, succeed on the retry.
      'hardware_order_items.insert': undefined
    }
  });

  await page.evaluate(() => {
    let attempts = 0;
    window.__FIXTURES__.writes['hardware_order_items.insert'] = () => {
      attempts++;
      return attempts === 1
        ? { data: null, error: { message: 'network glitch' } }
        : { data: null, error: null };
    };
  });

  await addScanner(page, '1');
  await page.getByRole('button', { name: 'Continue' }).click();
  await fillDetails(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await authorize(page);

  await page.getByRole('button', { name: 'Submit order' }).click();
  await expect(page.getByText('Something went wrong submitting your order')).toBeVisible();

  await page.getByRole('button', { name: 'Submit order' }).click();
  await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();

  const recorded = await calls(page);
  const headers = recorded.filter((c) => c.table === 'hardware_orders' && c.op === 'insert');
  const items = recorded.filter((c) => c.table === 'hardware_order_items' && c.op === 'insert');

  // The header is written once; only the failed half is retried.
  expect(headers).toHaveLength(1);
  expect(items).toHaveLength(2);
  expect(items[1].payload[0].order_id).toBe(headers[0].payload.id);
});

test('refuses to submit without an authorization', async ({ page }) => {
  await openPortal(page);
  await addScanner(page, '1');
  await page.getByRole('button', { name: 'Continue' }).click();
  await fillDetails(page);
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Authorized Name *').fill('Priya Nadeau');
  await page.getByRole('button', { name: 'Submit order' }).click();

  await expect(page.getByText('Please confirm you agree before submitting')).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.filter((c) => c.op === 'insert')).toHaveLength(0);
});
