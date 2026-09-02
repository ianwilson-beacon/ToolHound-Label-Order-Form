#!/usr/bin/env node
/**
 * Import a distributor price and availability file into hardware_vendor_offers.
 *
 * This is the unattended version of the Costs tab in the staff console: same
 * upsert, same matching on ToolHound SKU, runnable from cron or a scheduled
 * GitHub Action once a distributor feed is in place.
 *
 * On where the file comes from — get a feed, do not scrape the portal:
 *
 *   BlueStar    — reseller price/availability file drop (SFTP or HTTPS), plus
 *                 an inventory API for partners. Ask your BlueStar rep to
 *                 enable it on the ToolHound account.
 *   ScanSource  — EDI 832 (price catalog) and 846 (inventory advice), plus a
 *                 partner API. Ask your ScanSource rep, or their EDI team.
 *
 * Both storefronts are session-authenticated single-page apps behind bot
 * protection: a scraper would need stored credentials, would break on every
 * redesign, and both sites' terms prohibit it. A feed is the supported route
 * and it is also the one that will still work in six months.
 *
 * Usage:
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/import-vendor-prices.mjs \
 *     --vendor scansource --file ./feeds/scansource-2026-09-02.csv \
 *     [--currency USD] [--map ./scripts/mappings/scansource.json] \
 *     [--dry-run] [--publish]
 *
 * The service role key bypasses row level security. Keep it in the runner's
 * secret store — never in public/, never in git.
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { currency: 'USD' };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'dry-run' || key === 'publish' || key === 'help') {
      args[key] = true;
      continue;
    }
    args[key] = argv[++i];
  }
  return args;
}

const USAGE = `Usage: node scripts/import-vendor-prices.mjs --vendor <code> --file <csv> [options]

Required:
  --vendor <code>     Distributor code as stored in hardware_vendors (bluestar, scansource)
  --file <path>       CSV price/availability file

Options:
  --currency <CUR>    Currency of the file when it has no currency column (default USD)
  --map <path>        JSON column mapping, e.g. {"sku":"Vendor Part","cost":"Reseller Price"}
  --default-stock <s> Stock status to assume when the file has none (default unknown)
  --dry-run           Parse, match and report, but write nothing
  --publish           Call hw_publish_prices() afterwards to push prices live

Environment:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
`;

// -----------------------------------------------------------------------------
// CSV
// -----------------------------------------------------------------------------

/** RFC 4180: quoted fields, embedded commas and newlines, doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** Same header guesses the console uses, so both paths agree on a given file. */
const COLUMN_GUESSES = {
  sku: ['toolhound sku', 'th sku', 'our sku', 'internal sku', 'sku', 'part', 'part number', 'mfg part number', 'manufacturer part number', 'mpn', 'model'],
  vendor_sku: ['vendor sku', 'distributor sku', 'item number', 'item #', 'item no', 'scansource sku', 'bluestar sku', 'stock number', 'product id'],
  cost: ['cost', 'unit cost', 'your price', 'reseller price', 'dealer price', 'net price', 'price', 'unit price', 'contract price'],
  currency: ['currency', 'curr', 'cur'],
  availability: ['availability', 'stock status', 'status', 'in stock'],
  stock_qty: ['qty available', 'quantity available', 'available', 'qty', 'on hand', 'stock'],
  landed_add: ['freight', 'freight per unit', 'landed add', 'duty', 'freight and duty']
};

function resolveMapping(headers, overrides) {
  const lower = headers.map((h) => String(h ?? '').trim().toLowerCase());
  const mapping = {};

  for (const [field, candidates] of Object.entries(COLUMN_GUESSES)) {
    let index = -1;
    for (const candidate of candidates) {
      index = lower.indexOf(candidate);
      if (index >= 0) break;
    }
    if (index < 0) {
      index = lower.findIndex((h) => candidates.some((c) => h.includes(c)));
    }
    if (index >= 0) mapping[field] = index;
  }

  // An explicit --map wins, by header name or by zero-based column index.
  for (const [field, target] of Object.entries(overrides ?? {})) {
    if (typeof target === 'number') { mapping[field] = target; continue; }
    const index = lower.indexOf(String(target).trim().toLowerCase());
    if (index < 0) {
      throw new Error(`--map points "${field}" at column "${target}", which is not in the file. `
        + `Headers are: ${headers.join(' | ')}`);
    }
    mapping[field] = index;
  }

  return mapping;
}

function parseMoneyToCents(text) {
  if (text === null || text === undefined) return null;
  const cleaned = String(text).replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^-?\d*(\.\d{0,4})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function parseIntOrNull(text) {
  const cleaned = String(text ?? '').replace(/[\s,]/g, '');
  return /^\d+$/.test(cleaned) ? Number.parseInt(cleaned, 10) : null;
}

function normalizeAvailability(text, qty, fallback) {
  const fromText = availabilityFromText(text);
  const fromQty = availabilityFromQty(qty);
  if (fromText && fromQty) {
    // A feed that says "In Stock" alongside a quantity of 2 is both things at
    // once. Take the more cautious reading: promising same-day shipping on two
    // units when someone orders ten is the expensive mistake.
    return moreConservative(fromText, fromQty);
  }
  return fromText ?? fromQty ?? fallback;
}

function availabilityFromText(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/discontinu|obsolete|eol|end of life/.test(t)) return 'discontinued';
  if (/backorder|back order|b\/o|out of stock|no stock|0 available/.test(t)) return 'backorder';
  if (/low|limited/.test(t)) return 'low_stock';
  if (/in stock|available|yes|true|^y$/.test(t)) return 'in_stock';
  return null;
}

function availabilityFromQty(qty) {
  if (qty === null || qty === undefined) return null;
  if (qty <= 0) return 'backorder';
  if (qty < 5) return 'low_stock';
  return 'in_stock';
}

