# Restaurant Admin

Super-admin portal for the Voice-assistant app (`../Voice-assistant`). It onboards restaurants, controls their subscription and access, and watches voice usage for abuse. Next.js 16 + Supabase.

```
Admin (this app) ──service role──▶ Supabase ◀──anon key + restaurant login── Voice-assistant (one per restaurant)
                                    restaurants, admins, usage_hourly, admin_alerts
```

The schema, trigger, RLS policies and RPCs live in [`../supabase/migrations`](../supabase/migrations).

## Set up

1. **Apply the migration** to your Supabase project. Either paste `supabase/migrations/20261031000000_restaurant_licensing.sql` into the SQL editor, or from `Project/`:
   ```sh
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
   If pg_cron isn't enabled, the migration prints a notice and skips the scheduled jobs. Enable pg_cron (Database → Extensions) and re-run the last `do $$ … $$` block. Expired plans are blocked at request time either way.
2. **Configure**: copy `.env.example` to `.env.local` and fill in the project URL, anon key and service role key (Project Settings → API). Use the project root URL (for example, `https://<project-ref>.supabase.co`, without `/rest/v1/`) and keys from that same project. The anon key is for sign-in; the service role key is server-only and must never use a `NEXT_PUBLIC_` prefix. Add `RESEND_API_KEY` and `EMAIL_FROM` (a domain verified in Resend) for welcome emails.
3. **Create your admin account**:
   ```sh
   npm install
   npm run create-admin -- you@example.com "a long password"
   ```
4. From the workspace root (`C:\AI-assistant`), run `npm run dev`. It starts this app and the Voice-assistant behind one address:
   - http://localhost:3000/admin: this super-admin app (it is built with `basePath: '/admin'`)
   - http://localhost:3000/restaurant: the restaurant staff dashboard
   - http://localhost:3000/table/1: a guest tablet

   The Voice-assistant is licensed by the same Supabase project automatically: the script passes it this app's URL and anon key (never the service role key) unless `Voice-assistant/.env` sets its own. Running `npm run dev` inside `Admin/` alone also works, at http://localhost:3100/admin.

Then for each restaurant's Voice-assistant, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (same project, anon key only) in its `.env`. The restaurant connects it once with the username and password from the welcome email.

## What it does

- **Onboarding** (`/restaurants/new`): name, unique username, email, password (stored hashed by Supabase Auth; generated if blank), unique 6-digit staff PIN (generated or typed), plan, payment received, and rate limit. On approval it creates the Supabase Auth user and the restaurant, starts the plan if paid, and emails the login details and PIN. Without email configured, the details are shown once on screen.
- **Dashboard** (`/`): every restaurant with name, username, staff PIN (click to reveal), plan and end date, payment toggle, service status, rate-limit status with a usage meter, and actions: Activate, Suspend, Extend plan, and under More: change the rate limit, issue a new staff PIN, reset the password. Filters for All, Active, Suspended and Flagged. Refreshes every 15 seconds.
- **Payment and access**: marking a restaurant unpaid suspends it at once (database trigger); the Voice-assistant notices within 10 seconds or on the next voice request, whichever is first, and closes all staff sessions and tablets. Marking it paid restores service, and starts a new period if the plan had lapsed. Manual suspensions and abuse flags stay until you press Activate. Activate is refused while unpaid or expired.
- **Abuse prevention**: every voice request calls `increment_usage`. When a restaurant reaches its limit within the hour (or day), it is flagged, access is revoked on that same request, and an alert appears at the top of the dashboard. Activating it again resets its counter and closes the alert.
- **Privacy**: no revenue, order or sales data exists in this schema. Usage is stored as hourly request counts per type.

## Security notes

- The service role key is read only in server code (`src/lib/supabaseAdmin.ts`, marked `server-only`). Every page and server action calls `requireAdmin()`, which checks `public.is_admin()` for the signed-in user.
- Restaurants and admins share Supabase Auth; admin rights come only from the `admins` table, so a restaurant login can't open this app.
- The Voice-assistant never holds the service role key. It acts as the restaurant's own user through security-definer RPCs that only see that restaurant's row, so it can't change its own payment status or limits.
- `login_email(username)` is callable without signing in, so devices can connect with a username. It reveals a restaurant's email to anyone who knows its username.
- Staff PINs are stored in plain text (the dashboard displays them), readable only by admins and by the restaurant's own signed-in device.
