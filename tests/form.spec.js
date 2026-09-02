const { test, expect } = require('@playwright/test');

/**
 * End-to-end tests for the label order wizard.
 *
 * Every test stubs the database client before page scripts run, so the suite is
 * hermetic: no network, no Supabase credentials, and no rows written to a real
 * project. `window.__TOOLHOUND_DB__` is the seam app.js checks first.
 */

/** Install a stub client and capture whatever the form tries to insert. */
async function stubDb(page, { failWith = null, failFirstNTimes = 0 } = {}) {
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());

  await page.addInitScript(
    ({ failWith, failFirstNTimes }) => {
      window.__INSERTED__ = [];
      let calls = 0;
      window.__TOOLHOUND_DB__ = {
        from() {
          return {
            insert(row) {
              calls++;
              window.__INSERTED__.push(row);
              if (failWith && calls <= (failFirstNTimes || Number.MAX_SAFE_INTEGER)) {
                return Promise.resolve({ error: failWith });
              }
              return Promise.resolve({ error: null });
            }
          };
        }
      };
    },
    { failWith, failFirstNTimes }
  );
}

async function fillStep1(page, overrides = {}) {
  const v = {
    company: 'Acme Industrial',
    contact: 'Dana Reyes',
    email: 'dana@acme.example',
    address: '400 Foundry Rd',
    city: 'Hamilton',
    region: 'ON',
    postal: 'L8E 2W1',
    country: 'Canada',
    ...overrides
  };
  await page.getByLabel('Company Name *').fill(v.company);
  await page.getByLabel('Customer Contact Name *').fill(v.contact);
  await page.getByLabel('Customer Contact Email *').fill(v.email);
  await page.getByLabel('Shipping Address *').fill(v.address);
  await page.getByLabel('City *').fill(v.city);
  await page.getByLabel('State / Province *').fill(v.region);
  await page.getByLabel('Postal / ZIP Code *').fill(v.postal);
  await page.getByLabel('Country *').fill(v.country);
}

const QUANTITY_OPTIONS = [500, 1000, 1500, 2000, 2500, 5000, 7500, 10000];

/** Pick the quantity dropdown option when it's a standard increment, else fall
 *  back to the "Other" free-entry input. */
async function fillQuantity(page, quantity) {
  const n = Number(quantity);
  if (QUANTITY_OPTIONS.includes(n)) {
    await page.getByLabel('Quantity *').selectOption(String(n));
  } else {
    await page.getByLabel('Quantity *').selectOption('other');
    await page.getByLabel('Exact quantity').fill(String(quantity));
  }
}

async function fillStep2(page, { quantity = '500', startSeq = '1000' } = {}) {
  await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
  await page.getByRole('radio', { name: 'Yes', exact: true }).check();
  await fillQuantity(page, quantity);
  await page.getByLabel('Starting Sequence # *').fill(startSeq);
  await page.getByRole('radio', { name: '1.50" x 0.75"' }).check();
}

/** Types a name into the signature field, which renders it to the canvas. */
async function signTyped(page, name = 'Dana Reyes') {
  await page.getByLabel('Type your name to sign').fill(name);
}

async function fillStep4(page, name = 'Dana Reyes') {
  await page.getByLabel('Authorized Name *').fill(name);
  await signTyped(page, name);
  await page.getByLabel('I have read and agree').check();
}

test.beforeEach(async ({ page }) => {
  await stubDb(page);
  await page.goto('/index.html');
});

