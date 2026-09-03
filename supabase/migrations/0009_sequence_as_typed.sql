-- Store the label sequence as the string the customer types.
--
-- The signed Label Order Acknowledgement governs the sequence, and it does not
-- describe one the way this schema did. Shaw's ran `Start: TSG-0001` /
-- `End: TSG-0500`, PCL Nisku's `1515000` / `1519999`, Millstone's `10000` /
-- `14999`. The form caps the whole thing at 8 or 9 characters depending on the
-- variant, and PCL's adds "if intending to use phones as primary scanning
-- device, 7 digits or less is recommended".
--
-- The previous model -- a text prefix plus an integer -- cannot express any of
-- that faithfully. `TSG-` + 1 renders `TSG1`, losing the zero padding, and the
-- vendor prints the description literally, so `TSG1` is simply the wrong label.
--
-- So the sequence becomes one string, stored exactly as typed. The end of the
-- range is still derived rather than asked for twice: take the trailing run of
-- digits, add quantity - 1, and re-pad to the same width. TSG-0001 over 500
-- labels gives TSG-0500; 10000 over 5000 gives 14999.

alter table public.label_orders
  add column if not exists seq_start text;

comment on column public.label_orders.seq_start is
  'The starting label number exactly as the customer typed it, e.g. TSG-0001 or 1515000. The end of the range is derived by incrementing the trailing digits and re-padding to the same width. Governed by the signed acknowledgement form.';

-- Carry the old prefix + integer pair forward. Concatenation is right for the
-- rows that exist: none of them carried a prefix, and an unpadded integer is
-- what they meant.
-- Guarded on the column still being there, because this migration drops
-- seq_prefix further down: an unguarded backfill fails on a second run.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'label_orders'
       and column_name = 'seq_prefix'
  ) then
    execute $sql$
      update public.label_orders
         set seq_start = coalesce(seq_prefix, '') || start_seq::text
       where seq_start is null
         and start_seq is not null
    $sql$;
  else
    update public.label_orders
       set seq_start = start_seq::text
     where seq_start is null
       and start_seq is not null;
  end if;
end $$;

-- start_seq stays for the history it already holds, but new submissions send
-- seq_start instead, so it can no longer be required.
alter table public.label_orders
  alter column start_seq drop not null;

comment on column public.label_orders.start_seq is
  'Legacy numeric start, superseded by seq_start. Retained for orders submitted before the sequence became a string; the form no longer writes it.';

-- seq_prefix existed for one day and never held production data. Folding it
-- into seq_start leaves one source of truth rather than two that can disagree.
alter table public.label_orders drop constraint if exists label_orders_seq_prefix_shape;
alter table public.label_orders drop column if exists seq_prefix;

alter table public.label_orders drop constraint if exists label_orders_seq_start_shape;
alter table public.label_orders
  add constraint label_orders_seq_start_shape
    check (
      seq_start is null or (
        -- Nine characters is the most permissive of the acknowledgement form
        -- variants; alphanumerics and hyphens are what a printed asset tag can
        -- carry.
        seq_start ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,8}$'
        -- It has to end in digits, because that is what gets incremented to
        -- reach the end of the range. A sequence with no number in it cannot
        -- describe a range at all.
        and seq_start ~ '[0-9]$'
      )
    );

-- start_seq lost its NOT NULL above, so without this a row could carry no
-- sequence at all and still insert. Either column satisfies it: the current
-- form writes seq_start, and a frontend still running the old code writes
-- start_seq, so this migration can land before the deploy without breaking
-- submissions in the window between them.
alter table public.label_orders drop constraint if exists label_orders_has_a_sequence;
alter table public.label_orders
  add constraint label_orders_has_a_sequence
    check (seq_start is not null or start_seq is not null);
