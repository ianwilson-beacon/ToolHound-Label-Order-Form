#!/usr/bin/env node
/**
 * Generates public/admin-config.js from the environment.
 *
 * The customer form's config.js is committed because its Supabase publishable
 * key never changes. The dashboard's Clerk key does: a Clerk instance issues a
 * `pk_test_...` key for development and a `pk_live_...` key on a real domain,
 * so hardcoding one guarantees the wrong key ships to one of the two.
 *
 * A missing key is a warning, not a build failure. The customer-facing order
 * form and the dashboard deploy together, and an unconfigured dashboard must
 * not be able to take the order form offline. admin.js refuses to render
 * anything without a key, so the failure stays contained to /admin.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'admin-config.js');

/**
 * The Clerk instance this dashboard signs in against. Committed rather than
 * required as an environment variable, because a publishable key is designed
 * to ship in client-side code and making it mandatory means one more thing to
 * configure per deployment.
 *
 * This is Clerk's **development** instance (`pk_test_`,
 * perfect-lemming-55.clerk.accounts.dev). Its sign-in card carries a
 * "Development mode" banner and it is not meant to carry production traffic.
 * For production, set CLERK_PUBLISHABLE_KEY to the `pk_live_` key in the Vercel
 * project environment — the environment always wins over this default.
 */
const DEFAULT_CLERK_PUBLISHABLE_KEY =
  'pk_test_cGVyZmVjdC1sZW1taW5nLTU1LmNsZXJrLmFjY291bnRzLmRldiQ';

/**
 * Who may open the dashboard. Enforced in the database by
 * public.is_label_order_staff() — this list only decides what the page
 * renders, so the two must be changed together.
 */
const ALLOWED_DOMAINS = ['beaconsoftware.com'];

const clerkKey =
  (process.env.CLERK_PUBLISHABLE_KEY || DEFAULT_CLERK_PUBLISHABLE_KEY).trim();
// The handoff flag from the Clerk replication guide: with it off the client
// falls back to the anon key, which has no read access, so the dashboard shows
// nothing. Keep it on unless you are mid-rollback.
const clerkAuth = (process.env.SUPABASE_CLERK_AUTH || 'true').trim() !== 'false';

if (!clerkKey) {
  // Only reachable if the default above is emptied deliberately. A missing key
  // is a warning, not a build failure: the customer-facing order form and the
  // dashboard deploy together, and an unconfigured dashboard must not be able
  // to take the order form offline.
  console.warn(
    '[build-admin-config] No Clerk publishable key. /admin will render a '
    + 'configuration error instead of the dashboard. The customer order form '
    + 'is unaffected.'
  );
} else if (!process.env.CLERK_PUBLISHABLE_KEY) {
  console.log('[build-admin-config] using the committed default Clerk key');
}

if (clerkKey.indexOf('pk_live_') !== 0) {
  console.warn(
    '[build-admin-config] This is a Clerk development key. Production should '
    + 'set CLERK_PUBLISHABLE_KEY to the pk_live_ key.'
  );
}

const body = `/**
 * GENERATED FILE — do not edit, and do not commit.
 * Produced by scripts/build-admin-config.js from the deploy environment.
 *
 * The Clerk publishable key is designed to ship in client-side code, exactly
 * like the Supabase publishable key in config.js. Neither is a secret. What
 * protects the orders is row level security: see
 * supabase/migrations/0006_restrict_staff_reads.sql.
 */
window.TOOLHOUND_ADMIN_CONFIG = {
  clerkPublishableKey: ${clerkKey ? JSON.stringify(clerkKey) : 'null'},
  useClerkAuth: ${clerkAuth},
  allowedDomains: ${JSON.stringify(ALLOWED_DOMAINS)}
};
`;

fs.writeFileSync(OUT, body, 'utf8');
console.log(
  `[build-admin-config] wrote ${path.relative(process.cwd(), OUT)} `
  + `(clerk key: ${clerkKey ? 'set' : 'MISSING'}, clerk auth: ${clerkAuth})`
);