test('completes the full order flow and records the submission', async ({ page }) => {
  await fillStep1(page);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Label Specifications' })).toBeVisible();
  await fillStep2(page);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Review Your Order' })).toBeVisible();
  await expect(page.getByText('Acme Industrial')).toBeVisible();
  // The review step spells out the computed range so an off-by-one is visible.
  await expect(page.getByText('1000 – 1499')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Authorization' }).click();

  await fillStep4(page);
  await page.getByRole('button', { name: 'Submit Order' }).click();

  await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();
  await expect(page.locator('.success').getByText(/^Reference: THL-/)).toBeVisible();

  const rows = await page.evaluate(() => window.__INSERTED__);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    company_name: 'Acme Industrial',
    contact_email: 'dana@acme.example',
    logo_choice: 'toolhound_logo',
    full_color: 'Yes',
    quantity: 500,
    start_seq: 1000,
    authorized_name: 'Dana Reyes',
    logo_file_name: null,
    text_lines: null
  });
  // Quantity and sequence must reach the database as integers, not strings,
  // or the integer columns reject them.
  expect(typeof rows[0].quantity).toBe('number');
  expect(typeof rows[0].start_seq).toBe('number');
});

test.describe('step 1 validation', () => {
  test('blocks empty required fields', async ({ page }) => {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Customer & Shipping Information' }))
      .toBeVisible();
    await expect(page.getByText('Required').first()).toBeVisible();
  });

  test('rejects a malformed email with a specific message', async ({ page }) => {
    await fillStep1(page, { email: 'dana-at-acme' });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Customer & Shipping Information' }))
      .toBeVisible();
  });
});

test.describe('step 2 validation', () => {
  test.beforeEach(async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
  });

  // Regression: el() set attributes from null values, so every radio in a group
  // received checked="null" and rendered as selected regardless of state.
  test('no label choice is preselected, and selecting one checks exactly it',
    async ({ page }) => {
      const radios = page.getByRole('radio', { name: /Custom Logo|Custom Text|ToolHound Logo/ });
      await expect(radios).toHaveCount(3);
      for (const r of await radios.all()) {
        await expect(r).not.toBeChecked();
      }

      await page.getByRole('radio', { name: 'Custom Text' }).check();
      await expect(page.getByRole('radio', { name: 'Custom Text' })).toBeChecked();
      await expect(page.getByRole('radio', { name: 'Custom Logo' })).not.toBeChecked();
      await expect(page.getByRole('radio', { name: 'ToolHound Logo' })).not.toBeChecked();
    });

  test('requires a logo choice', async ({ page }) => {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Please choose one').first()).toBeVisible();
  });

  // Regression: choosing "Custom Logo" without attaching artwork used to fail
  // silently — Continue did nothing and no message appeared.
  test('explains why a custom logo order cannot continue without a file',
    async ({ page }) => {
      await page.getByRole('radio', { name: 'Custom Logo' }).check();
      await page.getByRole('radio', { name: 'Yes', exact: true }).check();
      await page.getByRole('radio', { name: '1.50" x 0.75"' }).check();
      await fillQuantity(page, '100');
      await page.getByLabel('Starting Sequence # *').fill('1');
      await page.getByRole('button', { name: 'Continue' }).click();

      await expect(page.getByText('Please upload a logo file')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Label Specifications' }))
        .toBeVisible();
    });

  // Regression: "Text Line 1 *" was marked required but never validated, so an
  // order could be placed with no text to print.
  test('requires at least one line of custom text', async ({ page }) => {
    await page.getByRole('radio', { name: 'Custom Text' }).check();
    await fillQuantity(page, '100');
    await page.getByLabel('Starting Sequence # *').fill('1');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Enter at least one line of text')).toBeVisible();
  });

  // Custom text has no logo to colour, so the full-color question — and the
  // surcharge it implies — should not appear for that choice.
  test('hides the full-color question for custom text orders', async ({ page }) => {
    await page.getByRole('radio', { name: 'Custom Text' }).check();
    await expect(page.getByText('Should the logo be printed in full color?')).toBeHidden();
    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await expect(page.getByText('Should the logo be printed in full color?')).toBeVisible();
  });

  test('caps each custom text line at 10 characters', async ({ page }) => {
    await page.getByRole('radio', { name: 'Custom Text' }).check();
    const line1 = page.getByLabel('Text line 1');
    await line1.fill('ABCDEFGHIJKLMNOP');
    await expect(line1).toHaveValue('ABCDEFGHIJ');
  });

  // Regression: `!d.quantity` is false for the string "0", so zero-quantity
  // orders passed validation and reached the database.
  test('rejects a quantity of zero', async ({ page }) => {
    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await fillQuantity(page, '0');
    await page.getByLabel('Starting Sequence # *').fill('1');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Quantity must be at least 1')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Label Specifications' })).toBeVisible();
  });

  test('rejects a negative starting sequence', async ({ page }) => {
    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await fillQuantity(page, '50');
    await page.getByLabel('Starting Sequence # *').fill('-5');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Starting sequence cannot be negative')).toBeVisible();
  });

  test('previews the resulting sequence range as the customer types',
    async ({ page }) => {
      await fillQuantity(page, '250');
      await page.getByLabel('Starting Sequence # *').fill('500');
      await expect(page.getByText('This order will print labels 500 through 749.'))
        .toBeVisible();
    });

  test('rejects an unsupported artwork file type', async ({ page }) => {
    await page.getByRole('radio', { name: 'Custom Logo' }).check();
    await page.setInputFiles('input[type=file]', {
      name: 'spec.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('not artwork')
    });
    await expect(page.getByText(/file type is not supported/)).toBeVisible();
  });

  test('accepts a PNG logo and carries the filename through to the order',
    async ({ page }) => {
      // Smallest valid PNG.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      );
      await page.getByRole('radio', { name: 'Custom Logo' }).check();
      await page.setInputFiles('input[type=file]', {
        name: 'acme-mark.png', mimeType: 'image/png', buffer: png
      });
      await expect(page.getByText('Selected: acme-mark.png')).toBeVisible();

      await page.getByRole('radio', { name: 'Yes', exact: true }).check();
      await page.getByRole('radio', { name: '1.50" x 0.75"' }).check();
      await fillQuantity(page, '100');
      await page.getByLabel('Starting Sequence # *').fill('1');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      const rows = await page.evaluate(() => window.__INSERTED__);
      expect(rows[0].logo_file_name).toBe('acme-mark.png');
      // The database constraint only accepts recognised data URL prefixes.
      expect(rows[0].logo_file_data).toMatch(/^data:image\/png;base64,/);
    });
});

