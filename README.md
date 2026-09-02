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
   full-colour choice (logo orders only — it carries a surcharge, so it does
   not apply to text-only labels), quantity (500-unit increments, or an exact
   custom amount), starting sequence number, special instructions
3. **Review** — everything on one screen, including the computed sequence range
4. **Authorization** — named approval, a drawn signature, and an explicit
   agreement to the nonreturnable terms

The confirmation screen shows the order reference, ToolHound's contact
information, and offers **Print / save a copy**, which produces a one-page
authorization record.

The domain restriction is enforced twice: `admin.js` hints each provider's
account picker toward the right domain and re-checks the signed-in email
before showing any data, but the real boundary is
`supabase/migrations/0005_oauth_domain_restriction.sql` — a trigger on
`auth.users` that rejects account creation outright for a Google or
Microsoft sign-in outside the approved domain. A client-side check alone
would not be a boundary, since the Auth API can be called directly.

**One manual step is required before Google/Microsoft sign-in works**: the
OAuth providers themselves are enabled in the Supabase dashboard, not from
this repo. In the **ToolHound Label Orders** project, go to
**Authentication → Sign In / Providers**, enable **Google** and **Azure**,
and give each the Client ID/Secret from a Google Cloud OAuth app and a
Microsoft Entra ID (Azure AD) app registration respectively (reuse the ones
already set up for the ToolHound Dashboard if that's simpler than creating
new ones — a Google/Azure app can serve multiple redirect URIs). Add this
project's callback URL — shown on that same settings page — as an
authorized redirect URI in each app.

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
  styles.css       Shared styles, including the print stylesheet
  config.js        Supabase URL + publishable key, support phone, contact info
  robots.txt
  toolhound-logo.png
supabase/
  migrations/      Versioned schema — the source of truth for the database
  functions/
    notify-sales/  Edge Function: emails sales@toolhound.com on a new order
  config.toml      Function settings (notify-sales runs without a user JWT)
tests/
  form.spec.js     Customer form, end to end (Playwright)
  admin.spec.js    Dashboard gate and workflow, end to end (Playwright)
```

There is no build step. `public/` is a static site that runs as-is.

## Running locally

```bash
npm install
npm run dev        # serves public/ on http://127.0.0.1:4173
npm test           # Playwright end-to-end suite
```

The tests stub the Supabase client through `window.__TOOLHOUND_DB__` (the
order form) and `window.__TOOLHOUND_CLIENT__` (the dashboard, which needs
`.auth` as well as `.from`), so they need no network access and no Supabase
credentials, and they never write to the real project.

`/admin.html` served locally will render its sign-in card but cannot complete a
sign-in, because the OAuth redirect and the emailed link both come back to the
deployed origin.

If Chromium is not at `/opt/pw-browsers/chromium`, point the suite at yours:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm test
```

## Deploying

The site deploys to Vercel as a static directory. `vercel.json` sets `public/`
as the output directory and adds security headers.

There are **two** Content Security Policies, because the two pages need
different things:

- everything except `/admin*` gets the strict policy, whose only network
  destination is the Supabase project
- `/admin*` gets the same policy with `form-action 'self'` instead of `'none'`,
  because signing in redirects out to the identity provider, plus an
  `X-Robots-Tag: noindex` header

**If the Supabase project ever changes, update the URL in three places:**
`public/config.js` *and* the `connect-src` directive of *both* policies in
`vercel.json`. A mismatch fails silently in the browser as a blocked request —
if sign-in appears to do nothing at all, check the CSP first.

No environment variables and no build command. The dashboard's only
configuration is the Supabase URL and publishable key already in
`public/config.js`.

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
details or their drawn signature.

Moving an order backwards clears the stamps it has given up, so the timeline
never claims a milestone the order has not reached.

The order drawer shows the customer's drawn signature inline. That is safe
where the uploaded artwork is not, and the difference is the database
constraint: `signature_data` is bounded to a `data:image/png;base64,` payload,
and a PNG cannot carry script.

Artwork is downloaded, never previewed. Customers upload SVG because vector art
reproduces best at label size, and an SVG can carry script; rendering one
inline on a page holding a live staff session would be stored XSS with the
session sitting right there. The dashboard also excludes `logo_file_data` from
the list query, because it is up to ~6MB of base64 per row.

## Access

Sign-in is **Supabase Auth**, in the same project that stores the orders, so
there is no second service to administer and nothing to configure per
deployment. Two ways in:

- **Continue with Google**, hinted at the Beacon domain
- **An emailed sign-in link** (magic link), which needs no OAuth provider
  configured at all

Access is limited to **`beaconsoftware.com`** addresses, and the domain is
checked in two places — only one of which is the security boundary:

