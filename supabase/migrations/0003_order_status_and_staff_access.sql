-- Order workflow status + staff (Beacon / ToolHound) read-write access.
--
-- Two additions, and one thing deliberately left alone:
--
--   1. A status pipeline on public.label_orders, so staff can track an order
--      from received through PO sent, production confirmed, and shipped. Each
--      stage gets its own timestamp rather than only a current-status field:
--      that is what makes cycle time ("how long from received to PO sent")
--      answerable later, not just "how long outstanding".
--
--   2. SELECT and a narrow UPDATE for the `authenticated` role, gated on the
--      caller's email domain. Authentication is Clerk SSO handing a JWT to
--      Supabase; the domain check lives here, in SQL, because the client-side
--      gate in the dashboard only decides what renders and does not stop
--      anyone from calling the REST API with a valid token of their own.
--
--   3. The `anon` INSERT policy from 0001 stays exactly as it is. The public
--      order form at the Vercel URL submits with the anon publishable key, so
--      revoking anon here would take the customer-facing form offline. This
--      project is not a candidate for an anon lockdown.

-- 1. Workflow columns -------------------------------------------------------
alter table public.label_orders
  add column if not exists status                  text not null default 'received',
  add column if not exists po_sent_at              timestamptz,
  add column if not exists production_confirmed_at timestamptz,
  add column if not exists shipped_at              timestamptz,
  add column if not exists cancelled_at            timestamptz,
  add column if not exists internal_notes          text,
  add column if not exists updated_at              timestamptz not null default now();

comment on column public.label_orders.status is
  'Workflow stage: received -> po_sent -> production_confirmed -> shipped, plus cancelled. Maintained by staff through the internal dashboard.';
comment on column public.label_orders.internal_notes is
  'Staff-only working notes. Never shown to the customer.';

alter table public.label_orders drop constraint if exists label_orders_status_valid;
alter table public.label_orders drop constraint if exists label_orders_internal_notes_length;

alter table public.label_orders
  add constraint label_orders_status_valid
    check (status in ('received','po_sent','production_confirmed','shipped','cancelled')),

  -- Same reasoning as the 0002 length caps: keep a free-text field from being
  -- used as bulk storage.
  add constraint label_orders_internal_notes_length
    check (internal_notes is null or length(internal_notes) <= 4000);

-- 2. Stage timestamps are derived, never submitted --------------------------
-- Staff are granted UPDATE on `status` and `internal_notes` only (see the
-- grants below), so the stage timestamps cannot be set or backdated through
-- the API at all — this trigger is the only thing that writes them. That also
-- means the dashboard sends a status change and nothing else.

