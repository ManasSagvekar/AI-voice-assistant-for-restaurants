-- Restaurant licensing for the Voice-assistant app, managed from admin/.
--
-- Privacy: nothing in this schema stores orders, sales, bills or revenue. Orders and totals stay in
-- each restaurant's own Voice-assistant database; the only usage data sent here is request counts.
--
-- Who talks to this schema:
--   admin/            service role (server side only) after checking public.is_admin()
--   Voice-assistant/  signed in as the restaurant's own Supabase Auth user, through the
--                     security-definer RPCs below (restaurant_access, verify_staff_pin, increment_usage)

-- ---------- types ----------
create type public.restaurant_status as enum ('active', 'suspended', 'flagged');
create type public.payment_status as enum ('paid', 'unpaid');
create type public.subscription_plan as enum ('monthly', '3_month', '6_month', 'yearly');

-- ---------- tables ----------
create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 120),
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9_.-]{2,39}$'),
  staff_pin varchar(6) not null unique check (staff_pin ~ '^[0-9]{6}$'),
  email text not null unique check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  status public.restaurant_status not null default 'active',
  -- Why the restaurant is suspended: 'payment' and 'expired' lift on their own once paid or extended;
  -- 'manual' stays until an admin reactivates.
  suspension_reason text check (suspension_reason in ('payment', 'expired', 'manual')),
  payment_status public.payment_status not null default 'unpaid',
  subscription_plan public.subscription_plan not null default 'monthly',
  subscription_expires_at timestamptz,
  rate_limit_usage_count integer not null default 0 check (rate_limit_usage_count >= 0),
  rate_limit_max integer not null default 1000 check (rate_limit_max between 1 and 10000000),
  rate_limit_window interval not null default interval '1 hour'
    check (rate_limit_window in (interval '1 hour', interval '1 day')),
  rate_limit_window_started_at timestamptz not null default now(),
  flagged_at timestamptz,
  welcome_email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Request counts per restaurant per hour, for the admin usage view. Counts only, no content.
create table public.usage_hourly (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  hour timestamptz not null,
  kind text not null check (kind in ('assistant', 'transcribe', 'speak')),
  count integer not null default 0,
  primary key (restaurant_id, hour, kind)
);

create table public.admin_alerts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  kind text not null check (kind in ('rate_limit')),
  message text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index admin_alerts_open on public.admin_alerts (created_at desc) where resolved_at is null;

-- Request volume per restaurant over the last 24 hours, for the admin dashboard.
create view public.usage_last_24h with (security_invoker = true) as
  select restaurant_id, sum(count)::integer as requests
  from public.usage_hourly
  where hour > now() - interval '24 hours'
  group by restaurant_id;

-- ---------- helpers ----------
create function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create function public.plan_interval(p_plan public.subscription_plan)
returns interval
language sql immutable set search_path = ''
as $$
  select case p_plan
    when 'monthly' then interval '1 month'
    when '3_month' then interval '3 months'
    when '6_month' then interval '6 months'
    when 'yearly' then interval '1 year'
  end;
$$;

-- What the Voice-assistant needs to decide whether to serve this restaurant. Expiry is checked
-- live here, so an expired plan is blocked at the next request even before the cron job runs.
create function public.access_payload(r public.restaurants)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'restaurant_id', r.id,
    'name', r.name,
    'status', r.status,
    'payment_status', r.payment_status,
    'subscription_expires_at', r.subscription_expires_at,
    'allowed', r.status = 'active' and r.payment_status = 'paid'
      and r.subscription_expires_at is not null and r.subscription_expires_at > now(),
    'reason', case
      when r.status = 'flagged' then 'flagged'
      when r.payment_status = 'unpaid' then 'unpaid'
      when r.subscription_expires_at is null or r.subscription_expires_at <= now() then 'expired'
      when r.status = 'suspended' then 'suspended'
    end,
    'usage', r.rate_limit_usage_count,
    'limit', r.rate_limit_max
  );
$$;