test.describe('custom text orders', () => {
  test('sends only the non-empty lines', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('radio', { name: 'Custom Text' }).check();
    await page.getByLabel('Text line 1').fill('ACME');
    await page.getByLabel('Text line 3').fill('YARD 4');
    await page.getByRole('radio', { name: '1.25" x 0.50"' }).check();
    await fillQuantity(page, '75');
    await page.getByLabel('Starting Sequence # *').fill('0');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('ACME / YARD 4')).toBeVisible();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    const rows = await page.evaluate(() => window.__INSERTED__);
    expect(rows[0].text_lines).toEqual(['ACME', 'YARD 4']);
    expect(rows[0].full_color).toBe('No');
  });
});

test.describe('step 4 authorization', () => {
  test.beforeEach(async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
  });

  test('requires the agreement checkbox', async ({ page }) => {
    await page.getByLabel('Authorized Name *').fill('Dana Reyes');
    await page.getByRole('button', { name: 'Submit Order' }).click();
    await expect(page.getByText('Please check the box to continue')).toBeVisible();
    const rows = await page.evaluate(() => window.__INSERTED__);
    expect(rows).toHaveLength(0);
  });

  test('requires an authorized name', async ({ page }) => {
    await page.getByLabel('I have read and agree').check();
    await page.getByRole('button', { name: 'Submit Order' }).click();
    await expect(page.getByLabel('Authorized Name *')).toHaveAttribute('aria-invalid', 'true');
    const rows = await page.evaluate(() => window.__INSERTED__);
    expect(rows).toHaveLength(0);
  });
});

