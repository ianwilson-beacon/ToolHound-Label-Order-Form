# ToolHound Customer Order Forms

Two public, self-serve ordering flows and one staff console, deployed as a
single static site:

| Page | Who it is for | What it does |
| --- | --- | --- |
| `/` | Customers | Authorize a custom label order |
| `/hardware` | Customers | Order drop-shipped hardware at current prices |
| `/admin` | ToolHound staff | Update prices from distributor cost, manage the catalog, read orders |

## Label order form

ToolHound customers identify tools with barcode, QR, and RFID labels — printed
polypropylene for general use, anodized aluminium for harsh environments.
Ordering a custom run has historically meant emailing an account manager back
and forth. This form replaces that: the customer enters their shipping details
and label specifications, reviews the result, and signs an explicit
authorization. Because a custom run is nonreturnable once it goes to
production, the confirmation screen doubles as a printable record of exactly
what was approved.

### How it works

A four step wizard, submitting one row to Supabase:

1. **Customer & shipping** — company, contact, delivery address
2. **Label specifications** — custom logo / custom text / ToolHound logo,
   full-colour choice, quantity, starting sequence number, special instructions
3. **Review** — everything on one screen, including the computed sequence range
4. **Authorization** — named approval plus an explicit agreement to the
   nonreturnable terms

The confirmation screen shows the order reference and offers **Print / save a
copy**, which produces a one-page authorization record.

## Hardware order portal

ToolHound resells barcode scanners, mobile computers, label printers and RFID
hardware, drop-shipped from two distributors — BlueStar and ScanSource.
Customers order from `/hardware`; staff keep prices current from `/admin`.

### How a price is decided

Distributor cost and availability move daily, so cost and price are separate
things in this system. Cost lives in `hardware_vendor_offers`, one row per
product per distributor. Price is a **published snapshot** on
`hardware_products`, and it only changes when somebody publishes.

For each product, `hw_best_offer()` picks the distributor we would actually buy
from right now:

1. **Currency** — costs are converted into the selling currency first
   (`hardware_settings.fx_usd_to_cad`). Comparing a USD quote with a CAD quote
   without converting picks the wrong vendor roughly half the time.
2. **Freight and duty** — comparison is on *landed* cost
   (`cost_cents + landed_add_cents`). Drop-shipping from a US distributor into
   Canada is not free, and marking up the bare unit cost sells at a loss.
3. **Staleness** — a quote older than `stale_after_hours` (default 48) is not
   used at all. "Cheapest" from a feed that stopped running is a guess.
4. **Availability** — an in-stock offer beats a cheaper backordered one. The
   point of drop-shipping is that the box ships.

`hw_suggested_price_cents()` then applies the markup — per product, or
`hardware_settings.default_markup_pct` — floors it at
`cost + min_margin_cents`, and rounds **up** to `round_price_to_cents`
(default: the whole dollar). A product set to `manual` pricing uses
`price_override_cents` and ignores cost entirely.

### Publishing is deliberately manual

Importing cost changes nothing that a customer can see. `hw_publish_prices()`
snapshots the suggestion onto the product, and that is a staff action from the
Pricing tab. An unattended feed that rewrote the storefront directly would
happily sell at a loss on a bad FX day or a mis-mapped CSV column — the failure
mode is silent and expensive, so a human looks at the deltas.

A product with no fresh cost is **unpublished** on the next publish rather than
left at yesterday's price, and the console says how many came off the shelf.

### Getting the daily cost in

Two paths, same upsert:

- **Staff console → Distributor Costs.** Upload or paste a CSV, check the
  column mapping (guessed from the header row), preview, import. Unmatched
  lines are listed rather than dropped.
- **`scripts/import-vendor-prices.mjs`.** The unattended version, for cron or
  a scheduled GitHub Action:

  ```bash
  SUPABASE_URL=https://ayqcteloqdrlemehozzk.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=***                          \
  node scripts/import-vendor-prices.mjs                  \
    --vendor scansource --file ./feeds/scansource-today.csv \
    --currency USD --map ./mappings/scansource.json
  ```

  It exits non-zero when nothing matched, so a broken feed pages somebody
  instead of logging a green run. Add `--publish` only once you trust the feed.

