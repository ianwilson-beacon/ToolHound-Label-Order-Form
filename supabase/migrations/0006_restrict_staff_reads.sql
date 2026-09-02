-- Replace the unrestricted staff SELECT policy with a domain-checked one.
--
-- 0004 granted SELECT to `authenticated` with `using (true)`, on the reasoning
-- that there is no public sign-up so "authenticated" means "a staff member who
-- was given a login". That holds only while every sign-up path is closed. The
-- domain restriction from 0005 is a BEFORE INSERT trigger on auth.users that
-- raises only for provider 'google' off beaconsoftware.com and provider
-- 'azure' off toolhound.com — every other provider falls through unrestricted,
-- so an enabled email sign-up (Supabase's default) would grant a self-service
-- account the run of the table. It also does not apply at all to third-party
-- auth, and it says nothing about the magic-link sign-in the dashboard offers,
-- which creates an auth.users row through a provider the trigger ignores.
--
-- So the domain check moves into the policy, where it is evaluated on every
-- request regardless of how the session was minted. 0005's trigger stays as a
-- second line of defense in case a Supabase Auth provider is ever re-enabled.

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
  -- plpgsql rather than sql for the exception block. A cast failure would
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

  -- Anchored on '@' and on end-of-string, so neither `notbeaconsoftware.com`
  -- nor `beaconsoftware.com.attacker.example` matches, and neither does a
  -- subdomain.
  --
  -- Beacon addresses only. ToolHound addresses were in this list earlier and
  -- were deliberately removed: note that the order notification still goes to
  -- sales@toolhound.com, so whoever reads that inbox needs a Beacon account to
  -- open the dashboard link it contains.
  return coalesce(email ~ '@beaconsoftware\.com$', false);
end;
$$;

comment on function public.is_label_order_staff() is
  'True when the verified JWT carries a Beacon email address. The security boundary for the internal orders dashboard — any client-side domain check is user experience only. Reads the standard `email` claim, which Supabase Auth access tokens carry natively (it is what auth.email() reads).';

grant execute on function public.is_label_order_staff() to authenticated;

drop policy if exists "staff can view orders" on public.label_orders;
create policy "staff can view orders"
  on public.label_orders
  for select
  to authenticated
  using (public.is_label_order_staff());
