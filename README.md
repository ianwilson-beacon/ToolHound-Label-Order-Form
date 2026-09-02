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

Submitting also emails `sales@toolhound.com` and puts the order on the internal
dashboard at `/admin`, where staff track it through PO sent, production
confirmed, and shipped. Customers never see that page — see **Access**.

## Layout

```
public/            Everything that gets deployed
  index.html       Customer order form — markup shell
  app.js           Wizard logic, validation, submission
  admin.html       Internal orders dashboard — markup shell
  admin.js         Sign-in gate, order table, status workflow
  admin.css        Dashboard styles (loaded after styles.css)
  admin-config.js  GENERATED — Clerk key, written by scripts/
  styles.css       Shared styles, including the print stylesheet
  config.js        Supabase URL + publishable key, support phone
  robots.txt
  toolhound-logo.png
scripts/
  build-admin-config.js   Writes public/admin-config.js from the environment
supabase/
  migrations/      Versioned schema — the source of truth for the database
  functions/
    notify-sales/  Edge Function: emails sales@toolhound.com on a new order
  config.toml      Function settings (notify-sales runs without a user JWT)
tests/
  form.spec.js     Customer form, end to end (Playwright)
  admin.spec.js    Dashboard gate and workflow, end to end (Playwright)
```

The only build step is `scripts/build-admin-config.js`, which writes one small
file of configuration. Everything else in `public/` runs as-is.

## Running locally

```bash
npm install
npm run dev        # generates admin-config.js, serves public/ on :4173
npm test           # Playwright end-to-end suite
```

`npm run dev` without `CLERK_PUBLISHABLE_KEY` set is fine: the order form works
normally and `/admin.html` renders a "not configured" notice instead of the
dashboard. To work on the dashboard against a real Clerk instance:

```bash
CLERK_PUBLISHABLE_KEY=pk_test_... npm run dev
```

The tests stub the database client through `window.__TOOLHOUND_DB__`, so they
need no network access and no Supabase credentials, and they never write to the
real project.

