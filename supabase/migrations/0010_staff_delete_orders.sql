-- Let staff delete an order from the dashboard.
--
-- Until now nothing could delete a row: 0002 revoked DELETE from both anon and
-- authenticated, and no policy granted it. That was the right default while the
-- dashboard was read-plus-status-only, but it also meant test submissions and
-- duplicate orders accumulated with no way to clear them except a SQL console.
--
-- This is a hard delete, not an archive flag. An archive would keep the signed
-- authorization recoverable, which is the safer design for a legal record --
-- but it also needs a filter on every read, a way to see the archive, and a way
-- to purge it eventually. Deleting is what was asked for; the dashboard puts a
-- two-step confirmation in front of it, and that is the only thing standing
-- between a click and a gone authorization. Worth revisiting if a real order is
-- ever lost this way.
--
-- Gated on the same staff predicate 0006 uses for reads, so this is not a
-- capability every authenticated session gets -- only a signed-in
-- beaconsoftware.com address.

grant delete on public.label_orders to authenticated;

drop policy if exists "staff delete orders" on public.label_orders;
create policy "staff delete orders"
  on public.label_orders
  for delete
  to authenticated
  using (public.is_label_order_staff());