create or replace function public.label_orders_status_rank(s text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case s
    when 'received'              then 0
    when 'po_sent'               then 1
    when 'production_confirmed'  then 2
    when 'shipped'               then 3
    else null                    -- 'cancelled' sits outside the pipeline
  end;
$$;

create or replace function public.label_orders_apply_status()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_rank integer;
begin
  new.updated_at := now();

  if new.status = 'cancelled' then
    new.cancelled_at := coalesce(old.cancelled_at, now());
    return new;
  end if;

  new.cancelled_at := null;
  new_rank := public.label_orders_status_rank(new.status);

  -- Stamp the stage being entered, keeping an existing stamp if the order is
  -- re-saved at the same status.
  if new.status = 'po_sent' then
    new.po_sent_at := coalesce(old.po_sent_at, now());
  elsif new.status = 'production_confirmed' then
    new.production_confirmed_at := coalesce(old.production_confirmed_at, now());
  elsif new.status = 'shipped' then
    new.shipped_at := coalesce(old.shipped_at, now());
  end if;

  -- Moving an order backwards (a mis-click being corrected) clears the stamps
  -- for the stages it has given up, so the timestamps never claim a milestone
  -- the order has not reached.
  if new_rank < 3 then new.shipped_at := null; end if;
  if new_rank < 2 then new.production_confirmed_at := null; end if;
  if new_rank < 1 then new.po_sent_at := null; end if;

  return new;
end;
$$;

drop trigger if exists label_orders_apply_status on public.label_orders;
create trigger label_orders_apply_status
  before update on public.label_orders
  for each row execute function public.label_orders_apply_status();

-- A new order is always 'received' with no milestones behind it. The public
-- form submits with a table-level INSERT grant, which covers every column, so
-- without this an author-crafted request could file an order pre-marked as
-- shipped.
create or replace function public.label_orders_force_new_defaults()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.status                  := 'received';
  new.po_sent_at              := null;
  new.production_confirmed_at := null;
  new.shipped_at              := null;
  new.cancelled_at            := null;
  new.internal_notes          := null;
  new.updated_at              := now();
  return new;
end;
$$;

drop trigger if exists label_orders_force_new_defaults on public.label_orders;
create trigger label_orders_force_new_defaults
  before insert on public.label_orders
  for each row execute function public.label_orders_force_new_defaults();

-- 3. Who counts as staff ----------------------------------------------------
-- Reads the email claim out of the verified JWT. Requests carrying the anon
-- key have no claims and no email, so this is false for the public form.
--
-- Clerk's native Supabase integration puts `role: authenticated` in the
-- session token but does not necessarily include the email address. Add it
-- through Clerk's session-token customization:
--
--     { "email": "{{user.primary_email_address}}" }
--
-- If the claim is missing this function returns false and the dashboard shows
-- no orders — a silent empty table is the expected symptom of that
-- misconfiguration, so decode a live token before assuming the data is gone.

create or replace function public.is_label_order_staff()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb;
  email  text;
begin
  -- plpgsql rather than sql for the exception block. A cast failure here would
  -- otherwise raise out of the RLS policy and fail the whole query, which is a
  -- worse outcome than denying access: an error is noisy and confusing where a
  -- false is simply "not staff".
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    return false;
  end;

  if claims is null or jsonb_typeof(claims) <> 'object' then
    return false;
  end if;

  email := lower(coalesce(
    claims ->> 'email',
    claims ->> 'email_address',
    claims ->> 'primary_email_address'
  ));

  -- Anchored on '@' and on end-of-string, so neither `nottoolhound.com` nor
  -- `toolhound.com.attacker.example` matches, and neither does a subdomain.
  return coalesce(email ~ '@(beaconsoftware\.com|toolhound\.com)$', false);
end;
$$;

comment on function public.is_label_order_staff() is
  'True when the verified JWT carries a Beacon or ToolHound email address. The security boundary for the internal orders dashboard — the client-side domain check is user experience only.';

grant execute on function public.is_label_order_staff() to authenticated;
grant execute on function public.label_orders_status_rank(text) to authenticated;

-- 4. Staff policies and grants ----------------------------------------------
-- Scoped to this one table on purpose. A blanket "authenticated full access on
-- every table" policy would hand every user of every app sharing this Clerk
-- instance the run of the database.

drop policy if exists "staff read orders" on public.label_orders;
create policy "staff read orders"
  on public.label_orders
  for select
  to authenticated
  using (public.is_label_order_staff());

drop policy if exists "staff update order status" on public.label_orders;
create policy "staff update order status"
  on public.label_orders
  for update
  to authenticated
  using (public.is_label_order_staff())
  with check (public.is_label_order_staff());

-- 0002 revoked these; restore only what the dashboard needs. Column-level
-- UPDATE is what keeps a signed-in user from rewriting the customer's own
-- order details or forging a stage timestamp.
grant select on public.label_orders to authenticated;
grant update (status, internal_notes) on public.label_orders to authenticated;

-- Still no INSERT and no DELETE for authenticated: orders arrive only from the
-- customer form, and an order that was filed is a record, not a draft.
revoke insert, delete on public.label_orders from authenticated;

-- 5. Dashboard read patterns -------------------------------------------------
create index if not exists label_orders_status_idx
  on public.label_orders (status, submitted_at desc);

-- The dashboard's default view: everything not yet shipped or cancelled,
-- oldest first, because age is the thing that matters about an open order.
create index if not exists label_orders_open_idx
  on public.label_orders (submitted_at)
  where status not in ('shipped','cancelled');