If Chromium is not at `/opt/pw-browsers/chromium`, point the suite at yours:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm test
```

## Deploying

The site deploys to Vercel as a static directory. `vercel.json` sets `public/`
as the output directory, runs `scripts/build-admin-config.js` as the build
command, and adds security headers.

There are **two** Content Security Policies, because the two pages need
different things:

- everything except `/admin*` gets the strict policy, whose only network
  destination is the Supabase project
- `/admin*` gets that plus what Clerk needs (its Frontend API for session
  tokens, and an iframe for bot protection during sign-in), and an
  `X-Robots-Tag: noindex` header

**If the Supabase project ever changes, update the URL in three places:**
`public/config.js` *and* the `connect-src` directive of *both* policies in
`vercel.json`. Likewise, if Clerk moves to a custom domain, add it to the
`/admin*` policy's `script-src`, `connect-src`, and `frame-src`. A mismatch
fails silently in the browser as a blocked request — if sign-in appears to do
nothing at all, check the CSP first.

Required Vercel environment variable: `CLERK_PUBLISHABLE_KEY`. If it is
missing, the build still succeeds and the order form deploys normally; only
`/admin` degrades, to a "not configured" notice. An unconfigured dashboard must
never be able to take the customer-facing form offline.

## The internal orders dashboard

`/admin` lists every order the form has produced, its workflow status, and how
long it has been outstanding. It is not linked from the customer form and is
excluded from indexing, but obscurity is not what protects it — see **Access**
below.

Orders move through five states:

| Status | Meaning |
| --- | --- |
| `received` | The customer authorized the order. Nothing has been actioned. |
| `po_sent` | The purchase order has gone to the label supplier. |
| `production_confirmed` | The supplier confirmed the run. |
| `shipped` | The labels left the supplier. |
| `cancelled` | The order will not be fulfilled. |

Each stage has its own timestamp column rather than only a current-status
field. That is what makes cycle time answerable later — "how long from received
to PO sent" across all orders — instead of just "how long has this one been
sitting". Both views are in the dashboard: the default filter is open orders,
oldest first, and anything open for more than seven days is called out in red.

**Staff never write the stage timestamps.** They are set by a database trigger
in response to a status change, and the `authenticated` role holds a
column-level UPDATE grant on `status` and `internal_notes` only. So the
dashboard sends a status and nothing else, a timestamp cannot be backdated
through the API, and a signed-in user cannot rewrite the customer's own order
details. Moving an order backwards clears the stamps it has given up, so the
timeline never claims a milestone the order has not reached.

Artwork is downloaded, never previewed. Customers upload SVG because vector art
reproduces best at label size, and an SVG can carry script; rendering one
inline on a page holding a live staff session would be stored XSS with the
session sitting right there. The dashboard also excludes `logo_file_data` from
the list query, because it is up to ~6MB of base64 per row.

## Access

Authentication is **Clerk SSO** — the same Clerk instance as the ToolHound
Command Center, so staff get one login across both tools — with access limited
to `beaconsoftware.com` and `toolhound.com` addresses.

The domain is checked in two places, and only one of them is the security
boundary:

- **In the database**, by `public.is_label_order_staff()`, which reads the email
  claim out of the verified JWT and gates the staff RLS policies on
  `label_orders`. This runs on every request, whether it came from the
  dashboard or from `curl`. **This is the boundary.**
- **In `admin.js`**, which decides whether to render the table or an "access
  restricted" screen. This is user experience. Treating it as the boundary is
  how these dashboards leak, because a valid token from any Clerk user would
  otherwise reach the REST API directly.

Turn on Clerk's restricted sign-ups / domain allowlist as well, so a
non-allowlisted address cannot get a session at all.

### Setting it up

1. **Clerk dashboard**
   - Integrations → enable the native **Supabase** integration, so session
     tokens carry the `"role": "authenticated"` claim Supabase RLS expects.
   - Sessions → customize the session token to include the email address:
     `{ "email": "{{user.primary_email_address}}" }`. **This is the step that
     is easy to miss.** Without it the RLS policy has no email to check,
     returns false, and the dashboard shows an empty table with no error.
   - Social Connections → enable Google and Microsoft if you want those
     buttons. None of that is in this repo.
   - Note the Clerk **Frontend API / issuer URL**.
2. **Supabase dashboard** → Authentication → Sign In / Up → Third-Party Auth →
   add **Clerk**, and paste that issuer URL.
3. **Vercel** → set `CLERK_PUBLISHABLE_KEY` (`pk_live_...` for production) in
   the project environment and redeploy.
4. **Verify while signed in.** Load `/admin`, confirm orders appear, and change
   one status. If the table is empty, decode
   `await window.Clerk.session.getToken()` at jwt.io and check for both `role`
   and `email`.

Rollback is `SUPABASE_CLERK_AUTH=false` and a redeploy: the client falls back to
the anon key, which holds no SELECT policy, so the dashboard goes blank rather
than open.

### What this project does *not* do

The Clerk replication guide this was based on ends with a step that drops every
`anon` policy and revokes anon's privileges. **Do not run that here.** The
customer order form submits with the anon publishable key, so revoking anon
takes the public form offline. The `anon` INSERT-only policy is load-bearing
and stays.

For the same reason the staff policies are scoped to `label_orders` alone,
rather than the guide's blanket "authenticated full access on every table" —
that policy, on a Clerk instance shared with another app, would hand every user
of that app the run of this database.

## Notifications

Every new order emails `sales@toolhound.com` through a **Supabase Database
Webhook** on `INSERT` into `label_orders`, which calls the `notify-sales` Edge
Function, which sends through **Resend**.

The webhook fires off the database row rather than from the browser on purpose.
The form submits directly from the customer's browser, so a client-side send
could be skipped by a crafted request, and a mail outage would either block the
customer's submission or vanish silently. Firing off the row means every order
that actually lands generates a notification, and Resend being down never costs
a customer their order.

The email carries the order reference, customer, shipping address, label spec,
quantity, sequence range, and authorization, plus a link to the dashboard. It
never carries the uploaded artwork — same SVG reasoning as above.

### Deploying it

```bash
supabase functions deploy notify-sales
supabase secrets set RESEND_API_KEY=re_...
supabase secrets set NOTIFY_WEBHOOK_SECRET="$(openssl rand -hex 32)"
supabase secrets set NOTIFY_TO=sales@toolhound.com
supabase secrets set NOTIFY_FROM='ToolHound Orders <orders@toolhound.com>'
supabase secrets set DASHBOARD_URL=https://tool-hound-label-order-form.vercel.app/admin
```

`NOTIFY_FROM` has to be on a domain verified in Resend, or Resend rejects the
send. `NOTIFY_TO` accepts a comma-separated list.

Then in the Supabase dashboard → Database → Webhooks, create a webhook:

- Table `public.label_orders`, event **Insert**
- Type **HTTP Request**, `POST` to the `notify-sales` function URL
- HTTP header `x-notify-secret` set to the same value as
  `NOTIFY_WEBHOOK_SECRET`

The function URL is public, so that header is what stops anyone from posting a
fabricated order straight to sales@. A request without it gets a 401. A Resend
failure returns 500 so the webhook retries; an event the function does not
handle returns 200, because retrying would never make it handled.

## Database

The form writes to `public.label_orders` in the **ToolHound Label Orders**
Supabase project (`ayqcteloqdrlemehozzk`). This project is deliberately
isolated from ToolHound OS; the `synced_to_dashboard_at` column is reserved for
a future one-way mirror job.

`supabase/migrations/` is the source of truth for the schema.

- `0001_label_orders.sql` — table, RLS, and the insert policy *(applied)*
- `0002_harden_label_orders.sql` — least-privilege grants, integrity
  constraints, indexes *(applied)*
- `0003_order_status_and_staff_access.sql` — the status pipeline, the stage
  timestamp triggers, and the staff read/write policies *(apply this one)*

Migration 0003 is written to be re-runnable: every policy, constraint, and
trigger it creates is dropped first, and the column additions are
`if not exists`.

### Why the public key is safe to publish

`config.js` contains the Supabase **publishable (anon) key**. That key is meant
to ship in client-side code. What protects the data is row level security:

- `anon` holds an **INSERT-only** policy on `label_orders`
- there is deliberately **no SELECT policy for anon**, so the key can file an
  order but cannot read anyone's order back
- `SELECT`, `UPDATE`, `DELETE`, and `TRUNCATE` are additionally revoked from
  anon at the grant level, so the table stays protected even if a policy is
  later added by mistake
- a `BEFORE INSERT` trigger forces every new row to `status = 'received'` with
  no stage timestamps and no internal notes, because the anon INSERT grant
  covers every column and a hand-crafted request would otherwise be able to
  file an order pre-marked as shipped

The same reasoning covers the dashboard's Clerk publishable key: it ships in
client-side code, and what protects the orders is the staff RLS policy behind
it. **Never put the `service_role` key in `public/`.** Reading orders needs no
elevated key — a signed-in staff session is enough.

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
- **No customer confirmation email.** New orders notify
  `sales@toolhound.com`, but nothing emails the *customer*, and the
  confirmation screen deliberately does not claim otherwise — it directs them
  to print a copy and gives them a phone number. Adding one is a small
  extension of `notify-sales`: a second Resend send to `contact_email`.
- **The dashboard does not refresh itself.** It loads orders once per sign-in,
  with a Refresh button. Two people working the same queue will not see each
  other's status changes until one of them refreshes. Supabase Realtime on
  `label_orders` would fix it if that becomes annoying.
- **No audit trail on status changes.** The row records the current status and
  when each stage was reached, but not who moved it. Adding a
  `label_order_events` table written by the same trigger would give you that,
  and is worth doing before more than a couple of people use the dashboard.
- **Artwork is stored inline.** Logo files are base64 encoded into
  `logo_file_data` rather than object storage. Fine at current volume; move to
  Supabase Storage if orders grow or files get larger.
- **Uploaded SVGs are untrusted.** SVG is accepted because vector artwork
  reproduces best at label size, but an SVG can carry script. The dashboard
  therefore hands artwork over as a download and never renders it inline, and
  `notify-sales` never attaches it. Any *other* internal tool that displays
  these logos must do the same, or rasterise them first.
