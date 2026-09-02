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
-- auth, which issues JWTs without creating auth.users rows, which is how the
-- dashboard signs in now.
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

  -- Anchored on '@' and on end-of-string, so neither `nottoolhound.com` nor
  -- `toolhound.com.attacker.example` matches, and neither does a subdomain.
  return coalesce(email ~ '@(beaconsoftware\.com|toolhound\.com)$', false);
end;
$$;

comment on function public.is_label_order_staff() is
  'True when the verified JWT carries a Beacon or ToolHound email address. The security boundary for the internal orders dashboard — any client-side domain check is user experience only. Reads the standard `email` claim, which both Supabase Auth and a Clerk session token (with email added to the session token) provide.';

grant execute on function public.is_label_order_staff() to authenticated;

drop policy if exists "staff can view orders" on public.label_orders;
create policy "staff can view orders"
  on public.label_orders
  for select
  to authenticated
  using (public.is_label_order_staff());
