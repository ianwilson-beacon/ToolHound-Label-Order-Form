-- ToolHound Label Orders — base schema.
--
-- Captures customer-submitted custom label order authorizations from the
-- public form. This project is intentionally isolated from ToolHound OS;
-- synced_to_dashboard_at is reserved for a future one-way mirror job.

create table if not exists public.label_orders (
  id                     uuid primary key default gen_random_uuid(),
  order_ref              text not null unique,
  submitted_at           timestamptz not null default now(),

  -- Customer & shipping
  company_name           text not null,
  contact_name           text not null,
  contact_email          text not null,
  address                text not null,
  city                   text not null,
  state_province         text not null,
  postal_code            text not null,
  country                text not null,

  -- Label specifications
  logo_choice            text not null
                           check (logo_choice in ('custom_logo','custom_text','toolhound_logo')),
  logo_file_name         text,
  logo_file_data         text,
  text_lines             jsonb,
  full_color             text not null check (full_color in ('Yes','No')),
  quantity               integer not null,
  start_seq              integer not null,
  instructions           text,

  -- Authorization
  authorized_name        text not null,
  approval_date          date not null,

  synced_to_dashboard_at timestamptz,
  created_at             timestamptz not null default now()
);

comment on table public.label_orders is
  'Customer-submitted label order authorizations from the public Vercel form. Isolated project — no connection to ToolHound OS. synced_to_dashboard_at is reserved for a future one-way mirror job.';

alter table public.label_orders enable row level security;

-- The form submits with the anon publishable key. Insert is the only
-- capability granted to the public: there is deliberately no SELECT policy,
-- so submitted orders cannot be read back with the anon key. Staff read
-- orders via the Supabase dashboard or the service role.
drop policy if exists "anon can submit orders" on public.label_orders;
create policy "anon can submit orders"
  on public.label_orders
  for insert
  to anon
  with check (true);
