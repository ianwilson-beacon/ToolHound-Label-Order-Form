-- Local stand-in for the parts of a Supabase project the migrations rely on.
--
-- Supabase provisions the anon/authenticated/service_role roles, the `auth`
-- schema, auth.uid(), and default table privileges. A bare Postgres cluster
-- has none of that, so this file creates just enough of it to apply the
-- migrations and exercise the pricing rules against a real planner.
--
-- Only used by scripts/test-db.sh. Never run against the live project.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants the API roles full table privileges by default and relies on
-- RLS to constrain them. The migrations revoke from that starting point, so
-- reproduce it here or the revokes would be testing nothing.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- The real auth.uid() reads the request's JWT claims. Tests set the same GUC.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;