test.describe('submission failures', () => {
  test('shows an inline error and lets the customer retry', async ({ page }) => {
    await stubDb(page, { failWith: { code: 'PGRST301', message: 'boom' } });
    await page.goto('/index.html');

    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    await expect(page.getByText(/Something went wrong submitting your order/))
      .toBeVisible();
    // Still on the authorization step, with the button usable again.
    await expect(page.getByRole('button', { name: 'Submit Order' })).toBeEnabled();
    // The entered details survive the failure.
    await expect(page.getByLabel('Authorized Name *')).toHaveValue('Dana Reyes');
  });

  test('explains a constraint rejection in terms the customer can act on',
    async ({ page }) => {
      await stubDb(page, { failWith: { code: '23514', message: 'check violation' } });
      await page.goto('/index.html');

      await fillStep1(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillStep2(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      await expect(page.getByText(/rejected as invalid/)).toBeVisible();
    });

  // The order reference is generated in the browser, so a same-millisecond
  // collision is possible; the form should quietly try a new reference.
  test('retries with a fresh reference after a duplicate key error',
    async ({ page }) => {
      await stubDb(page, {
        failWith: { code: '23505', message: 'duplicate key' },
        failFirstNTimes: 1
      });
      await page.goto('/index.html');

      await fillStep1(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillStep2(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();
      const rows = await page.evaluate(() => window.__INSERTED__);
      expect(rows).toHaveLength(2);
      expect(rows[0].order_ref).not.toBe(rows[1].order_ref);
    });
});

test.describe('confirmation record', () => {
  test('renders a printable authorization with the specs and the reference',
    async ({ page }) => {
      await fillStep1(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillStep2(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Print / save a copy' }))
        .toBeVisible();

      // The print block is hidden on screen but carries the full record.
      const print = page.locator('.print-only');
      await expect(print).toBeHidden();
      await expect(print).toContainText('Label Order Authorization');
      await expect(print).toContainText('Acme Industrial');
      await expect(print).toContainText('cannot be returned');
      await expect(print).toContainText('Dana Reyes');

      const ref = await page.evaluate(() => window.__TOOLHOUND_FORM__.state.orderRef);
      await expect(print).toContainText(ref);
    });

  // The confirmation must not promise an email that nothing sends.
  test('does not claim a confirmation email was sent', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();
    await expect(page.locator('.success')).not.toContainText(/confirmation will be sent/i);
  });
});

test.describe('order references', () => {
  test('are unique across many generations', async ({ page }) => {
    const refs = await page.evaluate(() => {
      const out = new Set();
      for (let i = 0; i < 5000; i++) out.add(window.__TOOLHOUND_FORM__.makeOrderRef());
      return out.size;
    });
    expect(refs).toBe(5000);
  });

  test('use an unambiguous alphabet', async ({ page }) => {
    const ref = await page.evaluate(() => window.__TOOLHOUND_FORM__.makeOrderRef());
    expect(ref).toMatch(/^THL-[0-9A-Z]+-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });
});

test.describe('fields the vendor PO needs', () => {
  test('carries label size, sequence prefix, phone, receiving contact and customer PO',
    async ({ page }) => {
      await fillStep1(page);
      await page.getByLabel('Receiving Contact').fill('Mike Betts');
      await page.getByLabel('Delivery Phone').fill('204-555-0117');
      await page.getByLabel('Your PO Number').fill('4500620115');
      await page.getByRole('button', { name: 'Continue' }).click();

      await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
      await page.getByRole('radio', { name: 'No', exact: true }).check();
      await page.getByRole('radio', { name: '1.25" x 0.50"' }).check();
      await fillQuantity(page, '3000');
      await page.getByLabel('Starting Sequence # *').fill('6001');
      await page.getByLabel('Sequence Prefix').fill('vol');

      // The prefix is what gets printed on the tag, so it is upper-cased as
      // typed rather than silently at submit time.
      await expect(page.getByLabel('Sequence Prefix')).toHaveValue('VOL');
      // Scoped to the preview: the field's own hint text also names VOL6001.
      await expect(page.locator('.seq-preview')).toContainText('VOL6001');
      await expect(page.locator('.seq-preview')).toContainText('VOL9000');

      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByText('1.25" x 0.50"').last()).toBeVisible();
      await expect(page.getByText('VOL6001 – VOL9000')).toBeVisible();

      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      const row = (await page.evaluate(() => window.__INSERTED__))[0];
      expect(row.label_width_in).toBe(1.25);
      expect(row.label_height_in).toBe(0.5);
      expect(row.seq_prefix).toBe('VOL');
      expect(row.start_seq).toBe(6001);
      expect(row.ship_to_phone).toBe('204-555-0117');
      expect(row.attention_name).toBe('Mike Betts');
      expect(row.customer_po).toBe('4500620115');
    });

  test('the optional fields stay null when left blank', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    const row = (await page.evaluate(() => window.__INSERTED__))[0];
    // Null rather than empty string: the columns are nullable so "not asked"
    // stays distinguishable from "answered with nothing".
    expect(row.seq_prefix).toBeNull();
    expect(row.ship_to_phone).toBeNull();
    expect(row.attention_name).toBeNull();
    expect(row.customer_po).toBeNull();
  });

  test('will not continue without a label size', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await fillQuantity(page, '500');
    await page.getByLabel('Starting Sequence # *').fill('1');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Please choose a label size')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Label Specifications' })).toBeVisible();
  });

  test('a custom size must be a plausible number of inches', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await page.getByRole('radio', { name: 'Another size' }).check();
    await page.getByLabel('Width (inches) *').fill('40');
    await page.getByLabel('Height (inches) *').fill('1');
    await fillQuantity(page, '500');
    await page.getByLabel('Starting Sequence # *').fill('1');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('0 to 12 inches').first()).toBeVisible();

    await page.getByLabel('Width (inches) *').fill('2');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Review Your Order' })).toBeVisible();
    await expect(page.getByText('2.00" x 1.00"')).toBeVisible();
  });
});

