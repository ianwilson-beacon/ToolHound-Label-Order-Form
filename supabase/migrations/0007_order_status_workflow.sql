-- Order workflow status: the staff-facing pipeline for a submitted order.
--
-- Two additions, and one thing deliberately left alone:
--
--   1. A status pipeline on public.label_orders, so staff can track an order
--      from received through PO sent, production confirmed, and shipped. Each
--      stage gets its own timestamp rather than only a current-status field:
--      that is what makes cycle time ("how long from received to PO sent")
--      answerable later, not just "how long outstanding".
--
--   2. A narrow UPDATE grant for the `authenticated` role, gated on the same
--      staff predicate 0006 uses for reads.
--
--   3. The `anon` INSERT policy from 0001 stays exactly as it is. The public
--      order form at the Vercel URL submits with the anon publishable key, so
--      revoking anon here would take the customer-facing form offline. This
--      project is not a candidate for an anon lockdown.

-- Workflow columns -------------------------------------------------------
alter table public.label_orders
  add column if not exists status                  text not null default 'received',
  add column if not exists po_sent_at              timestamptz,
  add column if not exists production_confirmed_at timestamptz,
  add column if not exists shipped_at              timestamptz,
  add column if not exists cancelled_at            timestamptz,
  add column if not exists internal_notes          text,
  add column if not exists updated_at              timestamptz;

-- updated_at arrives nullable, is backfilled, and only then becomes NOT NULL.
-- Adding it as `not null default now()` in one step would stamp every order
-- that already existed as edited at migration time, which is a claim about
-- those orders that is not true — and the column exists precisely to answer
-- "when did this last change". Written this way the backfill is also
-- re-runnable: a second pass finds no NULLs and touches nothing.
update public.label_orders
   set updated_at = submitted_at
 where updated_at is null;

alter table public.label_orders
  alter column updated_at set default now(),
  alter column updated_at set not null;

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

-- Stage timestamps are derived, never submitted --------------------------
-- Staff are granted UPDATE on `status` and `internal_notes` only (see the
-- grants at the end of this file), so the stage timestamps cannot be set or backdated through
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

-- Staff write access ---------------------------------------------------------
-- Scoped to this one table on purpose, and gated on the same staff predicate
-- 0006 uses for reads. A blanket "authenticated full access on every table"
-- policy would make every signed-in session, from any sign-up path, an
-- administrator of this database.

drop policy if exists "staff update order status" on public.label_orders;
create policy "staff update order status"
  on public.label_orders
  for update
  to authenticated
  using (public.is_label_order_staff())
  with check (public.is_label_order_staff());

grant execute on function public.label_orders_status_rank(text) to authenticated;

-- 0002 revoked these; 0004 restored SELECT. Column-level UPDATE is what keeps a
-- signed-in user from rewriting the customer's own order details, their drawn
-- signature, or a stage timestamp.
grant select on public.label_orders to authenticated;
grant update (status, internal_notes) on public.label_orders to authenticated;

-- Still no INSERT and no DELETE for authenticated: orders arrive only from the
-- customer form, and an order that was filed is a record, not a draft.
revoke insert, delete on public.label_orders from authenticated;

-- Dashboard read patterns ----------------------------------------------------
create index if not exists label_orders_status_idx
  on public.label_orders (status, submitted_at desc);

-- The dashboard's default view: everything not yet shipped or cancelled,
-- oldest first, because age is the thing that matters about an open order.
create index if not exists label_orders_open_idx
  on public.label_orders (submitted_at)
  where status not in ('shipped','cancelled');
