const { test, expect } = require('@playwright/test');

/**
 * End-to-end tests for the internal orders dashboard.
 *
 * Hermetic, like the form suite: `window.__TOOLHOUND_CLIENT__` stands in for
 * the Supabase client, serving both its `.auth` and its `.from`. No network,
 * no credentials, nothing written anywhere.
 *
 * These tests cover what the page renders. They cannot cover the part that
 * actually protects the data — the RLS policy in
 * 0006_restrict_staff_reads.sql — because that runs in the database.
 */

const DAY = 86400000;

function iso(daysAgo) {
  return new Date(Date.now() - daysAgo * DAY).toISOString();
}

const ORDERS = [
  {
    id: 'id-old',
    order_ref: 'THL-AAAA-BBBBBB',
    submitted_at: iso(21),
    status: 'received',
    po_sent_at: null,
    production_confirmed_at: null,
    shipped_at: null,
    cancelled_at: null,
    updated_at: iso(21),
    internal_notes: null,
    company_name: 'Northgate Mining',
    contact_name: 'Priya Raman',
    contact_email: 'priya@northgate.example',
    address: '9 Shaft Rd',
    city: 'Sudbury',
    state_province: 'ON',
    postal_code: 'P3A 1A1',
    country: 'Canada',
    logo_choice: 'custom_logo',
    logo_file_name: 'northgate.svg',
    signature_data:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    text_lines: null,
    full_color: 'Yes',
    quantity: 2500,
    start_seq: 1,
    instructions: 'Match the orange from our helmets.',
    authorized_name: 'Priya Raman',
    approval_date: '2026-08-12'
  },
  {
    id: 'id-mid',
    order_ref: 'THL-CCCC-DDDDDD',
    submitted_at: iso(3),
    status: 'po_sent',
    po_sent_at: iso(2),
    production_confirmed_at: null,
    shipped_at: null,
    cancelled_at: null,
    updated_at: iso(2),
    internal_notes: 'Waiting on the vendor to confirm stock.',
    company_name: 'Acme Industrial',
    contact_name: 'Dana Reyes',
    contact_email: 'dana@acme.example',
    address: '400 Foundry Rd',
    city: 'Hamilton',
    state_province: 'ON',
    postal_code: 'L8E 2W1',
    country: 'Canada',
    logo_choice: 'custom_text',
    logo_file_name: null,
    signature_data: null,
    text_lines: ['ACME', 'TOOL'],
    full_color: 'No',
    quantity: 500,
    start_seq: 1000,
    instructions: null,
    authorized_name: 'Dana Reyes',
    approval_date: '2026-08-30'
  },
  {
    id: 'id-done',
    order_ref: 'THL-EEEE-FFFFFF',
    submitted_at: iso(40),
    status: 'shipped',
    po_sent_at: iso(38),
    production_confirmed_at: iso(35),
    shipped_at: iso(30),
    cancelled_at: null,
    updated_at: iso(30),
    internal_notes: null,
    company_name: 'Harbour Works',
    contact_name: 'Sam Oyelaran',
    contact_email: 'sam@harbour.example',
    address: '2 Dock St',
    city: 'Halifax',
    state_province: 'NS',
    postal_code: 'B3J 1A1',
    country: 'Canada',
    logo_choice: 'toolhound_logo',
    logo_file_name: null,
    signature_data: null,
    text_lines: null,
    full_color: 'Yes',
    quantity: 100,
    start_seq: 5000,
    instructions: null,
    authorized_name: 'Sam Oyelaran',
    approval_date: '2026-07-20'
  }
];

async function blockCdns(page) {
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
}

/**
 * Stub the Supabase client: `.auth` for the gate, `.from` for the data. One
 * object, because that is how the real client works — the session token rides
 * along on queries automatically, so there is no separate token seam to fake.
 *
 * `email: null` means signed out.
 */
