-- Soft voice limits, Razorpay billing and expiry reminders. Apply after 20261031000000_restaurant_licensing.sql.
--
-- 1. Reaching the voice limit no longer revokes access. At 80% the admin gets a warning; at 100% the
--    restaurant is "throttled" for the rest of the window (its Voice-assistant slows voice down, while
--    touch ordering and the staff dashboard keep working); both clear on their own when the window
--    resets. Only clear abuse, three times the limit in one window, still flags and revokes access.
-- 2. Payments confirmed by Razorpay webhooks are recorded once each (idempotency), without amounts.
-- 3. Expiry reminders remember which end date they were sent for, so extending a plan re-arms them.

-- ---------- alerts ----------
alter table public.admin_alerts drop constraint if exists admin_alerts_kind_check;
alter table public.admin_alerts add constraint admin_alerts_kind_check
  check (kind in ('rate_limit', 'usage_warning', 'abuse', 'payment'));

-- ---------- billing and reminders ----------
alter table public.restaurants
  add column if not exists last_payment_at timestamptz,
  add column if not exists reminder_7d_sent_for timestamptz,
  add column if not exists reminder_1d_sent_for timestamptz;

-- One row per Razorpay webhook event, so a retried delivery never extends a plan twice. No amounts.
create table if not exists public.payment_events (
  id text primary key,
  restaurant_id uuid references public.restaurants (id) on delete set null,
  event text not null,
  received_at timestamptz not null default now()
);
alter table public.payment_events enable row level security;
drop policy if exists "admins read payment events" on public.payment_events;
create policy "admins read payment events" on public.payment_events
  for select to authenticated using ((select public.is_admin()));
revoke all on public.payment_events from anon;

-- ---------- access payload ----------
-- Usage now counts only the current window, and says whether the restaurant is near or over its limit.
create or replace function public.access_payload(r public.restaurants)
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
    'usage', u.used,
    'limit', r.rate_limit_max,
    'warn', u.used >= ceil(r.rate_limit_max * 0.8),
    'throttled', u.used >= r.rate_limit_max
  )
  from (select case when r.rate_limit_window_started_at + r.rate_limit_window <= now() then 0
                    else r.rate_limit_usage_count end as used) u;
$$;

-- ---------- usage counting ----------
create or replace function public.increment_usage(p_restaurant_id uuid, p_kind text default 'assistant')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.restaurants;
  per text;
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

  -- A new window clears the previous window's usage alerts.
  if r.rate_limit_window_started_at + r.rate_limit_window <= now() then
    r.rate_limit_usage_count := 0;
    r.rate_limit_window_started_at := now();
    update public.admin_alerts set resolved_at = now()
    where restaurant_id = r.id and kind in ('usage_warning', 'rate_limit') and resolved_at is null;
  end if;
  r.rate_limit_usage_count := r.rate_limit_usage_count + 1;
  per := case when r.rate_limit_window = interval '1 day' then 'day' else 'hour' end;

  insert into public.usage_hourly (restaurant_id, hour, kind, count)
  values (r.id, date_trunc('hour', now()), p_kind, 1)
  on conflict (restaurant_id, hour, kind) do update set count = public.usage_hourly.count + 1;

  -- Each threshold is crossed exactly once per window, so each alert is raised once.
  if r.rate_limit_usage_count = ceil(r.rate_limit_max * 0.8)::integer then
    insert into public.admin_alerts (restaurant_id, kind, message)
    values (r.id, 'usage_warning', format('%s has used 80%% of its voice limit (%s per %s). Consider a higher limit.', r.name, r.rate_limit_max, per));
  end if;
  if r.rate_limit_usage_count = r.rate_limit_max then
    insert into public.admin_alerts (restaurant_id, kind, message)
    values (r.id, 'rate_limit', format('%s reached its voice limit of %s per %s. Voice is slowed down until %s; ordering by touch and the staff dashboard keep working.',
      r.name, r.rate_limit_max, per, to_char(r.rate_limit_window_started_at + r.rate_limit_window, 'DD Mon HH24:MI "UTC"')));
  end if;
  if r.rate_limit_usage_count >= r.rate_limit_max * 3 then
    r.status := 'flagged';
    insert into public.admin_alerts (restaurant_id, kind, message)
    values (r.id, 'abuse', format('%s made %s voice requests in one %s, three times its limit of %s. Access was revoked as possible abuse.',
      r.name, r.rate_limit_usage_count, per, r.rate_limit_max));
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

-- create or replace keeps the existing grants; restate them in case this runs on a fresh copy.
revoke execute on function public.access_payload(public.restaurants), public.increment_usage(uuid, text) from public, anon, authenticated;
grant execute on function public.increment_usage(uuid, text) to authenticated;
