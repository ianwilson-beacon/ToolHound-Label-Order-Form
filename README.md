# ToolHound Label Order Form

A public, self-serve form for authorizing custom ToolHound label orders.

ToolHound customers identify tools with barcode, QR, and RFID labels — printed
polypropylene for general use, anodized aluminium for harsh environments.
Ordering a custom run has historically meant emailing an account manager back
and forth. This form replaces that: the customer enters their shipping details
and label specifications, reviews the result, and signs an explicit
authorization. Because a custom run is nonreturnable once it goes to
production, the confirmation screen doubles as a printable record of exactly
what was approved.

## How it works

A four step wizard, submitting one row to Supabase:

1. **Customer & shipping** — company, contact, delivery address
2. **Label specifications** — custom logo / custom text / ToolHound logo,
   full-colour choice, quantity, starting sequence number, special instructions
3. **Review** — everything on one screen, including the computed sequence range
4. **Authorization** — named approval plus an explicit agreement to the
   nonreturnable terms

The confirmation screen shows the order reference and offers **Print / save a
copy**, which produces a one-page authorization record.

## Layout

```
public/            Everything that gets deployed
  index.html       Markup shell
  app.js           Wizard logic, validation, submission
  styles.css       Styles, including the print stylesheet
  config.js        Supabase URL + publishable key, support phone
  toolhound-logo.png
supabase/
  migrations/      Versioned schema — the source of truth for the database
tests/
  form.spec.js     End-to-end tests (Playwright)
```

There is no build step. `public/` is a static site that runs as-is.

## Running locally

```bash
npm install
npm run dev        # serves public/ on http://127.0.0.1:4173
npm test           # Playwright end-to-end suite
```

The tests stub the database client through `window.__TOOLHOUND_DB__`, so they
need no network access and no Supabase credentials, and they never write to the
real project.

If Chromium is not at `/opt/pw-browsers/chromium`, point the suite at yours:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm test
```

## Deploying

The site deploys to Vercel as a static directory — `vercel.json` sets
`public/` as the output directory and adds security headers, including a
Content Security Policy that restricts network calls to the Supabase project.

**If the Supabase project ever changes, update the URL in two places:**
`public/config.js` *and* the `connect-src` directive in `vercel.json`. A
mismatch fails silently in the browser as a blocked request.

## Database

The form writes to `public.label_orders` in the **ToolHound Label Orders**
Supabase project (`ayqcteloqdrlemehozzk`). This project is deliberately
isolated from ToolHound OS; the `synced_to_dashboard_at` column is reserved for
a future one-way mirror job.

`supabase/migrations/` is the source of truth for the schema. Both migrations
are already applied to the live project.

- `0001_label_orders.sql` — table, RLS, and the insert policy
- `0002_harden_label_orders.sql` — least-privilege grants, integrity
  constraints, indexes

### Why the public key is safe to publish

`config.js` contains the Supabase **publishable (anon) key**. That key is meant
to ship in client-side code. What protects the data is row level security:

- `anon` holds an **INSERT-only** policy on `label_orders`
- there is deliberately **no SELECT policy**, so the key can file an order but
  cannot read anyone's order back
- `SELECT`, `UPDATE`, `DELETE`, and `TRUNCATE` are additionally revoked at the
  grant level, so the table stays protected even if a policy is later added by
  mistake

Staff read orders through the Supabase dashboard or the service role. **Never
put the `service_role` key in `public/`.**

### Validation runs in two places

The form validates in the browser for a good experience, but the insert
endpoint is reachable by anyone who reads the page source — that is inherent to
a public form. So every client-side rule is also a database constraint:
quantity must be positive, a `custom_logo` order must name a file, text lines
are capped at three lines of ten characters, the email must be well formed, and
the artwork payload must be a recognised data URL under ~6MB.

Client-side checks are the user experience. The constraints are the guarantee.

## Known considerations

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
