-- Hardening pass for public.label_orders.
--
-- The form submits directly from the browser with the anon publishable key,
-- so the INSERT policy's `with check (true)` is reachable by anyone who reads
-- the page source. That is expected for a public order form, but it means the
-- client-side validation rules must also be enforced in the database — a
-- hand-crafted request bypasses the browser entirely. Everything below either
-- narrows what anon may do or bounds what it may store.

-- 1. Least privilege ---------------------------------------------------------
-- RLS already blocks SELECT/UPDATE/DELETE for anon (no policy grants them),
-- but the table-level grants are broader than needed. Revoke them so the
-- table is safe even if a policy is later added by mistake.
revoke select, update, delete, truncate, references, trigger
  on public.label_orders from anon;
revoke select, update, delete, truncate, references, trigger
  on public.label_orders from authenticated;
revoke insert on public.label_orders from authenticated;

-- 2. Bounded, well-formed submissions ----------------------------------------
create or replace function public.label_text_lines_valid(lines jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lines is null or (
    jsonb_typeof(lines) = 'array'
    and jsonb_array_length(lines) <= 3
    and (
      select coalesce(bool_and(length(v) <= 10), true)
      from jsonb_array_elements_text(lines) v
    )
  );
$$;

comment on function public.label_text_lines_valid(jsonb) is
  'Mirrors the form rule: at most three custom text lines, each at most 10 characters.';

alter table public.label_orders
  -- Quantities must be real. Without this, `quantity` accepts 0 and negatives.
  add constraint label_orders_quantity_positive
    check (quantity > 0 and quantity <= 1000000),

  add constraint label_orders_start_seq_nonneg
    check (start_seq >= 0 and start_seq <= 2000000000),

  -- Keep free-text fields from being used as bulk storage.
  add constraint label_orders_text_lengths
    check (
      length(company_name)    between 1 and 200
      and length(contact_name)   between 1 and 200
      and length(contact_email)  between 3 and 320
      and length(address)        between 1 and 300
      and length(city)           between 1 and 120
      and length(state_province) between 1 and 120
      and length(postal_code)    between 1 and 32
      and length(country)        between 1 and 120
      and length(authorized_name) between 1 and 200
      and (instructions is null or length(instructions) <= 2000)
      and (logo_file_name is null or length(logo_file_name) <= 260)
    ),

  add constraint label_orders_email_shape
    check (contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  add constraint label_orders_text_lines_valid
    check (public.label_text_lines_valid(text_lines)),

  -- A custom logo order is meaningless without the artwork attached.
  add constraint label_orders_custom_logo_has_file
    check (logo_choice <> 'custom_logo' or logo_file_name is not null),

  -- Only the artwork types the form offers, and no more than ~4MB of base64
  -- (a 4MB binary file encodes to roughly 5.6MB of text).
  add constraint label_orders_logo_data_shape
    check (
      logo_file_data is null or (
        length(logo_file_data) <= 6000000
        and logo_file_data ~ '^data:(image/(png|jpeg|jpg|svg\+xml)|application/pdf);base64,'
      )
    ),

  -- Guard against clock-skewed or backdated authorizations.
  add constraint label_orders_approval_date_sane
    check (approval_date between date '2020-01-01' and date '2100-01-01');

-- 3. Staff read patterns -----------------------------------------------------
create index if not exists label_orders_submitted_at_idx
  on public.label_orders (submitted_at desc);

create index if not exists label_orders_pending_sync_idx
  on public.label_orders (submitted_at)
  where synced_to_dashboard_at is null;
