-- Restrict Google/Microsoft sign-in on the internal orders view to approved
-- domains.
--
-- admin.js hints the provider's account picker toward the right domain and
-- double-checks the signed-in email client-side, but neither is the real
-- boundary — a client-side check can always be skipped by calling the Auth
-- API directly. This trigger is the boundary: it runs in the database, on
-- account creation, regardless of how the request was made.
--
-- Email/password accounts (created by an admin in the dashboard) are
-- unaffected — the check only applies to the 'google' and 'azure' providers.

create or replace function public.enforce_staff_oauth_domain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  provider text := new.raw_app_meta_data->>'provider';
  domain text := lower(split_part(new.email, '@', 2));
begin
  if provider = 'google' and domain <> 'beaconsoftware.com' then
    raise exception 'Sign-in is restricted to @beaconsoftware.com Google accounts';
  elsif provider = 'azure' and domain <> 'toolhound.com' then
    raise exception 'Sign-in is restricted to @toolhound.com Microsoft accounts';
  end if;

  return new;
end;
$$;

comment on function public.enforce_staff_oauth_domain() is
  'Rejects new auth.users rows from Google or Microsoft sign-in outside the approved staff domain. Email/password accounts are not restricted here.';

drop trigger if exists enforce_staff_oauth_domain on auth.users;
create trigger enforce_staff_oauth_domain
  before insert on auth.users
  for each row
  execute function public.enforce_staff_oauth_domain();
