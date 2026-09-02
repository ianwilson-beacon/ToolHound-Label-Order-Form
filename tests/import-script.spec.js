const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { mkdtemp, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

/**
 * Tests for scripts/import-vendor-prices.mjs — the unattended nightly import.
 *
 * This path runs with nobody watching, so the things worth proving are that a
 * realistic distributor file lands on the right products at the right cost,
 * and that a file which matches nothing fails loudly instead of reporting a
 * quiet success.
 *
 * A local HTTP server stands in for PostgREST. It records what the script
 * sends, so the assertions are about the request bodies rather than about
 * stdout.
 */

const SCRIPT = path.join(__dirname, '..', 'scripts', 'import-vendor-prices.mjs');

const PRODUCTS = [
  { id: 'p-scanner', sku: 'TH-CT47' },
  { id: 'p-printer', sku: 'TH-ZD421' }
];

/** Minimal stand-in for the three endpoints the script touches. */
async function startFakeRest({ products = PRODUCTS } = {}) {
  const received = { upserts: [], publishes: 0 };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const reply = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === '/rest/v1/hardware_vendors') {
        // Honour the code filter, so an unknown vendor really comes back empty.
        const wanted = (url.searchParams.get('code') || '').replace(/^eq\./, '');
        reply(200, wanted === 'scansource'
          ? [{ code: 'scansource', name: 'ScanSource' }] : []);
      } else if (url.pathname === '/rest/v1/hardware_products') {
        reply(200, products);
      } else if (url.pathname === '/rest/v1/hardware_vendor_offers') {
        received.upserts.push({
          onConflict: url.searchParams.get('on_conflict'),
          prefer: req.headers.prefer,
          rows: JSON.parse(body)
        });
        reply(201, []);
      } else if (url.pathname === '/rest/v1/rpc/hw_publish_prices') {
        received.publishes++;
        reply(200, [
          { product_id: 'p-scanner', sku: 'TH-CT47', price_cents: 180000, published: true },
          { product_id: 'p-printer', sku: 'TH-ZD421', price_cents: null, published: false }
        ]);
      } else {
        reply(404, { message: 'unexpected path ' + url.pathname });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    received,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function runScript(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env, NO_PROXY: '127.0.0.1,localhost' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeCsv(lines) {
  const dir = await mkdtemp(path.join(tmpdir(), 'th-import-'));
  const file = path.join(dir, 'feed.csv');
  await writeFile(file, lines.join('\n'), 'utf8');
  return file;
}

test('imports a distributor feed onto the matching products', async () => {
  const rest = await startFakeRest();
  const file = await writeCsv([
    'Item Number,Mfg Part Number,Description,Reseller Price,Qty Available,Stock Status',
    'SS-99881,TH-CT47,"Handheld, rugged","$1,020.00",88,In Stock',
    'SS-77123,TH-ZD421,"Printer, desktop",540.50,2,In Stock',
    'SS-00000,TH-NOPE,"Not ours",10.00,5,In Stock'
  ]);

  const result = await runScript(
    ['--vendor', 'scansource', '--file', file, '--currency', 'USD'],
    { SUPABASE_URL: rest.url, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' }
  );

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('2 cost rows matched, 1 skipped');
  expect(result.stdout).toContain('TH-NOPE — no product with this SKU');

  expect(rest.received.upserts).toHaveLength(1);
  const upsert = rest.received.upserts[0];
  expect(upsert.onConflict).toBe('product_id,vendor_code');
  expect(upsert.prefer).toContain('resolution=merge-duplicates');

  const scanner = upsert.rows.find((r) => r.product_id === 'p-scanner');
  expect(scanner.vendor_code).toBe('scansource');
  expect(scanner.vendor_sku).toBe('SS-99881');
  // A quoted "$1,020.00" is a thousand and twenty dollars, not one dollar.
  expect(scanner.cost_cents).toBe(102000);
  expect(scanner.currency).toBe('USD');
  expect(scanner.availability).toBe('in_stock');
  expect(scanner.stock_qty).toBe(88);

  // The file says "In Stock" but lists two on hand. The quantity is the more
  // cautious reading and wins, because low stock changes which vendor is
  // cheapest-that-can-actually-ship.
  const printer = upsert.rows.find((r) => r.product_id === 'p-printer');
  expect(printer.cost_cents).toBe(54050);
  expect(printer.availability).toBe('low_stock');

  // Costs are imported, but prices are not touched without --publish.
  expect(rest.received.publishes).toBe(0);

  await rest.close();
});

test('publishes when asked, and reports what came off the storefront', async () => {
  const rest = await startFakeRest();
  const file = await writeCsv([
    'Mfg Part Number,Reseller Price',
    'TH-CT47,1020.00'
  ]);

  const result = await runScript(
    ['--vendor', 'scansource', '--file', file, '--publish'],
    { SUPABASE_URL: rest.url, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' }
  );

  expect(result.code, result.stderr).toBe(0);
  expect(rest.received.publishes).toBe(1);
  expect(result.stdout).toContain('Published 1 price(s); 1 product(s) had no fresh cost');

  await rest.close();
});

test('a dry run writes nothing', async () => {
  const rest = await startFakeRest();
  const file = await writeCsv([
    'Mfg Part Number,Reseller Price',
    'TH-CT47,1020.00'
  ]);

  const result = await runScript(
    ['--vendor', 'scansource', '--file', file, '--dry-run'],
    { SUPABASE_URL: rest.url, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' }
  );

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('Dry run: nothing written.');
  expect(rest.received.upserts).toHaveLength(0);

  await rest.close();
});

test('fails loudly when a scheduled run matches nothing', async () => {
  const rest = await startFakeRest();
  const file = await writeCsv([
    'Mfg Part Number,Reseller Price',
    'SOMEONE-ELSES-SKU,1020.00'
  ]);

  const result = await runScript(
    ['--vendor', 'scansource', '--file', file],
    { SUPABASE_URL: rest.url, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' }
  );

  // Non-zero so the scheduler surfaces it instead of logging a green run.
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Nothing matched');
  expect(rest.received.upserts).toHaveLength(0);

  await rest.close();
});

test('an explicit mapping overrides the header guesses', async () => {
  const rest = await startFakeRest();
  // Two plausible price columns: list and reseller. Guessing would take the
  // first match, so the mapping has to be able to say which one is ours.
  const file = await writeCsv([
    'Part,List Price,Contract Price',
    'TH-CT47,1499.00,1020.00'
  ]);
  const dir = path.dirname(file);
  const mapFile = path.join(dir, 'map.json');
  await writeFile(mapFile, JSON.stringify({ sku: 'Part', cost: 'Contract Price' }), 'utf8');

  const result = await runScript(
    ['--vendor', 'scansource', '--file', file, '--map', mapFile],
    { SUPABASE_URL: rest.url, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' }
  );

  expect(result.code, result.stderr).toBe(0);
  expect(rest.received.upserts[0].rows[0].cost_cents).toBe(102000);

  await rest.close();
});

test('a mapping pointing at a column that is not there names the headers', async () => {
  const rest = await startFakeRest();
  const file = await writeCsv(['Part,Contract Price', 'TH-CT47,1020.00']);
  const mapFile = path.join(path.dirname(file), 'map.json');
  await writeFile(mapFile, JSON.stringify({ cost: 'Net Price' }), 'utf8');

  const result = await runScript(
    ['--vendor', 'scansource', '--file', file, '--map', mapFile],
    { SUPABASE_URL: rest.url, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' }
  );

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('which is not in the file');
  expect(result.stderr).toContain('Part | Contract Price');

  await rest.close();
});

test('refuses a vendor code that is not in hardware_vendors', async () => {
  const rest = await startFakeRest();
  const file = await writeCsv(['Part,Contract Price', 'TH-CT47,1020.00']);

  const result = await runScript(
    ['--vendor', 'not-a-vendor', '--file', file],
    { SUPABASE_URL: rest.url, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' }
  );

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('No vendor "not-a-vendor"');

  await rest.close();
});

test('will not run without credentials', async () => {
  const file = await writeCsv(['Part,Contract Price', 'TH-CT47,1020.00']);
  const result = await runScript(['--vendor', 'scansource', '--file', file], {
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: ''
  });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('SUPABASE_SERVICE_ROLE_KEY');
});