**Get a feed, do not scrape the portals.** BlueStar and ScanSource both provide
reseller price and availability feeds — a scheduled file drop, EDI 832 (price
catalog) and 846 (inventory advice), or a partner API. Ask your rep to enable
one on the ToolHound account. Both storefronts are session-authenticated apps
behind bot protection: a scraper would need stored credentials, would break on
every redesign, and is against both sites' terms. A feed is the supported route
and the one that still works in six months.

### What customers can and cannot see

The storefront is a public page holding the anon publishable key, so the
guarantees are in the database, not the browser:

- `hardware_vendor_offers` has **no anon policy or grant at all**. Distributor
  cost is unreachable from the storefront.
- On `hardware_products`, anon holds **column-level** SELECT on the catalog
  fields only. `published_cost_cents`, `markup_pct`, `price_override_cents` and
  `published_vendor_code` are not among them.
- Line item prices sent by the browser are **discarded**. A trigger re-reads
  the published price for every row, so a request asking for a $3,000 scanner
  at $1 gets the $3,000, and an unpublished product is refused outright.
- Anon holds column-level INSERT on orders, so a crafted request cannot file an
  order already marked `shipped`.
- There is no anon SELECT policy on orders: the key can file one but cannot
  read anybody's order back.

### Staff access

Two gates. Supabase Auth for identity, and the `hardware_staff` allowlist —
consulted by `hw_is_staff()` inside every policy — for authorization. Signing
up is not enough; somebody has to insert the row. Create the Auth user in the
dashboard, then:

```sql
insert into public.hardware_staff (user_id, email)
values ('<auth.users.id>', 'name@toolhound.com');
```

## Layout

```
public/                    Everything that gets deployed
  index.html / app.js      Label order wizard
  hardware.html            Customer hardware storefront
  hardware.js
  admin.html / admin.js    Staff pricing and order console
  ui.js                    DOM and formatting helpers shared by the two new pages
  styles.css               Base styles, including the print stylesheet
  portal.css               Hardware portal and console styles
  config.js                Supabase URL + publishable key, support phone
  toolhound-logo.png
scripts/
  import-vendor-prices.mjs Unattended distributor cost import
  test-db.sh               Applies the migrations to a throwaway cluster and runs the SQL tests
supabase/
  migrations/              Versioned schema — the source of truth for the database
  tests/                   SQL tests for the pricing rules and the RLS guarantees
tests/
  form.spec.js             Label form end-to-end tests (Playwright)
  hardware.spec.js         Storefront end-to-end tests
  admin.spec.js            Staff console end-to-end tests
  import-script.spec.js    Import script tests, against a fake PostgREST
  support/stub-db.js       Shared Supabase stub
```

There is no build step. `public/` is a static site that runs as-is.

## Running locally

```bash
npm install
npm run dev        # serves public/ on http://127.0.0.1:4173
npm test           # Playwright suite (browser + import script)
npm run test:db    # applies the migrations to a throwaway Postgres and runs the SQL tests
npm run test:all   # both
```

The browser tests stub the database client through `window.__TOOLHOUND_DB__`,
so they need no network access and no Supabase credentials, and they never
write to the real project. The import script tests run it against a local
stand-in for PostgREST.

`npm run test:db` needs a local PostgreSQL 14+ on the path (`initdb`, `pg_ctl`,
`psql`); it builds its own cluster in a temp directory and deletes it
afterwards. It never touches the live project. This is where the pricing rules
are tested — cheapest landed cost, the staleness window, the repricing trigger,
and the grants that keep cost away from anon — because that is where they live.

