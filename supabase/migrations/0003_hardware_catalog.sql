-- Hardware drop-ship portal — catalog, vendor costs, and pricing controls.
--
-- ToolHound resells barcode scanners, mobile computers, printers and RFID
-- readers, drop-shipped from two distributors (BlueStar and ScanSource).
-- Distributor cost and availability move daily, so cost lives in
-- `hardware_vendor_offers` (one row per product per vendor) and the
-- customer-facing price is a *published snapshot* on `hardware_products`.
--
-- The split matters for two reasons:
--   1. Customers must never see distributor cost. Cost lives in a table anon
--      has no policy on at all, and the columns anon may read on
--      hardware_products are restricted with column-level grants.
--   2. Prices should not flap while a customer is filling a cart. Nothing a
--      cost feed writes changes what a customer sees until staff publish.

-- 1. Distributors -------------------------------------------------------------
create table if not exists public.hardware_vendors (
  code       text primary key check (code ~ '^[a-z0-9_]{2,32}$'),
  name       text not null,
  portal_url text,
  active     boolean not null default true,
  notes      text,
  created_at timestamptz not null default now()
);

comment on table public.hardware_vendors is
  'Distributors we drop-ship from. Cost feeds are keyed on code.';

insert into public.hardware_vendors (code, name, portal_url, notes) values
  ('bluestar',
   'BlueStar',
   'https://www.bluestoreinc.com/',
   'Reseller portal. Ask the BlueStar rep for the daily price/availability file or API credentials rather than scraping the storefront.'),
  ('scansource',
   'ScanSource',
   'https://www.scansource.com/',
   'Reseller portal. ScanSource publishes price and availability over EDI (832/846) and a partner API — use that, not the logged-in storefront.')
on conflict (code) do nothing;

-- 2. Pricing settings ---------------------------------------------------------
-- Single row. `id` is a boolean pinned to true so a second row cannot exist.
create table if not exists public.hardware_settings (
  id                   boolean primary key default true check (id),
  display_currency     text not null default 'CAD' check (display_currency in ('CAD','USD')),
  -- Distributor quotes arrive in USD and CAD. Comparing "cheapest across two
  -- vendors" is meaningless without a rate, so normalise through this one.
  fx_usd_to_cad        numeric(10,5) not null default 1.37000 check (fx_usd_to_cad > 0),
  default_markup_pct   numeric(6,3) not null default 25.000 check (default_markup_pct >= 0 and default_markup_pct <= 500),
  -- A cost older than this is treated as unusable when picking a best offer.
  stale_after_hours    integer not null default 48 check (stale_after_hours between 1 and 8760),
  -- Round published prices up to this multiple of a cent (100 = whole dollars).
  round_price_to_cents integer not null default 100 check (round_price_to_cents between 1 and 10000),
  updated_at           timestamptz not null default now()
);

insert into public.hardware_settings (id) values (true) on conflict (id) do nothing;

-- 3. Products -----------------------------------------------------------------
create table if not exists public.hardware_products (
  id                   uuid primary key default gen_random_uuid(),
  sku                  text not null unique,
  name                 text not null,
  category             text not null,
  short_description    text,
  long_description     text,
  image_url            text,
  spec                 jsonb,
  sort_order           integer not null default 100,

  -- Pricing controls (staff only) -------------------------------------------
  pricing_mode         text not null default 'auto'
                         check (pricing_mode in ('auto','manual')),
  markup_pct           numeric(6,3) check (markup_pct >= 0 and markup_pct <= 500),
  min_margin_cents     integer not null default 0 check (min_margin_cents >= 0),
  price_override_cents integer check (price_override_cents > 0),

  -- Published snapshot (what customers see) ---------------------------------
  is_published            boolean not null default false,
  published_price_cents   integer check (published_price_cents > 0),
  published_currency      text check (published_currency in ('CAD','USD')),
  published_cost_cents    integer check (published_cost_cents > 0),
  published_vendor_code   text references public.hardware_vendors(code),
  published_availability  text check (published_availability in
                             ('in_stock','low_stock','backorder','discontinued','unknown')),
  published_at            timestamptz,
  lead_time_days          integer check (lead_time_days between 0 and 365),

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint hardware_products_text_lengths check (
    length(sku) between 1 and 64
    and length(name) between 1 and 200
    and length(category) between 1 and 80
    and (short_description is null or length(short_description) <= 400)
    and (long_description is null or length(long_description) <= 4000)
    and (image_url is null or length(image_url) <= 500)
  ),
  -- Manual pricing means somebody typed a number; without one there is nothing
  -- to fall back on.
  constraint hardware_products_manual_needs_override check (
    pricing_mode <> 'manual' or price_override_cents is not null
  ),
  -- Never expose a product with no price attached to it.
  constraint hardware_products_published_has_price check (
    is_published = false
    or (published_price_cents is not null and published_currency is not null)
  )
);

comment on table public.hardware_products is
  'Hardware we resell. published_* columns are the customer-facing snapshot, written by public.hw_publish_prices().';
comment on column public.hardware_products.markup_pct is
  'Per-product markup over landed distributor cost. NULL falls back to hardware_settings.default_markup_pct.';

