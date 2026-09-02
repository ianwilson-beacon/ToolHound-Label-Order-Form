-- Fields the customer can answer that the Metalcraft PO needs.
--
-- Building a vendor PO from a web submission left four values to be typed in
-- by hand every time. Three of them are things only the customer knows, so
-- asking once on the form is strictly better than looking them up later:
--
--   * label size      -- needed in every line description; only two sizes have
--                        ever been ordered, so the form offers those two
--   * sequence prefix -- real orders have run VOL6001-VOL9000, which a plain
--                        integer start_seq cannot express at all
--   * customer PO     -- goes into the PO's Memo to Supplier
--
-- Plus two that make the drop-shipment land: a phone for the ship-to contact,
-- and the name of whoever receives it, which is often not the person ordering.
--
-- The fourth value, Metalcraft's cost per label, is deliberately NOT here.
-- It is quoted per order and belongs to the vendor thread; putting supplier
-- pricing on a customer-facing form would be a mistake of a different kind.
--
-- All nullable: orders submitted before this migration have none of it, and a
-- NOT NULL column would be retroactively unsatisfiable for them.

alter table public.label_orders
  add column if not exists label_width_in  numeric(5,2),
  add column if not exists label_height_in numeric(5,2),
  add column if not exists seq_prefix      text,
  add column if not exists customer_po     text,
  add column if not exists ship_to_phone   text,
  add column if not exists attention_name  text;

comment on column public.label_orders.label_width_in is
  'Label width in inches. 1.50 x 0.75 and 1.25 x 0.50 are the only sizes ordered historically; the form offers those two plus a free entry.';
comment on column public.label_orders.seq_prefix is
  'Optional alphanumeric prefix on the label sequence, e.g. VOL for VOL6001-VOL9000. The numeric part stays in start_seq so the end of the range is still computable.';
comment on column public.label_orders.customer_po is
  'The customer''s own PO number, for the vendor PO memo. Optional -- not every customer issues one.';
comment on column public.label_orders.attention_name is
  'Who receives the shipment at the delivery address, when that is not the ordering contact.';

alter table public.label_orders drop constraint if exists label_orders_label_size_sane;
alter table public.label_orders drop constraint if exists label_orders_seq_prefix_shape;
alter table public.label_orders drop constraint if exists label_orders_po_field_lengths;

alter table public.label_orders
  -- A label is inches, not feet. Bounding this keeps a fat-fingered entry from
  -- reaching the vendor as a plausible-looking spec.
  add constraint label_orders_label_size_sane
    check (
      (label_width_in  is null or (label_width_in  > 0 and label_width_in  <= 12))
      and (label_height_in is null or (label_height_in > 0 and label_height_in <= 12))
    ),

  -- The prefix is concatenated straight onto the sequence number in the line
  -- description the vendor reads, so it stays to characters that can appear on
  -- a printed asset tag. No spaces, no punctuation beyond a hyphen.
  add constraint label_orders_seq_prefix_shape
    check (seq_prefix is null or seq_prefix ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,11}$'),

  -- Same reasoning as the 0002 length caps: bound what a single row can hold.
  add constraint label_orders_po_field_lengths
    check (
      (customer_po    is null or length(customer_po)    between 1 and 64)
      and (ship_to_phone  is null or length(ship_to_phone)  between 1 and 32)
      and (attention_name is null or length(attention_name) between 1 and 200)
    );
