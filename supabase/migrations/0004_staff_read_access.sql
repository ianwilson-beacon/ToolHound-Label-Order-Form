-- Internal read access for staff, via Supabase Auth.
--
-- The public form is anon-insert-only with no public SELECT policy (see
-- 0001/0002). Staff need to browse submitted orders without a service-role
-- key ever touching client code, so this grants SELECT to `authenticated`
-- only — i.e. to a signed-in Supabase Auth user. There is no public sign-up:
-- staff accounts are created by an admin in the Supabase dashboard
-- (Authentication -> Users -> Add user), so "authenticated" here means
-- "a staff member who was given a login," not "anyone."
--
-- INSERT/UPDATE/DELETE remain revoked for authenticated (see 0002) — this is
-- read-only access for the internal orders view.

grant select on public.label_orders to authenticated;

drop policy if exists "staff can view orders" on public.label_orders;
create policy "staff can view orders"
  on public.label_orders
  for select
  to authenticated
  using (true);