/** Ordered worst to best, so the lower index wins. */
const AVAILABILITY_RANK = ['discontinued', 'backorder', 'low_stock', 'in_stock', 'unknown'];

function moreConservative(a, b) {
  return AVAILABILITY_RANK.indexOf(a) <= AVAILABILITY_RANK.indexOf(b) ? a : b;
}

// -----------------------------------------------------------------------------
// Supabase REST
// -----------------------------------------------------------------------------

function makeClient(url, key) {
  const base = url.replace(/\/$/, '');
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  };

  async function request(path, init = {}) {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) }
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${body}`);
    }
    return body ? JSON.parse(body) : null;
  }

  return {
    products: () => request('hardware_products?select=id,sku'),
    vendor: (code) =>
      request(`hardware_vendors?select=code,name&code=eq.${encodeURIComponent(code)}`),
    upsertOffers: (rows) =>
      request('hardware_vendor_offers?on_conflict=product_id,vendor_code', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows)
      }),
    publish: () =>
      request('rpc/hw_publish_prices', {
        method: 'POST',
        body: JSON.stringify({ p_product_ids: null })
      })
  };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.vendor || !args.file) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 2);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
  }
  if (args.currency !== 'USD' && args.currency !== 'CAD') {
    throw new Error('--currency must be USD or CAD.');
  }

  const overrides = args.map ? JSON.parse(await readFile(args.map, 'utf8')) : {};
  const rows = parseCsv(await readFile(args.file, 'utf8'));
  if (rows.length < 2) throw new Error('The file has no data rows.');

  const headers = rows[0];
  const mapping = resolveMapping(headers, overrides);
  if (mapping.sku === undefined || mapping.cost === undefined) {
    throw new Error('Could not find a SKU column and a cost column. '
      + `Pass --map to say which is which. Headers are: ${headers.join(' | ')}`);
  }

  const client = makeClient(url, key);

  const vendor = await client.vendor(args.vendor);
  if (!vendor.length) {
    throw new Error(`No vendor "${args.vendor}" in hardware_vendors. `
      + 'Add it there first so cost rows have something to reference.');
  }

  const products = await client.products();
  const bySku = new Map(products.map((p) => [String(p.sku).trim().toLowerCase(), p]));

  const quotedAt = new Date().toISOString();
  const fallbackStock = args['default-stock'] ?? 'unknown';
  const offers = [];
  const skipped = [];
  const seen = new Set();

  rows.slice(1).forEach((row, i) => {
    const line = i + 2;
    const cell = (field) =>
      mapping[field] === undefined ? '' : String(row[mapping[field]] ?? '').trim();

    const sku = cell('sku');
    if (!sku) return;

    const product = bySku.get(sku.toLowerCase());
    if (!product) { skipped.push({ line, sku, reason: 'no product with this SKU' }); return; }

    const cost = parseMoneyToCents(cell('cost'));
    if (cost === null || cost <= 0) {
      skipped.push({ line, sku, reason: `cost "${cell('cost')}" is not a number` });
      return;
    }
    // The unique constraint is (product_id, vendor_code); a batch containing
    // the same product twice would be rejected wholesale, so keep the first.
    if (seen.has(product.id)) {
      skipped.push({ line, sku, reason: 'duplicate SKU in file — first row kept' });
      return;
    }
    seen.add(product.id);

    const fileCurrency = cell('currency').toUpperCase();
    const qty = parseIntOrNull(cell('stock_qty'));
    const landed = parseMoneyToCents(cell('landed_add'));

    offers.push({
      product_id: product.id,
      vendor_code: args.vendor,
      vendor_sku: cell('vendor_sku') || sku,
      cost_cents: cost,
      currency: fileCurrency === 'CAD' || fileCurrency === 'USD' ? fileCurrency : args.currency,
      landed_add_cents: landed && landed > 0 ? landed : 0,
      availability: normalizeAvailability(cell('availability'), qty, fallbackStock),
      stock_qty: qty,
      quoted_at: quotedAt,
      source: 'api',
      updated_at: quotedAt
    });
  });

  const log = (line) => process.stdout.write(`${line}\n`);
  log(`${vendor[0].name}: ${offers.length} cost rows matched, ${skipped.length} skipped.`);
  log(`Column mapping: ${Object.entries(mapping)
    .map(([field, index]) => `${field}=${headers[index]}`).join(', ')}`);

  for (const s of skipped.slice(0, 25)) {
    log(`  line ${s.line}: ${s.sku} — ${s.reason}`);
  }
  if (skipped.length > 25) log(`  … and ${skipped.length - 25} more`);

  if (!offers.length) {
    // Exit non-zero: a scheduled run that matched nothing is a broken run, and
    // it should page somebody rather than look like a quiet success.
    throw new Error('Nothing matched. Check the column mapping and that these '
      + 'SKUs exist in hardware_products.');
  }

  if (args['dry-run']) {
    log('Dry run: nothing written.');
    return;
  }

  // Chunked so one oversized file does not become one oversized request.
  const CHUNK = 500;
  for (let i = 0; i < offers.length; i += CHUNK) {
    await client.upsertOffers(offers.slice(i, i + CHUNK));
    log(`  upserted ${Math.min(i + CHUNK, offers.length)}/${offers.length}`);
  }

  if (args.publish) {
    const results = await client.publish();
    const published = (results ?? []).filter((r) => r.published).length;
    const unpublished = (results ?? []).length - published;
    log(`Published ${published} price(s); ${unpublished} product(s) had no fresh cost `
      + 'and were taken off the storefront.');
  } else {
    log('Costs imported. Review the Pricing tab and publish when the deltas look right.');
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