create index if not exists hardware_products_catalog_idx
  on public.hardware_products (category, sort_order, name)
  where is_published;

-- 4. Vendor cost and availability ---------------------------------------------
create table if not exists public.hardware_vendor_offers (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.hardware_products(id) on delete cascade,
  vendor_code  text not null references public.hardware_vendors(code),
  vendor_sku   text not null check (length(vendor_sku) between 1 and 64),
  cost_cents   integer not null check (cost_cents > 0),
  currency     text not null default 'USD' check (currency in ('CAD','USD')),
  -- Freight and duty on top of the quoted unit cost. Drop-shipping from a US
  -- distributor into Canada is not free, and a markup applied to the bare unit
  -- cost quietly sells at a loss.
  landed_add_cents integer not null default 0 check (landed_add_cents >= 0),
  availability text not null default 'unknown'
                 check (availability in ('in_stock','low_stock','backorder','discontinued','unknown')),
  stock_qty    integer check (stock_qty >= 0),
  quoted_at    timestamptz not null default now(),
  source       text not null default 'manual' check (source in ('manual','csv','api','edi')),
  raw          jsonb,
  updated_at   timestamptz not null default now(),
  unique (product_id, vendor_code)
);

comment on table public.hardware_vendor_offers is
  'Latest known cost and availability per product per distributor. Refreshed daily by the price import; never readable by anon.';

create index if not exists hardware_vendor_offers_product_idx
  on public.hardware_vendor_offers (product_id);
create index if not exists hardware_vendor_offers_stale_idx
  on public.hardware_vendor_offers (quoted_at);

-- 5. Staff --------------------------------------------------------------------
-- Membership is an explicit allowlist: signing up for an account is not enough.
create table if not exists public.hardware_staff (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  email    text,
  added_at timestamptz not null default now()
);

comment on table public.hardware_staff is
  'Allowlist of Supabase Auth users permitted to read cost and change prices. Add rows from the dashboard or with the service role.';

create or replace function public.hw_is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.hardware_staff s where s.user_id = auth.uid()
  );
$$;

comment on function public.hw_is_staff() is
  'True when the calling user is on the hardware staff allowlist. Security definer so policies can consult the allowlist without granting anon read on it.';

-- Postgres grants EXECUTE on new functions to PUBLIC, which would leave this
-- callable by anon. Revoke that and hand it back only where a policy needs it.
revoke all on function public.hw_is_staff() from public, anon;
grant execute on function public.hw_is_staff() to authenticated, service_role;

-- 6. Row level security -------------------------------------------------------
alter table public.hardware_vendors       enable row level security;
alter table public.hardware_settings      enable row level security;
alter table public.hardware_products      enable row level security;
alter table public.hardware_vendor_offers enable row level security;
alter table public.hardware_staff         enable row level security;

-- anon: published products only, and only the columns granted below.
drop policy if exists "anon reads published products" on public.hardware_products;
create policy "anon reads published products"
  on public.hardware_products for select to anon
  using (is_published);

-- Staff hold full control of catalog, cost and settings.
drop policy if exists "staff manage products" on public.hardware_products;
create policy "staff manage products"
  on public.hardware_products for all to authenticated
  using (public.hw_is_staff()) with check (public.hw_is_staff());

drop policy if exists "staff manage offers" on public.hardware_vendor_offers;
create policy "staff manage offers"
  on public.hardware_vendor_offers for all to authenticated
  using (public.hw_is_staff()) with check (public.hw_is_staff());

drop policy if exists "staff manage vendors" on public.hardware_vendors;
create policy "staff manage vendors"
  on public.hardware_vendors for all to authenticated
  using (public.hw_is_staff()) with check (public.hw_is_staff());

drop policy if exists "staff manage settings" on public.hardware_settings;
create policy "staff manage settings"
  on public.hardware_settings for all to authenticated
  using (public.hw_is_staff()) with check (public.hw_is_staff());

-- Staff may see who else is staff, but not edit the allowlist from the client.
drop policy if exists "staff read allowlist" on public.hardware_staff;
create policy "staff read allowlist"
  on public.hardware_staff for select to authenticated
  using (public.hw_is_staff());

-- 7. Grants -------------------------------------------------------------------
-- RLS already blocks anon everywhere except published products, but the table
-- grants are wider than needed. Narrow them so a policy added by mistake later
-- cannot leak cost.
revoke all on public.hardware_products      from anon;
revoke all on public.hardware_vendor_offers from anon, authenticated;
revoke all on public.hardware_settings      from anon;
revoke all on public.hardware_vendors       from anon;
-- No anon policy or grant on hardware_vendors: which distributor filled an
-- order is our business, not the customer's.
revoke all on public.hardware_staff         from anon, authenticated;

-- The one thing anon may read, column by column. Cost, markup, override and
-- the vendor we bought from are deliberately absent.
grant select (
  id, sku, name, category, short_description, long_description, image_url,
  spec, sort_order, is_published, published_price_cents, published_currency,
  published_availability, lead_time_days
) on public.hardware_products to anon;

grant select, insert, update, delete on public.hardware_vendor_offers to authenticated;
grant select on public.hardware_staff to authenticated;