test.describe('typed signature', () => {
  test('renders the typed name as a PNG and submits it', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();

    await page.getByLabel('Authorized Name *').fill('Dana Reyes');
    await page.getByLabel('Type your name to sign').fill('Dana Reyes');
    await page.getByLabel('I have read and agree').check();
    await page.getByRole('button', { name: 'Submit Order' }).click();

    const row = (await page.evaluate(() => window.__INSERTED__))[0];
    // The database constrains this column to a PNG data URL, which is also
    // what lets the dashboard show it inline.
    expect(row.signature_data).toMatch(/^data:image\/png;base64,/);
    // A blank canvas encodes to a short string; a rendered name does not.
    expect(row.signature_data.length).toBeGreaterThan(1000);
  });

  test('will not submit without a typed signature', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();

    await page.getByLabel('Authorized Name *').fill('Dana Reyes');
    await page.getByLabel('I have read and agree').check();
    await page.getByRole('button', { name: 'Submit Order' }).click();

    await expect(page.getByText('Please type your name to authorize this order')).toBeVisible();
    expect(await page.evaluate(() => window.__INSERTED__)).toHaveLength(0);
  });

  test('clearing the signature blocks submission again', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();

    await page.getByLabel('Authorized Name *').fill('Dana Reyes');
    await page.getByLabel('Type your name to sign').fill('Dana Reyes');
    await page.getByRole('button', { name: 'Clear signature' }).click();
    await expect(page.getByLabel('Type your name to sign')).toHaveValue('');

    await page.getByLabel('I have read and agree').check();
    await page.getByRole('button', { name: 'Submit Order' }).click();
    await expect(page.getByText('Please type your name to authorize this order')).toBeVisible();
  });
});
