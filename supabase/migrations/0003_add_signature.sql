-- Add a drawn-signature capture to the authorization step.
--
-- The column is nullable at the database level even though the form makes it
-- required client-side: existing rows submitted before this feature have no
-- signature, and a NOT NULL constraint would be retroactively unsatisfiable
-- for them. The shape check still bounds what a well-formed value looks like.

alter table public.label_orders
  add column if not exists signature_data text;

comment on column public.label_orders.signature_data is
  'Base64 PNG data URL of the customer''s drawn signature, captured on step 4. Nullable only for orders submitted before this column existed.';

-- Dropped first so this file can be replayed onto a database that already has
-- it; `add constraint` has no IF NOT EXISTS.
alter table public.label_orders
  drop constraint if exists label_orders_signature_shape;

alter table public.label_orders
  add constraint label_orders_signature_shape
    check (
      signature_data is null or (
        length(signature_data) <= 2000000
        and signature_data ~ '^data:image/png;base64,'
      )
    );
