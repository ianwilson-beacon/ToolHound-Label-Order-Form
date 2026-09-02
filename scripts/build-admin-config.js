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

const clerkKey = (process.env.CLERK_PUBLISHABLE_KEY || '').trim();
// The handoff flag from the Clerk replication guide: with it off the client
// falls back to the anon key, which has no read access, so the dashboard shows
// nothing. Keep it on unless you are mid-rollback.
const clerkAuth = (process.env.SUPABASE_CLERK_AUTH || 'true').trim() !== 'false';

if (!clerkKey) {
  console.warn(
    '[build-admin-config] CLERK_PUBLISHABLE_KEY is not set. /admin will render '
    + 'a configuration error instead of the dashboard. The customer order form '
    + 'is unaffected.'
  );
}

const body = `/**
 * GENERATED FILE — do not edit, and do not commit.
 * Produced by scripts/build-admin-config.js from the deploy environment.
 *
 * The Clerk publishable key is designed to ship in client-side code, exactly
 * like the Supabase publishable key in config.js. Neither is a secret. What
 * protects the orders is row level security: see
 * supabase/migrations/0003_order_status_and_staff_access.sql.
 */
window.TOOLHOUND_ADMIN_CONFIG = {
  clerkPublishableKey: ${clerkKey ? JSON.stringify(clerkKey) : 'null'},
  useClerkAuth: ${clerkAuth},
  allowedDomains: ['beaconsoftware.com', 'toolhound.com']
};
`;

fs.writeFileSync(OUT, body, 'utf8');
console.log(
  `[build-admin-config] wrote ${path.relative(process.cwd(), OUT)} `
  + `(clerk key: ${clerkKey ? 'set' : 'MISSING'}, clerk auth: ${clerkAuth})`
);
