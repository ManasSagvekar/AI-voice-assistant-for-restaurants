-- Admin security. Apply after 20261102000000_soft_limits_and_billing.sql. Safe to apply twice.
--
-- 1. Admin rows can only be reached after the second sign-in step. The anon key is public, so without
--    this a stolen admin password could go straight to the database and skip the Admin app's 2-step
--    check. (The app itself uses the service role, after its own check.)
-- 2. A permanent, append-only record of what admins do: who, when, from where, to which restaurant.
--    Never passwords, PINs or links.
--
-- To undo: re-create the five policies below with (select public.is_admin()), then
--   drop table public.admin_audit_log; drop function public.admin_audit_is_permanent();
--   drop function public.admin_verified();

-- ---------- two-step sign-in, enforced by the database ----------
create or replace function public.admin_verified()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.is_admin() and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;
revoke execute on function public.admin_verified() from public, anon;
grant execute on function public.admin_verified() to authenticated;

drop policy if exists "admins see the admin list" on public.admins;
create policy "admins see the admin list" on public.admins
  for select to authenticated using ((select public.admin_verified()));

drop policy if exists "admins manage restaurants" on public.restaurants;
create policy "admins manage restaurants" on public.restaurants
  for all to authenticated using ((select public.admin_verified())) with check ((select public.admin_verified()));

drop policy if exists "admins read usage" on public.usage_hourly;
create policy "admins read usage" on public.usage_hourly
  for select to authenticated using ((select public.admin_verified()));

drop policy if exists "admins manage alerts" on public.admin_alerts;
create policy "admins manage alerts" on public.admin_alerts
  for all to authenticated using ((select public.admin_verified())) with check ((select public.admin_verified()));

drop policy if exists "admins read payment events" on public.payment_events;
create policy "admins read payment events" on public.payment_events
  for select to authenticated using ((select public.admin_verified()));

-- ---------- the activity log ----------
-- restaurant_id is deliberately not a foreign key: the record outlives the restaurant.
create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null check (length(actor) between 1 and 320),
  action text not null check (length(action) between 1 and 60),
  restaurant_id uuid,
  restaurant_name text,
  detail text check (length(detail) <= 500),
  ip text check (length(ip) <= 64)
);
create index if not exists admin_audit_log_at on public.admin_audit_log (at desc);
create index if not exists admin_audit_log_restaurant on public.admin_audit_log (restaurant_id, at desc);

alter table public.admin_audit_log enable row level security;
drop policy if exists "admins read the activity log" on public.admin_audit_log;
create policy "admins read the activity log" on public.admin_audit_log
  for select to authenticated using ((select public.admin_verified()));
revoke all on public.admin_audit_log from anon, authenticated;
grant select on public.admin_audit_log to authenticated;

-- Nobody edits or removes history, not even with the service role key.
create or replace function public.admin_audit_is_permanent()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'The activity log can only be added to.' using errcode = '42501';
end;
$$;
revoke execute on function public.admin_audit_is_permanent() from public, anon, authenticated;

drop trigger if exists admin_audit_no_change on public.admin_audit_log;
create trigger admin_audit_no_change before update or delete on public.admin_audit_log
  for each row execute function public.admin_audit_is_permanent();
drop trigger if exists admin_audit_no_truncate on public.admin_audit_log;
create trigger admin_audit_no_truncate before truncate on public.admin_audit_log
  for each statement execute function public.admin_audit_is_permanent();