- **In the database**, by `public.is_label_order_staff()`, which reads the
  `email` claim out of the verified JWT and gates the staff RLS policies on
  `label_orders`. This runs on every request, whether it came from the
  dashboard or from `curl`. **This is the boundary.**
- **In `admin.js`**, which decides whether to render the table or an "access
  restricted" screen. This is user experience. Treating it as the boundary is
  how these dashboards leak.

Because the check is on the claim rather than on the existence of an account,
**leaving sign-ups open is not a hole**: someone outside Beacon can obtain a
session and still read nothing. That is a deliberate property, not luck — it is
what makes the magic-link path safe to offer.

Beacon only, deliberately. `@toolhound.com` was in the allowlist earlier and
was removed. Worth knowing: the new-order notification goes to
`sales@toolhound.com`, so whoever reads that inbox needs a Beacon account to
open the dashboard link in it. Widening the allowlist again means changing it
in **two** places that must agree — `ALLOWED_DOMAINS` in `public/admin.js` and
the regex in `public.is_label_order_staff()` (migration `0006`). The second is
the one that actually grants access.

### Setting it up

1. **Apply migration `0007_order_status_workflow.sql`.** That is the only
   required step; everything else below is already in place or optional.
2. **Optional — Google sign-in.** Supabase → Authentication → Sign In /
   Providers → Google, with a Google OAuth client. If you skip it, the emailed
   sign-in link still works and needs no provider setup.
3. **Optional — turn off unused providers.** Microsoft/Azure was for the
   `@toolhound.com` path that no longer has access. Leaving it enabled is not
   an exposure, since the policy checks the domain, but there is no reason for
   an unused sign-up path.

`0005_oauth_domain_restriction.sql` rejects off-domain Google sign-ups at
account creation. It is a useful second layer, but note what it does *not*
cover: it only restricts the `google` and `azure` providers, so it says nothing
about magic-link accounts. The policy from `0006` is what covers every path.

### Verifying

Load `/admin` signed in with a Beacon account and confirm orders appear, then
change one status and check the drawer timeline picks up the new timestamp.

An empty table for an account that should have access almost always means
migration `0007` has not been applied. A sign-in that appears to do nothing is
usually the CSP — check the console for a blocked request.

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

**The recipient and the dashboard allowlist do not match.** Notifications go to
`sales@toolhound.com`; the dashboard admits `beaconsoftware.com` only. So the
email lands with someone who cannot follow its link. Resolve it whichever way
suits: point `NOTIFY_TO` at a Beacon address (or add one alongside — it takes a
comma-separated list), or put `toolhound.com` back in the allowlist per
**Access** above.

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
- `0003_add_signature.sql` — the signature capture column *(applied)*
- `0004_staff_read_access.sql` — SELECT for signed-in staff *(applied)*
- `0005_oauth_domain_restriction.sql` — the Supabase Auth sign-up domain
  trigger *(applied)*
- `0006_restrict_staff_reads.sql` — replaces 0004's `using (true)` with a
  domain-checked predicate *(applied)*
- `0007_order_status_workflow.sql` — the status pipeline, the stage timestamp
  triggers, and the staff UPDATE policy *(apply this one)*

**Why 0006 exists.** 0004 granted staff SELECT with `using (true)`, relying on
"there is no public sign-up" to make `authenticated` mean "staff". 0005's
trigger only restricts the `google` and `azure` providers, so any other
enabled sign-up path fell through, and third-party auth does not create
`auth.users` rows at all. 0006 moves the domain check into the policy, where it
runs on every request however the session was minted — including the
magic-link path, which 0005 says nothing about. 0005's trigger stays as a
useful second layer on Google sign-ups.

Migration 0007 is written to be re-runnable: every policy, constraint, and
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
- signed-in staff get SELECT plus a **column-level** UPDATE grant on `status`
  and `internal_notes` only, so the customer's own order details, their drawn
  signature, and the stage timestamps are not writable through the API by
  anyone

**Never put the `service_role` key in `public/`.** Reading orders needs no
elevated key — a signed-in staff session is enough, and the dashboard uses the
same publishable key the form does.

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
- **Artwork and signatures are stored inline.** Logo files and the drawn
  signature are base64 encoded into `logo_file_data` / `signature_data`
  rather than object storage. Fine at current volume; move to Supabase
  Storage if orders grow or files get larger.
- **Uploaded SVGs are untrusted.** SVG is accepted because vector artwork
  reproduces best at label size, but an SVG can carry script. The dashboard
  therefore hands artwork over as a download and never renders it inline, and
  `notify-sales` never attaches it. Any *other* internal tool that displays
  these logos must do the same, or rasterise them first.
