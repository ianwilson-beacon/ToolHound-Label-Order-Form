-- Hardware drop-ship portal — customer orders.
--
-- Same threat model as the label form: the storefront submits directly from the
-- browser with the anon publishable key, so anything the browser sends can be
-- forged. The one thing that absolutely must not be forgeable is price, so the
-- client's line prices are discarded and re-read from the published catalog by
-- a trigger. The browser gets to say *what* and *how many*, never *how much*.

create table if not exists public.hardware_orders (
  -- The client generates this id so it can insert line items in the same
  -- round trip without needing SELECT on this table (anon has none).
  id              uuid primary key default gen_random_uuid(),
  order_ref       text not null unique,
  submitted_at    timestamptz not null default now(),

  company_name    text not null,
  contact_name    text not null,
  contact_email   text not null,
  contact_phone   text,

  address         text not null,
  city            text not null,
  state_province  text not null,
  postal_code     text not null,
  country         text not null,

  po_number       text,
  notes           text,

  authorized_name text not null,
  approval_date   date not null,

  status          text not null default 'new'
                    check (status in ('new','quoted','ordered','shipped','cancelled')),
  vendor_po_ref   text,

  synced_to_dashboard_at timestamptz,
  created_at      timestamptz not null default now(),

  constraint hardware_orders_text_lengths check (
    length(order_ref) between 6 and 40
    and length(company_name) between 1 and 200
    and length(contact_name) between 1 and 200
    and length(contact_email) between 3 and 320
    and (contact_phone is null or length(contact_phone) <= 40)
    and length(address) between 1 and 300
    and length(city) between 1 and 120
    and length(state_province) between 1 and 120
    and length(postal_code) between 1 and 32
    and length(country) between 1 and 120
    and (po_number is null or length(po_number) <= 64)
    and (notes is null or length(notes) <= 2000)
    and length(authorized_name) between 1 and 200
  ),
  constraint hardware_orders_email_shape check (
    contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint hardware_orders_approval_date_sane check (
    approval_date between date '2020-01-01' and date '2100-01-01'
  )
);

comment on table public.hardware_orders is
  'Customer hardware orders from the public portal. Line items and prices live in hardware_order_items.';

create index if not exists hardware_orders_submitted_at_idx
  on public.hardware_orders (submitted_at desc);
create index if not exists hardware_orders_pending_sync_idx
  on public.hardware_orders (submitted_at)
  where synced_to_dashboard_at is null;

create table if not exists public.hardware_order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.hardware_orders(id) on delete cascade,
  product_id       uuid not null references public.hardware_products(id),
  -- Written by the trigger below, not by the client.
  sku              text not null,
  name             text not null,
  quantity         integer not null check (quantity > 0 and quantity <= 10000),
  unit_price_cents integer not null check (unit_price_cents > 0),
  currency         text not null check (currency in ('CAD','USD')),
  created_at       timestamptz not null default now(),
  unique (order_id, product_id)
);

comment on column public.hardware_order_items.unit_price_cents is
  'Snapshot of the published price at submission, set server-side by hardware_order_items_price(). Client-supplied values are ignored.';

create index if not exists hardware_order_items_order_idx
  on public.hardware_order_items (order_id);

-- Price and product details are re-derived from the catalog on every insert
-- and update. A crafted request asking for a $3,000 scanner at $1 gets the
-- $3,000, and an unpublished product is refused outright.
create or replace function public.hardware_order_items_price()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.hardware_products;
begin
  select * into p from public.hardware_products where id = new.product_id;

  if p.id is null or not p.is_published or p.published_price_cents is null then
    raise exception 'product % is not available for ordering', new.product_id
      using errcode = 'check_violation';
  end if;

  new.sku              := p.sku;
  new.name             := p.name;
  new.unit_price_cents := p.published_price_cents;
  new.currency         := p.published_currency;
  return new;
end;
$$;

drop trigger if exists hardware_order_items_price_trg on public.hardware_order_items;
create trigger hardware_order_items_price_trg
  before insert or update on public.hardware_order_items
  for each row execute function public.hardware_order_items_price();

-- Line items may only be attached to an order that was just created. Anon has
-- no SELECT on hardware_orders, so the policy consults it through this.
create or replace function public.hw_order_is_open(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.hardware_orders o
    where o.id = p_order_id
      and o.submitted_at > now() - interval '30 minutes'
  );
$$;

-- The repricing trigger runs as the table owner; nobody needs to call it, and
-- hw_order_is_open exists only to be consulted by the anon insert policy.
revoke all on function public.hardware_order_items_price() from public, anon, authenticated;
revoke all on function public.hw_order_is_open(uuid) from public;
grant execute on function public.hw_order_is_open(uuid) to anon, authenticated;

alter table public.hardware_orders      enable row level security;
alter table public.hardware_order_items enable row level security;

-- Public portal: submit only. There is deliberately no SELECT policy for anon,
-- so the anon key can file an order but cannot read anyone's order back.
drop policy if exists "anon submits hardware orders" on public.hardware_orders;
create policy "anon submits hardware orders"
  on public.hardware_orders for insert to anon
  with check (true);

drop policy if exists "anon submits hardware order items" on public.hardware_order_items;
create policy "anon submits hardware order items"
  on public.hardware_order_items for insert to anon
  with check (public.hw_order_is_open(order_id));

drop policy if exists "staff manage hardware orders" on public.hardware_orders;
create policy "staff manage hardware orders"
  on public.hardware_orders for all to authenticated
  using (public.hw_is_staff()) with check (public.hw_is_staff());

drop policy if exists "staff manage hardware order items" on public.hardware_order_items;
create policy "staff manage hardware order items"
  on public.hardware_order_items for all to authenticated
  using (public.hw_is_staff()) with check (public.hw_is_staff());

-- Column-level insert grants, not a table-wide one. The storefront supplies
-- the customer's own details and nothing else: `status`, `vendor_po_ref` and
-- `synced_to_dashboard_at` are ours to set, and a table-wide grant would let a
-- crafted request file an order already marked shipped.
revoke all on public.hardware_orders      from anon;
revoke all on public.hardware_order_items from anon;

grant insert (
  id, order_ref, company_name, contact_name, contact_email, contact_phone,
  address, city, state_province, postal_code, country, po_number, notes,
  authorized_name, approval_date
) on public.hardware_orders to anon;

-- sku, name, unit_price_cents and currency are accepted so the browser can
-- send what it displayed, then overwritten by the trigger above.
grant insert (
  order_id, product_id, sku, name, quantity, unit_price_cents, currency
) on public.hardware_order_items to anon;

-- Staff order view: the line items rolled up, so nobody has to sum by hand.
create or replace view public.hardware_orders_admin
with (security_invoker = on) as
select o.*,
       (select count(*) from public.hardware_order_items i where i.order_id = o.id)
         as line_count,
       (select coalesce(sum(i.quantity), 0) from public.hardware_order_items i
         where i.order_id = o.id) as unit_count,
       (select coalesce(sum(i.quantity * i.unit_price_cents), 0)
          from public.hardware_order_items i where i.order_id = o.id)
         as subtotal_cents,
       (select coalesce(sum(i.quantity * p.published_cost_cents), 0)
          from public.hardware_order_items i
          join public.hardware_products p on p.id = i.product_id
         where i.order_id = o.id) as est_cost_cents
from public.hardware_orders o;

comment on view public.hardware_orders_admin is
  'Staff order list with line counts, subtotal, and estimated distributor cost at time of publish.';

revoke all on public.hardware_orders_admin from anon;
grant select on public.hardware_orders_admin to authenticated;
