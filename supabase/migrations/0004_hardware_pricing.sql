-- Hardware drop-ship portal — cheapest-vendor pricing.
--
-- The rule the business wants: price off the cheapest of the two distributors,
-- refreshed daily. Turning that into something safe to sell from needs four
-- decisions encoded here rather than left to a spreadsheet:
--
--   * currency — distributors quote in USD and CAD, so costs are normalised
--     through hardware_settings.fx_usd_to_cad before being compared;
--   * freight and duty — compared on landed cost, not the bare unit cost;
--   * staleness — a quote older than stale_after_hours is not used at all,
--     because "cheapest" from a feed that stopped running is a guess;
--   * availability — an in-stock offer beats a cheaper backordered one. The
--     point of drop-shipping is that the box ships.
--
-- Nothing here changes what a customer sees. Publishing does, and publishing
-- is an explicit staff action (hw_publish_prices).

-- 0. Who may see cost -------------------------------------------------------
-- Three legitimate callers: a staff user signed in through the admin screen,
-- the nightly price import running with the service role, and a migration or
-- psql session run by an operator. Everyone else gets nothing, which is why
-- the cost functions below are security definer *and* guarded. Note that
-- security definer makes current_user the function owner, so the checks below
-- read the *effective* role and the login role instead.
create or replace function public.hw_can_read_cost()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.hw_is_staff()
     -- PostgREST issues SET LOCAL ROLE per request, so the effective role is
     -- the reliable signal; the JWT claim is a fallback for other clients.
     or coalesce(nullif(current_setting('role', true), ''), 'none') = 'service_role'
     or coalesce(
          nullif(current_setting('request.jwt.claim.role', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role',
          ''
        ) = 'service_role'
     -- A migration or psql session run by an operator: no role was assumed,
     -- and the login role is a superuser.
     or (coalesce(nullif(current_setting('role', true), ''), 'none') = 'none'
         and session_user in ('postgres', 'supabase_admin'));
$$;

comment on function public.hw_can_read_cost() is
  'Gate on distributor cost: hardware staff, the service role, or a superuser session.';

revoke all on function public.hw_can_read_cost() from public, anon;
grant execute on function public.hw_can_read_cost() to authenticated, service_role;

-- 1. Cost normalisation -------------------------------------------------------
create or replace function public.hw_landed_cost_cents(
  p_cost_cents integer,
  p_landed_add_cents integer,
  p_currency text,
  p_display_currency text,
  p_fx_usd_to_cad numeric
)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_currency = p_display_currency then p_cost_cents + p_landed_add_cents
    when p_currency = 'USD' and p_display_currency = 'CAD'
      then ceil((p_cost_cents + p_landed_add_cents) * p_fx_usd_to_cad)::integer
    when p_currency = 'CAD' and p_display_currency = 'USD'
      then ceil((p_cost_cents + p_landed_add_cents) / p_fx_usd_to_cad)::integer
    else p_cost_cents + p_landed_add_cents
  end;
$$;

comment on function public.hw_landed_cost_cents(integer,integer,text,text,numeric) is
  'Unit cost plus freight/duty, converted into the display currency. Conversions round up: a rate that moves against us should not silently eat the margin.';

-- 2. Best offer per product ---------------------------------------------------
create or replace function public.hw_best_offer(p_product_id uuid)
returns table (
  vendor_code       text,
  vendor_sku        text,
  cost_cents        integer,
  cost_currency     text,
  landed_cost_cents integer,
  availability      text,
  stock_qty         integer,
  quoted_at         timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select * from public.hardware_settings
    where id and public.hw_can_read_cost()
  )
  select o.vendor_code,
         o.vendor_sku,
         o.cost_cents,
         o.currency,
         public.hw_landed_cost_cents(o.cost_cents, o.landed_add_cents, o.currency,
                                     s.display_currency, s.fx_usd_to_cad),
         o.availability,
         o.stock_qty,
         o.quoted_at
  from public.hardware_vendor_offers o
  cross join s
  join public.hardware_vendors v on v.code = o.vendor_code and v.active
  where o.product_id = p_product_id
    and o.availability <> 'discontinued'
    and o.quoted_at > now() - make_interval(hours => s.stale_after_hours)
  order by (o.availability in ('in_stock','low_stock')) desc,
           public.hw_landed_cost_cents(o.cost_cents, o.landed_add_cents, o.currency,
                                       s.display_currency, s.fx_usd_to_cad) asc,
           o.quoted_at desc
  limit 1;
$$;

comment on function public.hw_best_offer(uuid) is
  'The distributor we would buy this product from right now: in-stock first, then cheapest landed cost, ignoring quotes older than hardware_settings.stale_after_hours.';

-- 3. Suggested customer price -------------------------------------------------
create or replace function public.hw_suggested_price_cents(p_product_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s        public.hardware_settings;
  p        public.hardware_products;
  best     record;
  markup   numeric;
  price    numeric;
begin
  if not public.hw_can_read_cost() then
    return null;
  end if;

  select * into s from public.hardware_settings where id;
  select * into p from public.hardware_products where id = p_product_id;
  if p.id is null then
    return null;
  end if;

  -- A manual override is the price, full stop. Staff typed it on purpose.
  if p.pricing_mode = 'manual' then
    return p.price_override_cents;
  end if;

  select * into best from public.hw_best_offer(p_product_id);
  if best.landed_cost_cents is null then
    return null;                                  -- no usable cost, no price
  end if;

  markup := coalesce(p.markup_pct, s.default_markup_pct);
  price  := best.landed_cost_cents * (1 + markup / 100.0);
  price  := greatest(price, best.landed_cost_cents + p.min_margin_cents);

  -- Round up to the configured increment so the catalog shows tidy numbers and
  -- rounding never lands below the margin floor.
  return (ceil(price / s.round_price_to_cents) * s.round_price_to_cents)::integer;
end;
$$;

comment on function public.hw_suggested_price_cents(uuid) is
  'Best landed cost plus markup, floored at cost + min_margin_cents and rounded up to hardware_settings.round_price_to_cents. Returns NULL when no fresh cost exists.';

-- 4. Publishing ---------------------------------------------------------------
-- Snapshots the current suggestion onto the product so the catalog is stable
-- between publishes. Pass null to consider every active product.
create or replace function public.hw_publish_prices(p_product_ids uuid[] default null)
returns table (product_id uuid, sku text, price_cents integer, published boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  s   public.hardware_settings;
  rec record;
  sug integer;
  best record;
begin
  if not public.hw_can_read_cost() then
    raise exception 'hw_publish_prices: caller may not change prices';
  end if;

  select * into s from public.hardware_settings where id;

  for rec in
    select * from public.hardware_products
    where p_product_ids is null or id = any (p_product_ids)
    order by category, sort_order, name
  loop
    sug := public.hw_suggested_price_cents(rec.id);
    select * into best from public.hw_best_offer(rec.id);

    if sug is null then
      -- Unpublish rather than leave a stale price on the shelf: if both feeds
      -- have gone quiet or the product is discontinued everywhere, we cannot
      -- honour yesterday's number.
      update public.hardware_products
         set is_published = false, updated_at = now()
       where id = rec.id;
      return query select rec.id, rec.sku, null::integer, false,
        'no fresh vendor cost within the staleness window';
      continue;
    end if;

    update public.hardware_products
       set published_price_cents  = sug,
           published_currency     = s.display_currency,
           published_cost_cents   = best.landed_cost_cents,
           published_vendor_code  = best.vendor_code,
           published_availability = coalesce(best.availability, 'unknown'),
           published_at           = now(),
           is_published           = true,
           updated_at             = now()
     where id = rec.id;

    return query select rec.id, rec.sku, sug, true,
      coalesce(best.vendor_code, 'manual') || ' @ '
        || coalesce((best.landed_cost_cents / 100.0)::text, 'n/a');
  end loop;
end;
$$;

comment on function public.hw_publish_prices(uuid[]) is
  'Staff-only. Snapshots suggested prices onto hardware_products so customer-facing prices only move when somebody publishes them. Products with no fresh cost are unpublished.';

-- EXECUTE is granted to PUBLIC by Postgres and to anon by Supabase's default
-- privileges, so both have to go for the storefront's role to lose access. The staff pricing view
-- runs with security_invoker, so `authenticated` needs these back.
revoke all on function public.hw_landed_cost_cents(integer,integer,text,text,numeric) from public, anon;
revoke all on function public.hw_best_offer(uuid) from public, anon;
revoke all on function public.hw_suggested_price_cents(uuid) from public, anon;
revoke all on function public.hw_publish_prices(uuid[]) from public, anon;

grant execute on function public.hw_best_offer(uuid) to authenticated, service_role;
grant execute on function public.hw_suggested_price_cents(uuid) to authenticated, service_role;
grant execute on function public.hw_publish_prices(uuid[]) to authenticated, service_role;

-- 5. Staff pricing view -------------------------------------------------------
-- security_invoker so the staff RLS policy on hardware_products still applies;
-- the functions it calls are definer because they read the cost table, which
-- has no policy for anyone but staff.
create or replace view public.hardware_pricing_admin
with (security_invoker = on) as
select p.id,
       p.sku,
       p.name,
       p.category,
       p.sort_order,
       p.pricing_mode,
       p.markup_pct,
       p.min_margin_cents,
       p.price_override_cents,
       p.lead_time_days,
       p.is_published,
       p.published_price_cents,
       p.published_currency,
       p.published_cost_cents,
       p.published_vendor_code,
       p.published_availability,
       p.published_at,
       b.vendor_code       as best_vendor_code,
       b.vendor_sku        as best_vendor_sku,
       b.cost_cents        as best_cost_cents,
       b.cost_currency     as best_cost_currency,
       b.landed_cost_cents as best_landed_cost_cents,
       b.availability      as best_availability,
       b.stock_qty         as best_stock_qty,
       b.quoted_at         as best_quoted_at,
       public.hw_suggested_price_cents(p.id) as suggested_price_cents
from public.hardware_products p
left join lateral public.hw_best_offer(p.id) b on true;

comment on view public.hardware_pricing_admin is
  'Staff pricing screen: current published price beside the live cheapest-vendor suggestion.';

revoke all on public.hardware_pricing_admin from anon;
grant select on public.hardware_pricing_admin to authenticated;

-- 6. Customer catalog view ----------------------------------------------------
-- Deliberately a narrow projection: even if someone later adds an anon SELECT
-- policy covering more columns, this is the shape the storefront reads.
create or replace view public.hardware_catalog
with (security_invoker = on) as
select p.id,
       p.sku,
       p.name,
       p.category,
       p.short_description,
       p.long_description,
       p.image_url,
       p.spec,
       p.sort_order,
       p.published_price_cents as price_cents,
       p.published_currency    as currency,
       p.lead_time_days,
       case p.published_availability
         when 'in_stock'  then 'In stock'
         when 'low_stock' then 'Limited stock'
         when 'backorder' then 'On backorder'
         else 'Call to confirm'
       end as availability_label,
       p.published_availability in ('in_stock','low_stock') as ships_now
from public.hardware_products p
where p.is_published;

comment on view public.hardware_catalog is
  'Public storefront projection. No cost, no markup, no vendor.';

grant select on public.hardware_catalog to anon, authenticated;