If Chromium is not at `/opt/pw-browsers/chromium`, point the suite at yours:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm test
```

## Deploying

The site deploys to Vercel as a static directory — `vercel.json` sets
`public/` as the output directory and adds security headers, including a
Content Security Policy that restricts network calls to the Supabase project.
`cleanUrls` is on, so the pages are served at `/`, `/hardware` and `/admin`.
All three carry `noindex`; `/admin` also carries `nofollow` and is useless
without a staff account.

**If the Supabase project ever changes, update the URL in two places:**
`public/config.js` *and* the `connect-src` directive in `vercel.json`. A
mismatch fails silently in the browser as a blocked request.

## Database

Everything lives in the **ToolHound Label Orders** Supabase project
(`ayqcteloqdrlemehozzk`). This project is deliberately isolated from ToolHound
OS; the `synced_to_dashboard_at` columns are reserved for a future one-way
mirror job.

`supabase/migrations/` is the source of truth for the schema.

| Migration | Applied to live? | What it adds |
| --- | --- | --- |
| `0001_label_orders.sql` | yes | `label_orders`, RLS, the insert policy |
| `0002_harden_label_orders.sql` | yes | Least-privilege grants, integrity constraints, indexes |
| `0003_hardware_catalog.sql` | **not yet** | Vendors, pricing settings, products, distributor costs, staff allowlist |
| `0004_hardware_pricing.sql` | **not yet** | Cheapest-vendor pricing functions, publish, the admin and catalog views |
| `0005_hardware_orders.sql` | **not yet** | Hardware orders, line items, the repricing trigger |

Apply `0003`–`0005` in order, then seed the catalog from the console's Catalog
tab (or with SQL) and add yourself to `hardware_staff`. Nothing appears on the
storefront until a product has a distributor cost and somebody publishes.

### Why the public key is safe to publish

`config.js` contains the Supabase **publishable (anon) key**. That key is meant
to ship in client-side code. What protects the data is row level security:

- `anon` holds an **INSERT-only** policy on `label_orders`
- there is deliberately **no SELECT policy**, so the key can file an order but
  cannot read anyone's order back
- `SELECT`, `UPDATE`, `DELETE`, and `TRUNCATE` are additionally revoked at the
  grant level, so the table stays protected even if a policy is later added by
  mistake

Staff read label orders through the Supabase dashboard or the service role.
The hardware console reads through Supabase Auth plus the `hardware_staff`
allowlist. **Never put the `service_role` key in `public/`** — it belongs in
the import job's secret store and nowhere else.

### Validation runs in two places

The form validates in the browser for a good experience, but the insert
endpoint is reachable by anyone who reads the page source — that is inherent to
a public form. So every client-side rule is also a database constraint:
quantity must be positive, a `custom_logo` order must name a file, text lines
are capped at three lines of ten characters, the email must be well formed, and
the artwork payload must be a recognised data URL under ~6MB.

Client-side checks are the user experience. The constraints are the guarantee.

## Known considerations

### Both forms

- **No rate limiting.** Anyone can submit orders. The constraints bound what a
  single row can contain, but nothing bounds how many rows arrive. If this
  becomes a problem, put a CAPTCHA or an Edge Function in front of the insert.
- **No confirmation email.** Nothing currently emails the customer, and the
  confirmation screen deliberately does not claim otherwise — it directs them
  to print a copy and gives them a phone number. Wiring this up means a
  Supabase Edge Function plus an email provider key.
- **Artwork is stored inline.** Logo files are base64 encoded into
  `logo_file_data` rather than object storage. Fine at current volume; move to
  Supabase Storage if orders grow or files get larger.
- **Uploaded SVGs are untrusted.** SVG is accepted because vector artwork
  reproduces best at label size, but an SVG can carry script. Any internal tool
  that displays these logos must not render them inline — treat them as
  downloads or rasterise them first.

### Hardware portal

- **Cost still arrives by hand until a feed exists.** The importer and the
  console both work today from a CSV; neither invents a connection to a
  distributor. Until BlueStar and ScanSource turn on a feed for the ToolHound
  account, somebody exports a price file and imports it. That is the honest
  state of it, and it is the same code path the feed will use.
- **Prices exclude freight, duties and tax.** Both the storefront and the
  printed record say so. The distributor's actual freight is not known until
  the order is placed, so the final invoice is still ours to produce.
- **Nothing checks stock in real time.** Availability is as fresh as the last
  import, which is why the storefront says "Call to confirm" rather than
  promising a ship date, and why an order is a request we confirm rather than a
  committed sale.
- **Product images must be same-origin.** The CSP allows `img-src 'self'
  data:`, so a distributor's image URL is blocked. Put the file in `public/` or
  inline it as a data URL.
- **An order can be filed with no line items.** The header is inserted first so
  the line items have something to reference; if the second insert fails and
  the customer walks away, the order sits there with `line_count = 0`. Visible
  in the Orders tab, worth a periodic look.
- **No confirmation email here either.** Same gap, same fix.
- **Margin figures in the Orders tab are indicative.** They use the distributor
  cost captured at publish time, not what we were actually invoiced.