-- ---------- service lock trigger ----------
-- Suspends a restaurant whenever payment_status is 'unpaid' or the plan has expired, and lifts that
-- automatic suspension once the cause is fixed. Manual suspensions and abuse flags are left alone.
create function public.enforce_service_lock()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  lock_reason text := case
    when new.payment_status = 'unpaid' then 'payment'
    when new.subscription_expires_at is null or new.subscription_expires_at <= now() then 'expired'
  end;
begin
  new.updated_at := now();

  if new.status = 'active' and lock_reason is not null then
    new.status := 'suspended';
    new.suspension_reason := lock_reason;
  elsif new.status = 'suspended' and new.suspension_reason in ('payment', 'expired') then
    if lock_reason is null then
      new.status := 'active';
    else
      new.suspension_reason := lock_reason;
    end if;
  end if;

  if new.status = 'active' then
    new.suspension_reason := null;
  elsif new.status = 'suspended' and new.suspension_reason is null then
    new.suspension_reason := 'manual';
  elsif new.status = 'flagged' then
    new.suspension_reason := null;
  end if;

  if new.status = 'flagged' then
    if tg_op = 'INSERT' or old.status <> 'flagged' then new.flagged_at := now(); end if;
  else
    new.flagged_at := null;
  end if;

  -- Coming back into service starts a fresh usage window and closes any open abuse alerts.
  if tg_op = 'UPDATE' and new.status = 'active' and old.status <> 'active' then
    new.rate_limit_usage_count := 0;
    new.rate_limit_window_started_at := now();
    update public.admin_alerts set resolved_at = now() where restaurant_id = new.id and resolved_at is null;
  end if;

  return new;
end;
$$;

create trigger restaurants_service_lock
  before insert or update on public.restaurants
  for each row execute function public.enforce_service_lock();

-- Time passing doesn't fire the trigger, so a scheduled job re-saves expired rows.
create function public.suspend_expired_restaurants()
returns integer
language sql security definer set search_path = ''
as $$
  with expired as (
    update public.restaurants set status = status
    where status = 'active' and (subscription_expires_at is null or subscription_expires_at <= now())
    returning 1
  )
  select count(*)::integer from expired;
$$;

-- ---------- admin RPCs (service role only) ----------
-- Adds one billing period to the plan, counting from today if it has already lapsed.
create function public.extend_subscription(p_restaurant_id uuid, p_plan public.subscription_plan default null)
returns public.restaurants
language plpgsql security definer set search_path = ''
as $$
declare
  r public.restaurants;
begin
  update public.restaurants
  set subscription_plan = coalesce(p_plan, subscription_plan),
      subscription_expires_at = greatest(coalesce(subscription_expires_at, now()), now())
        + public.plan_interval(coalesce(p_plan, subscription_plan))
  where id = p_restaurant_id
  returning * into r;
  if not found then raise exception 'Restaurant not found' using errcode = 'P0002'; end if;
  return r;
end;
$$;

