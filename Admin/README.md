# Restaurant Admin

Super-admin portal for the Voice-assistant app (`../Voice-assistant`). It onboards restaurants, controls their subscription and access, and watches voice usage for abuse. Next.js 16 + Supabase.

```
Admin (this app) ──service role──▶ Supabase ◀──anon key + restaurant login── Voice-assistant (one per restaurant)
                                    restaurants, admins, usage_hourly, admin_alerts
```

The schema, trigger, RLS policies and RPCs live in [`../supabase/migrations`](../supabase/migrations).

## Set up

1. **Apply the migrations** to your Supabase project, in order: `20261031000000_restaurant_licensing.sql`, `20261102000000_soft_limits_and_billing.sql`, then `20261106000000_admin_security.sql`. Either paste each file from `supabase/migrations/` into the SQL editor, or from `Project/`:
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
   - http://localhost:3000/admin: this super-admin app (it is built with `basePath: '/admin'`). It answers only on this computer; other devices on the network get a 403. Set `ADMIN_REMOTE=1` before `npm run dev` to open it to the network.
   - http://localhost:3000/restaurant: the restaurant staff dashboard
   - http://localhost:3000/table/1: a guest tablet

   The Voice-assistant is licensed by the same Supabase project automatically: the script passes it this app's URL and anon key (never the service role key) unless `Voice-assistant/.env` sets its own. Running `npm run dev` inside `Admin/` alone also works, at http://localhost:3100/admin.

Then for each restaurant's Voice-assistant, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (same project, anon key only) in its `.env`. The restaurant connects it once with the username and password from the welcome email.

## What it does

- **Onboarding** (`/restaurants/new`): name, unique username, email, unique 6-digit staff PIN (generated or typed), plan, payment received, and rate limit. On approval it creates the Supabase Auth user and the restaurant, starts the plan if paid, and emails the username, PIN and a link for the restaurant to choose its own password. Passwords are never emailed or shown. The link needs `ADMIN_PUBLIC_URL` set to an address restaurants can reach; otherwise, or without email configured, it is shown on screen to pass on.
- **Dashboard** (`/`): every restaurant with name, username, staff PIN (click to reveal), plan and end date, payment toggle, service status, rate-limit status with a usage meter, and actions: Activate, Suspend, Extend plan, and under More: change the rate limit, issue a new staff PIN, send a set-password link (the old password stops working at once; connected computers stay connected). Filters for All, Active, Suspended and Flagged. Refreshes every 15 seconds.
- **Payment and access**: marking a restaurant unpaid suspends it at once (database trigger); the Voice-assistant notices within 10 seconds or on the next voice request, whichever is first, and closes all staff sessions and tablets. Marking it paid restores service, and starts a new period if the plan had lapsed. Manual suspensions and abuse flags stay until you press Activate. Activate is refused while unpaid or expired.
- **Voice limits and abuse**: every voice request calls `increment_usage`. At 80% of a restaurant's limit for the hour (or day) you get a warning alert; at 100% its voice is slowed down until the window resets (one voice turn per table every 20 seconds), while ordering by touch and its staff dashboard keep working, and the alert clears by itself. Only three times the limit in one window counts as abuse: the restaurant is flagged, access is revoked, and it stays off until you press Activate, which resets its counter.
- **Payments (Razorpay)**: under More, **Send payment link** creates a Razorpay payment link for one period of the chosen plan, and Razorpay emails it to the restaurant. When it's paid, the webhook (`/admin/api/razorpay/webhook`) marks the restaurant paid and extends the plan by one period. Razorpay subscriptions work the same way if their notes carry `restaurant_id` and `plan`; a halted subscription marks the restaurant unpaid, and failed payments raise a Payment alert. Each webhook event is applied once, and only its id and type are stored, never the amount. Set the `RAZORPAY_*` values in `.env.local` and add the webhook in the Razorpay dashboard with the events listed in `.env.example`.
- **Plan-end reminders**: restaurants are emailed 7 days and 1 day before their plan ends, with a payment link when Razorpay is set up. In production, `vercel.json` calls `/admin/api/cron/reminders` daily (set `CRON_SECRET`); elsewhere, call that URL daily with `Authorization: Bearer <CRON_SECRET>`, or press **Send due reminders** on the dashboard. Extending a plan re-arms both reminders.
- **Admin sign-in**: admins sign in with a password. 2-step sign-in is switched off for now and planned to return before this app is hosted publicly: set `ADMIN_2FA=on` to require a code from an authenticator app, set up at each admin's first sign-in. Either way, the security migration's database rules refuse an admin session that has no second step, because the anon key is public and a stolen password could otherwise go straight to Supabase; this app is unaffected because it reads data with the service role after its own check. For a lost phone, run `npm run reset-admin-2fa -- <email>` on a computer with the service role key.
- **Activity** (`/activity`): a permanent record of who did what, when and from where, plus payments confirmed by Razorpay. A database trigger stops anyone editing or removing it, even with the service role key. It never holds passwords, PINs or links.
- **Security notices**: the dashboard warns if anyone can still sign up to the Supabase project, or if the security migration hasn't been applied.
- **Privacy**: no revenue, order or sales data exists in this schema. Usage is stored as hourly request counts per type.

## Security notes

- The service role key is read only in server code (`src/lib/supabaseAdmin.ts`, marked `server-only`). Every page and server action calls `requireAdmin()`, which checks `public.is_admin()` for the signed-in user.
- Restaurants and admins share Supabase Auth; admin rights come only from the `admins` table, so a restaurant login can't open this app.
- `/admin/api/razorpay/webhook`, `/admin/api/cron/reminders` and `/admin/set-password` are the only routes outside the admin sign-in. `set-password` needs a single-use token from Supabase, and opening the page spends nothing, so email scanners that open links can't use it up. The webhook accepts only requests signed with `RAZORPAY_WEBHOOK_SECRET` (HMAC-SHA256); the cron route only `Bearer <CRON_SECRET>`. Both refuse everything while their secret is unset.
- The Voice-assistant never holds the service role key. It acts as the restaurant's own user through security-definer RPCs that only see that restaurant's row, so it can't change its own payment status or limits.
- `login_email(username)` is callable without signing in, so devices can connect with a username. It reveals a restaurant's email to anyone who knows its username.
- Staff PINs are stored in plain text (the dashboard displays them), readable only by admins and by the restaurant's own signed-in device.
