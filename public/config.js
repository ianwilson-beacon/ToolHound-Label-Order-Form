/**
 * Supabase connection settings for the public label order form.
 *
 * The publishable ("anon") key is designed to ship in client-side code — it is
 * visible to anyone who views source, and that is fine. What protects the data
 * is row level security on `public.label_orders`: the anon role holds an
 * INSERT-only policy and no SELECT policy, so this key can file an order but
 * cannot read anybody's order back. Never put the service_role key here.
 *
 * See supabase/migrations/ for the policies and constraints this relies on.
 */
window.TOOLHOUND_CONFIG = {
  supabaseUrl: 'https://ayqcteloqdrlemehozzk.supabase.co',
  supabaseAnonKey: 'sb_publishable_DpVxcMatuMmcyqF0B774AQ_y8EuFlp1',

  // Shown in the header and on the printed authorization record.
  supportPhone: '1 (800) 387-8665',

  // Hardware order portal (hardware.html). Prices, currency and availability
  // all come from the database — the storefront has no pricing logic of its
  // own — so there is little to configure here beyond the fallback currency
  // used before the catalog has loaded.
  hardware: {
    currency: 'CAD'
  },

  // Largest artwork file a customer may attach, in megabytes. The database
  // caps the encoded payload at 6,000,000 characters, which is roughly 4.2MB
  // of binary — keep this at or below that.
  maxLogoFileMb: 4
};