-- ---------- Voice-assistant RPCs (the restaurant's own signed-in user) ----------
-- Resolves a username to the sign-in email so restaurants can connect a device with their username.
create function public.login_email(p_username text)
returns text
language sql stable security definer set search_path = ''
as $$
  select email from public.restaurants where username = lower(btrim(p_username)) and auth_user_id is not null;
$$;

create function public.restaurant_access()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select public.access_payload(r) from public.restaurants r where r.auth_user_id = auth.uid();
$$;

-- Staff sign in with only the 6-digit PIN. The device's session already identifies the restaurant,
-- so a PIN only works on that restaurant's own Voice-assistant, and only while it is in service.
create function public.verify_staff_pin(p_pin text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.restaurants r
    where r.auth_user_id = auth.uid()
      and r.staff_pin = p_pin
      and r.status = 'active' and r.payment_status = 'paid' and r.subscription_expires_at > now()
  );
$$;

-- Called on every voice request. Counts it, flags the restaurant when it reaches its limit
-- (which revokes access immediately), and returns the access payload either way.
create function public.increment_usage(p_restaurant_id uuid, p_kind text default 'assistant')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.restaurants;
begin
  if p_kind not in ('assistant', 'transcribe', 'speak') then
    raise exception 'Unknown usage kind: %', p_kind using errcode = '22023';
  end if;

  select * into r from public.restaurants
  where id = p_restaurant_id and (auth_user_id = auth.uid() or auth.role() = 'service_role')
  for update;
  if not found then raise exception 'Restaurant not found' using errcode = 'P0002'; end if;

  -- Blocked restaurants aren't counted; they just get told why.
  if not (public.access_payload(r) ->> 'allowed')::boolean then
    return public.access_payload(r);
  end if;

  if r.rate_limit_window_started_at + r.rate_limit_window <= now() then
    r.rate_limit_usage_count := 0;
    r.rate_limit_window_started_at := now();
  end if;
  r.rate_limit_usage_count := r.rate_limit_usage_count + 1;

  insert into public.usage_hourly (restaurant_id, hour, kind, count)
  values (r.id, date_trunc('hour', now()), p_kind, 1)
  on conflict (restaurant_id, hour, kind) do update set count = public.usage_hourly.count + 1;

  if r.rate_limit_usage_count >= r.rate_limit_max then
    r.status := 'flagged';
    insert into public.admin_alerts (restaurant_id, kind, message)
    values (r.id, 'rate_limit', format(
      '%s reached %s voice requests within %s (limit %s). Access was revoked automatically.',
      r.name, r.rate_limit_usage_count,
      case when r.rate_limit_window = interval '1 day' then 'a day' else 'an hour' end,
      r.rate_limit_max));
  end if;

  update public.restaurants
  set rate_limit_usage_count = r.rate_limit_usage_count,
      rate_limit_window_started_at = r.rate_limit_window_started_at,
      status = r.status
  where id = r.id
  returning * into r;

  return public.access_payload(r);
end;
$$;

-- ---------- row level security ----------
alter table public.admins enable row level security;
alter table public.restaurants enable row level security;
alter table public.usage_hourly enable row level security;
alter table public.admin_alerts enable row level security;

create policy "admins see the admin list" on public.admins
  for select to authenticated using ((select public.is_admin()));

create policy "admins manage restaurants" on public.restaurants
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- The Voice-assistant device (signed in as the restaurant) can read its own row, only while in service.
create policy "restaurant reads own row while in service" on public.restaurants
  for select to authenticated
  using (auth_user_id = (select auth.uid()) and status = 'active' and payment_status = 'paid');

create policy "admins read usage" on public.usage_hourly
  for select to authenticated using ((select public.is_admin()));

create policy "admins manage alerts" on public.admin_alerts
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

revoke all on public.admins, public.restaurants, public.usage_hourly, public.admin_alerts, public.usage_last_24h from anon;

-- ---------- function privileges ----------
-- Supabase grants EXECUTE on new functions to anon and authenticated by default; narrow that down.
revoke execute on function
  public.is_admin(), public.plan_interval(public.subscription_plan), public.access_payload(public.restaurants),
  public.enforce_service_lock(), public.suspend_expired_restaurants(),
  public.extend_subscription(uuid, public.subscription_plan), public.login_email(text),
  public.restaurant_access(), public.verify_staff_pin(text), public.increment_usage(uuid, text)
from public, anon, authenticated;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.login_email(text) to anon, authenticated;
grant execute on function public.restaurant_access(), public.verify_staff_pin(text), public.increment_usage(uuid, text)
  to authenticated;
grant execute on function public.extend_subscription(uuid, public.subscription_plan), public.suspend_expired_restaurants(),
  public.plan_interval(public.subscription_plan)
  to service_role;

-- ---------- scheduled jobs ----------
-- Suspends lapsed plans every 5 minutes and keeps 90 days of usage counts. Skipped with a notice
-- where pg_cron isn't available; access_payload still blocks expired plans at request time.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('suspend-expired-restaurants', '*/5 * * * *', 'select public.suspend_expired_restaurants()');
  perform cron.schedule('prune-usage-hourly', '17 3 * * *',
    $job$delete from public.usage_hourly where hour < now() - interval '90 days'$job$);
exception when others then
  raise notice 'pg_cron is not available (%). Enable it and re-run this block to schedule the jobs.', sqlerrm;
end;
$$;