async function stubClient(page, { email = 'ian.wilson@beaconsoftware.com', orders = ORDERS, failUpdate = null } = {}) {
  await page.addInitScript(
    ({ email, orders, failUpdate }) => {
      window.__AUTH_CALLS__ = { signOut: 0, oauth: [], otp: [] };
      window.__UPDATES__ = [];
      window.__SELECTS__ = [];
      window.__ORDERS__ = orders;

      const session = email
        ? { user: { email, app_metadata: { provider: 'google' } } }
        : null;

      function result(data) {
        const p = Promise.resolve({ data, error: null });
        p.order = () => p;
        p.eq = () => p;
        p.limit = () => p;
        p.select = () => p;
        return p;
      }

      window.__TOOLHOUND_CLIENT__ = {
        auth: {
          getSession: () => Promise.resolve({ data: { session }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signInWithOAuth: (opts) => {
            window.__AUTH_CALLS__.oauth.push(opts);
            return Promise.resolve({ data: {}, error: null });
          },
          signInWithOtp: (opts) => {
            window.__AUTH_CALLS__.otp.push(opts);
            return Promise.resolve({ data: {}, error: null });
          },
          signOut: () => {
            window.__AUTH_CALLS__.signOut++;
            return Promise.resolve({ error: null });
          }
        },
        from() {
          return {
            select(columns) {
              window.__SELECTS__.push(columns);
              if (String(columns).indexOf('logo_file_data') !== -1) {
                return result([{
                  logo_file_name: 'northgate.svg',
                  logo_file_data: 'data:image/svg+xml;base64,PHN2Zy8+'
                }]);
              }
              return result(window.__ORDERS__);
            },
            update(patch) {
              window.__UPDATES__.push(patch);
              if (failUpdate) {
                const p = Promise.resolve({ data: null, error: { message: failUpdate } });
                p.eq = () => p;
                p.select = () => p;
                return p;
              }
              const ref = {};
              const chain = {
                eq(_col, id) { ref.id = id; return chain; },
                select() {
                  const row = Object.assign(
                    {}, window.__ORDERS__.find((o) => o.id === ref.id), patch);
                  // Mirror the trigger: entering a stage stamps it.
                  if (patch.status === 'po_sent' && !row.po_sent_at) {
                    row.po_sent_at = new Date().toISOString();
                  }
                  if (patch.status === 'shipped' && !row.shipped_at) {
                    row.shipped_at = new Date().toISOString();
                  }
                  row.updated_at = new Date().toISOString();
                  window.__ORDERS__ = window.__ORDERS__.map((o) =>
                    o.id === row.id ? row : o);
                  return Promise.resolve({ data: [row], error: null });
                }
              };
              return chain;
            }
          };
        }
      };
    },
    { email, orders, failUpdate }
  );
}

async function openDashboard(page, opts = {}) {
  await blockCdns(page);
  await stubClient(page, opts);
  await page.goto('/admin.html');
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('refuses to render when the order system is unreachable', async ({ page }) => {
  await blockCdns(page);
  // No client stub and no Supabase library (the CDN is blocked), so the page
  // cannot reach the database. It must say so, not show a dashboard.
  await page.goto('/admin.html');

  await expect(page.getByRole('heading', { name: 'Dashboard not available' })).toBeVisible();
  await expect(page.getByText('Northgate Mining')).toHaveCount(0);
});

test('shows the sign-in gate when nobody is signed in', async ({ page }) => {
  await openDashboard(page, { email: null });

  await expect(page.getByRole('heading', { name: 'ToolHound Label Orders' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByText('Northgate Mining')).toHaveCount(0);
});

test('Google sign-in hints the account picker at the Beacon domain', async ({ page }) => {
  await openDashboard(page, { email: null });
  await page.getByRole('button', { name: 'Continue with Google' }).click();

  const calls = await page.evaluate(() => window.__AUTH_CALLS__.oauth);
  expect(calls).toHaveLength(1);
  expect(calls[0].provider).toBe('google');
  expect(calls[0].options.queryParams.hd).toBe('beaconsoftware.com');
});

test('requests a magic link for a typed address', async ({ page }) => {
  await openDashboard(page, { email: null });

  await page.getByLabel('Work email').fill('Ian.Wilson@BeaconSoftware.com');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();

  await expect(page.getByText(/Check ian\.wilson@beaconsoftware\.com for a sign-in link/)).toBeVisible();
  const otp = await page.evaluate(() => window.__AUTH_CALLS__.otp);
  expect(otp[0].email).toBe('ian.wilson@beaconsoftware.com');
});

test('a magic link request with no address asks for one', async ({ page }) => {
  await openDashboard(page, { email: null });
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();

  await expect(page.getByText('Enter your email address first.')).toBeVisible();
  expect(await page.evaluate(() => window.__AUTH_CALLS__.otp)).toEqual([]);
});

test('blocks a signed-in user from outside the allowed domains', async ({ page }) => {
  await openDashboard(page, { email: 'someone@gmail.example' });

  await expect(page.getByRole('heading', { name: 'Access restricted' })).toBeVisible();
  await expect(page.getByText('someone@gmail.example')).toBeVisible();
  await expect(page.getByText('Northgate Mining')).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign out' }).click();
  expect(await page.evaluate(() => window.__AUTH_CALLS__.signOut)).toBe(1);
});

test('a lookalike domain is not allowed through', async ({ page }) => {
  await openDashboard(page, { email: 'attacker@notbeaconsoftware.com' });
  await expect(page.getByRole('heading', { name: 'Access restricted' })).toBeVisible();
});

test('a subdomain of the allowed domain is not allowed through', async ({ page }) => {
  await openDashboard(page, { email: 'attacker@mail.beaconsoftware.com' });
  await expect(page.getByRole('heading', { name: 'Access restricted' })).toBeVisible();
});

test('admits a Beacon address', async ({ page }) => {
  await openDashboard(page, { email: 'sales@beaconsoftware.com' });
  await expect(page.getByRole('heading', { name: 'Label orders' })).toBeVisible();
});

test('a ToolHound address is no longer admitted', async ({ page }) => {
  // Beacon-only by request. sales@toolhound.com receives the new-order
  // notification but cannot open the dashboard it links to.
  await openDashboard(page, { email: 'sales@toolhound.com' });
  await expect(page.getByRole('heading', { name: 'Access restricted' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test('lists open orders oldest first with time outstanding', async ({ page }) => {
  await openDashboard(page);

  await expect(page.getByRole('heading', { name: 'Label orders' })).toBeVisible();

  // Open is the default filter, so the shipped order is out of view.
  await expect(page.getByText('THL-AAAA-BBBBBB')).toBeVisible();
  await expect(page.getByText('THL-CCCC-DDDDDD')).toBeVisible();
  await expect(page.getByText('THL-EEEE-FFFFFF')).toHaveCount(0);

  // Oldest first: the 21 day old order leads.
  const refs = await page.locator('table.orders tbody .ref-cell').allTextContents();
  expect(refs).toEqual(['THL-AAAA-BBBBBB', 'THL-CCCC-DDDDDD']);

  await expect(page.getByText('21 days outstanding')).toBeVisible();
  await expect(page.getByText('3 days outstanding')).toBeVisible();
});

test('counts open, awaiting-PO, and overdue orders', async ({ page }) => {
  await openDashboard(page);

  const stat = (label) =>
    page.locator('.stat', { has: page.locator('.l', { hasText: label }) }).locator('.n');

  await expect(stat('Open')).toHaveText('2');
  await expect(stat('Awaiting PO')).toHaveText('1');
  await expect(stat('Over 7 days')).toHaveText('1');
});

test('a shipped order reports how long it took, not how long it is outstanding', async ({ page }) => {
  await openDashboard(page);
  await page.getByRole('button', { name: 'Shipped' }).click();

  await expect(page.getByText('THL-EEEE-FFFFFF')).toBeVisible();
  await expect(page.getByText('shipped in 10 days')).toBeVisible();
  await expect(page.getByText('outstanding')).toHaveCount(0);
});

test('filters and searches', async ({ page }) => {
  await openDashboard(page);

  await page.getByRole('button', { name: 'All' }).click();
  await expect(page.locator('table.orders tbody tr.row')).toHaveCount(3);

  await page.getByLabel('Search orders').fill('harbour');
  await expect(page.locator('table.orders tbody tr.row')).toHaveCount(1);
  await expect(page.getByText('Harbour Works')).toBeVisible();

  await page.getByLabel('Search orders').fill('THL-CCCC');
  await expect(page.getByText('Acme Industrial')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Status workflow
// ---------------------------------------------------------------------------

test('advancing a status sends only the status and picks up the stamped row', async ({ page }) => {
  await openDashboard(page);

  const row = page.locator('tr.row', { hasText: 'THL-AAAA-BBBBBB' });
  await row.getByRole('combobox').selectOption('po_sent');

  // Exactly one write, and it carries nothing but the status: the stage
  // timestamps are the trigger's to set, and staff hold no grant to write them.
  await expect.poll(() => page.evaluate(() => window.__UPDATES__)).toEqual([{ status: 'po_sent' }]);

  // The dashboard re-reads the row, so the drawer can show the new stamp.
  await row.getByRole('button', { name: 'Details' }).click();
  const poRow = page.locator('.timeline li', { hasText: 'PO sent' });
  await expect(poRow).not.toHaveClass(/pending/);
  await expect(poRow.locator('.v')).not.toHaveText('not yet');
});

test('a rejected status change is reported and rolled back in the table', async ({ page }) => {
  await openDashboard(page, { failUpdate: 'permission denied for table label_orders' });

  const row = page.locator('tr.row', { hasText: 'THL-AAAA-BBBBBB' });
  await row.getByRole('combobox').selectOption('shipped');

  await expect(page.getByText(/Could not save the status change/)).toBeVisible();
  await expect(page.getByText(/permission denied/)).toBeVisible();
  // Still shown as received, not as the status that failed to save.
  await expect(
    page.locator('tr.row', { hasText: 'THL-AAAA-BBBBBB' }).getByRole('combobox')
  ).toHaveValue('received');
});

test('cancelling an order takes it out of the open list', async ({ page }) => {
  await openDashboard(page);

  await page
    .locator('tr.row', { hasText: 'THL-CCCC-DDDDDD' })
    .getByRole('combobox')
    .selectOption('cancelled');

  await expect(page.getByText('THL-CCCC-DDDDDD')).toHaveCount(0);
  await page.getByRole('button', { name: 'All' }).click();
  await expect(page.getByText('THL-CCCC-DDDDDD')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

test('the drawer shows the order and its stage timeline', async ({ page }) => {
  await openDashboard(page);

  await page
    .locator('tr.row', { hasText: 'THL-CCCC-DDDDDD' })
    .getByRole('button', { name: 'Details' })
    .click();

  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: 'THL-CCCC-DDDDDD' })).toBeVisible();
  await expect(drawer.getByText('dana@acme.example')).toBeVisible();
  await expect(drawer.getByText('400 Foundry Rd, Hamilton, ON, L8E 2W1, Canada')).toBeVisible();
  await expect(drawer.getByText('Custom Text: ACME / TOOL')).toBeVisible();
  await expect(drawer.getByText('1000 – 1499')).toBeVisible();

  // Reached PO sent, not production.
  await expect(page.locator('.timeline li', { hasText: 'PO sent' })).not.toHaveClass(/pending/);
  await expect(
    page.locator('.timeline li', { hasText: 'Production confirmed' })
  ).toHaveClass(/pending/);
});

test('saves internal notes without touching the customer record', async ({ page }) => {
  await openDashboard(page);

  await page
    .locator('tr.row', { hasText: 'THL-AAAA-BBBBBB' })
    .getByRole('button', { name: 'Details' })
    .click();

  await page.getByLabel('Internal notes').fill('Chased the PO with finance.');
  await page.getByRole('button', { name: 'Save notes' }).click();

  await expect(page.getByText('Saved.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__UPDATES__)).toEqual([
    { internal_notes: 'Chased the PO with finance.' }
  ]);
});

test('artwork is offered as a download and never rendered in the page', async ({ page }) => {
  await openDashboard(page);

  await page
    .locator('tr.row', { hasText: 'THL-AAAA-BBBBBB' })
    .getByRole('button', { name: 'Details' })
    .click();

  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('northgate.svg', { exact: true })).toBeVisible();

  const download = page.waitForEvent('download').catch(() => null);
  await drawer.getByRole('button', { name: 'Download artwork' }).click();
  await download;

  // A customer-uploaded SVG can carry script. Nothing in the page may point an
  // element at the artwork payload, and nothing may render a data URL of any
  // type other than the PNG signature -- which is safe only because the
  // database constrains that column to PNG.
  const offenders = await page.evaluate(() =>
    Array.from(document.querySelectorAll('img,object,embed,iframe,svg use'))
      .map((n) => n.getAttribute('src') || n.getAttribute('data') || '')
      .filter((v) => /^data:/.test(v) && !/^data:image\/png;base64,/.test(v))
  );
  expect(offenders).toEqual([]);

  // Belt and braces: the artwork payload must not appear in the markup at all.
  const html = await page.content();
  expect(html).not.toContain('PHN2Zy8+');
});

test('the list query never pulls the artwork payload', async ({ page }) => {
  await openDashboard(page);
  await expect(page.getByRole('heading', { name: 'Label orders' })).toBeVisible();

  const selects = await page.evaluate(() => window.__SELECTS__);
  expect(selects.length).toBeGreaterThan(0);
  expect(selects.some((s) => String(s).indexOf('logo_file_data') !== -1)).toBe(false);
});

test('renders the drawn signature, which is PNG-constrained, unlike the artwork', async ({ page }) => {
  await openDashboard(page);

  await page
    .locator('tr.row', { hasText: 'THL-AAAA-BBBBBB' })
    .getByRole('button', { name: 'Details' })
    .click();

  // The signature is safe to render inline because the database bounds the
  // column to a PNG data URL and a PNG cannot carry script. The artwork column
  // accepts SVG, so it stays a download — see the test above.
  const sig = page.getByRole('dialog').locator('img.sig-view');
  await expect(sig).toBeVisible();
  await expect(sig).toHaveAttribute('src', /^data:image\/png;base64,/);

  // An order with no signature shows no signature block.
  await page.getByRole('button', { name: 'Close' }).click();
  await page
    .locator('tr.row', { hasText: 'THL-CCCC-DDDDDD' })
    .getByRole('button', { name: 'Details' })
    .click();
  await expect(page.getByRole('dialog').locator('img.sig-view')).toHaveCount(0);
});

test('the list query pulls the signature but never the artwork', async ({ page }) => {
  await openDashboard(page);
  await expect(page.getByRole('heading', { name: 'Label orders' })).toBeVisible();

  const selects = await page.evaluate(() => window.__SELECTS__);
  expect(selects.some((s) => String(s).indexOf('signature_data') !== -1)).toBe(true);
  expect(selects.some((s) => String(s).indexOf('logo_file_data') !== -1)).toBe(false);
});

test('hands the order over as a file the Ramp PO skill can read', async ({ page }) => {
  await openDashboard(page);

  await page
    .locator('tr.row', { hasText: 'THL-AAAA-BBBBBB' })
    .getByRole('button', { name: 'Details' })
    .click();

  const wait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PO inputs' }).click();
  const download = await wait;

  expect(download.suggestedFilename()).toBe('THL-AAAA-BBBBBB-ramp-po-input.json');

  const path = await download.path();
  const payload = JSON.parse(require('fs').readFileSync(path, 'utf8'));

  // Self-describing, because this file gets opened later by someone who has
  // forgotten what it was.
  expect(payload.skill).toBe('label-order-ramp-po');
  expect(payload.purpose).toMatch(/Ramp PO/);
  expect(payload.note).toMatch(/0\.00 per unit/);

  expect(payload.orders).toHaveLength(1);
  const order = payload.orders[0];
  expect(order.order_ref).toBe('THL-AAAA-BBBBBB');
  expect(order.company_name).toBe('Northgate Mining');
  expect(order.quantity).toBe(2500);
  expect(order.start_seq).toBe(1);
  expect(order.logo_file_name).toBe('northgate.svg');

  // The artwork payload and the signature are both large and neither is needed
  // to build a PO, so they stay out of the file.
  expect(order).not.toHaveProperty('logo_file_data');
  expect(order).not.toHaveProperty('signature_data');
  expect(JSON.stringify(payload)).not.toContain('PHN2Zy8+');
});
