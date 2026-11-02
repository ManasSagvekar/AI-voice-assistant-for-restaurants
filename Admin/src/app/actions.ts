'use server';
// Every action starts with requireAdmin(): server actions are reachable by direct POST, so the
// proxy redirect is not a guard on its own. Inputs are re-validated here for the same reason.
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { generatePassword, generatePin } from '@/lib/credentials';
import { sendAccessEmail, type EmailOutcome } from '@/lib/email';
import { createPaymentLink } from '@/lib/billing';
import { sendDueReminders } from '@/lib/reminders';
import { PLANS, RESTAURANT_COLUMNS as COLUMNS, type ActionResult, type Plan, type Restaurant } from '@/lib/types';

const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,39}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PIN = /^\d{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isPlan = (v: unknown): v is Plan => PLANS.some((p) => p.value === v);
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'no date');

const done = (message: string, secret?: string): ActionResult => { revalidatePath('/'); return { ok: true, message, secret }; };
const fail = (error: string): ActionResult => ({ ok: false, error });

async function load(id: unknown): Promise<Restaurant> {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Unknown restaurant.');
  const { data, error } = await supabaseAdmin().from('restaurants').select(COLUMNS).eq('id', id).single();
  if (error || !data) throw new Error('Restaurant not found.');
  return data as Restaurant;
}
async function authUserId(id: string) {
  const { data } = await supabaseAdmin().from('restaurants').select('auth_user_id').eq('id', id).single();
  return (data?.auth_user_id as string | null) ?? null;
}
// Wraps an action so expected failures come back as messages instead of error pages.
const guard = async (fn: () => Promise<ActionResult>): Promise<ActionResult> => {
  await requireAdmin();
  try { return await fn(); } catch (e) { return fail((e as Error).message); }
};

// ---------- onboarding ----------
export type CreateState = {
  error?: string;
  fields?: Record<string, string>;
  values?: Record<string, string>; // echoed back so a failed submit doesn't clear the form
  created?: { name: string; username: string; email: string; password: string; pin: string; status: string; expires: string | null; mail: EmailOutcome };
} | null;

export async function createRestaurant(_prev: CreateState, form: FormData): Promise<CreateState> {
  await requireAdmin();
  const name = String(form.get('name') ?? '').trim();
  const username = String(form.get('username') ?? '').trim().toLowerCase();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '') || generatePassword();
  const chosenPin = String(form.get('staff_pin') ?? '').trim();
  const plan = form.get('plan');
  const paid = form.get('paid') === 'on';
  const limit = Number(form.get('rate_limit_max') || 1000);
  const window = form.get('rate_limit_window') === 'day' ? '1 day' : '1 hour';
  const notify = form.get('send_email') === 'on';
  const values = Object.fromEntries([...form.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$')).map(([k, v]) => [k, String(v)]));
  const invalid = (f: Record<string, string>, error = 'Check the highlighted fields.') => ({ error, fields: f, values });

  const fields: Record<string, string> = {};
  if (!name || name.length > 120) fields.name = 'Enter the restaurant name (up to 120 characters).';
  if (!USERNAME.test(username)) fields.username = '3–40 characters: lowercase letters, numbers, dot, dash or underscore.';
  if (!EMAIL.test(email)) fields.email = 'Enter a valid email address.';
  if (password.length < 10 || password.length > 72) fields.password = 'Use 10–72 characters, or leave blank to generate one.';
  if (chosenPin && !PIN.test(chosenPin)) fields.staff_pin = 'The PIN must be exactly 6 digits.';
  if (!isPlan(plan)) fields.plan = 'Choose a plan.';
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000_000) fields.rate_limit_max = 'Enter a whole number of requests.';
  if (Object.keys(fields).length) return invalid(fields);

  const db = supabaseAdmin();
  // The row goes in first so the database's unique constraints report clashes precisely.
  let row: Restaurant | null = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const pin = chosenPin || generatePin();
    const { data, error } = await db.from('restaurants').insert({
      name, username, email, staff_pin: pin, payment_status: paid ? 'paid' : 'unpaid',
      subscription_plan: plan, rate_limit_max: limit, rate_limit_window: window,
    }).select(COLUMNS).single();
    if (!error) { row = data as Restaurant; break; }
    if (error.code !== '23505') return invalid({}, `Could not save the restaurant: ${error.message}`);
    if (error.message.includes('username')) return invalid({ username: 'That username is taken.' });
    if (error.message.includes('email')) return invalid({ email: 'A restaurant with this email already exists.' });
    if (chosenPin) return invalid({ staff_pin: 'That PIN belongs to another restaurant.' });
  }
  if (!row) return invalid({}, 'Could not generate a unique staff PIN. Try again.');

  const { data: user, error: authError } = await db.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { role: 'restaurant' }, user_metadata: { username, restaurant: name },
  });
  if (authError || !user.user) {
    await db.from('restaurants').delete().eq('id', row.id);
    return /already/i.test(authError?.message ?? '')
      ? invalid({ email: 'This email already has an account.' })
      : invalid({}, `Could not create the sign-in account: ${authError?.message}`);
  }
  await db.from('restaurants').update({ auth_user_id: user.user.id }).eq('id', row.id);
  if (paid) {
    const { data: extended } = await db.rpc('extend_subscription', { p_restaurant_id: row.id, p_plan: plan });
    if (extended) row = { ...row, ...(extended as Restaurant) };
  }

  const mail: EmailOutcome = notify ? await sendAccessEmail('welcome', row, { password }) : { sent: false, reason: 'You chose not to send an email.' };
  if (mail.sent) await db.from('restaurants').update({ welcome_email_sent_at: new Date().toISOString() }).eq('id', row.id);

  revalidatePath('/');
  return { created: { name, username, email, password, pin: row.staff_pin, status: row.status, expires: row.subscription_expires_at, mail } };
}

// ---------- access ----------
export async function setPayment(id: string, paid: boolean) {
  return guard(async () => {
    const r = await load(id);
    const db = supabaseAdmin();
    const { error } = await db.from('restaurants').update({ payment_status: paid ? 'paid' : 'unpaid' }).eq('id', r.id);
    if (error) return fail(error.message);
    if (!paid) return done(`${r.name} marked unpaid. Voice assistant and staff access are blocked now.`);
    // A payment for a lapsed plan starts a new billing period today.
    if (!r.subscription_expires_at || Date.parse(r.subscription_expires_at) <= Date.now()) {
      await db.rpc('extend_subscription', { p_restaurant_id: r.id });
    }
    const after = await load(id);
    return done(after.status === 'active'
      ? `${r.name} marked paid and in service until ${fmtDate(after.subscription_expires_at)}.`
      : `${r.name} marked paid. It is still ${after.status}; use Activate to restore access.`);
  });
}

export async function activate(id: string) {
  return guard(async () => {
    const r = await load(id);
    const { error } = await supabaseAdmin().from('restaurants').update({ status: 'active' }).eq('id', r.id);
    if (error) return fail(error.message);
    const after = await load(id);
    // The service-lock trigger refuses activation while unpaid or expired.
    if (after.status !== 'active') {
      return fail(after.payment_status === 'unpaid' ? `${r.name} can't be activated while unpaid. Mark it paid first.` : `${r.name}'s plan has expired. Extend it first.`);
    }
    return done(`${r.name} is active again. Its usage counter was reset.`);
  });
}

export async function suspend(id: string) {
  return guard(async () => {
    const r = await load(id);
    const { error } = await supabaseAdmin().from('restaurants').update({ status: 'suspended', suspension_reason: 'manual' }).eq('id', r.id);
    if (error) return fail(error.message);
    return done(`${r.name} suspended. Tablets and staff sessions are closed within seconds.`);
  });
}

export async function extendPlan(id: string, plan: Plan) {
  return guard(async () => {
    if (!isPlan(plan)) return fail('Choose a plan.');
    const r = await load(id);
    const { data, error } = await supabaseAdmin().rpc('extend_subscription', { p_restaurant_id: r.id, p_plan: plan });
    if (error) return fail(error.message);
    const after = data as Restaurant;
    const note = after.status === 'active' ? '' : after.payment_status === 'unpaid' ? ' Payment is still unpaid, so access stays blocked.' : ` It is still ${after.status}.`;
    return done(`${r.name} now runs until ${fmtDate(after.subscription_expires_at)}.${note}`);
  });
}

export async function setRateLimit(id: string, max: number, daily: boolean) {
  return guard(async () => {
    if (!Number.isInteger(max) || max < 1 || max > 10_000_000) return fail('Enter a whole number of requests.');
    const r = await load(id);
    const { error } = await supabaseAdmin().from('restaurants').update({ rate_limit_max: max, rate_limit_window: daily ? '1 day' : '1 hour' }).eq('id', r.id);
    if (error) return fail(error.message);
    return done(`${r.name} may now make ${max.toLocaleString()} voice requests per ${daily ? 'day' : 'hour'}.`);
  });
}

// ---------- credentials ----------
export async function resetPassword(id: string) {
  return guard(async () => {
    const r = await load(id);
    const uid = await authUserId(r.id);
    if (!uid) return fail(`${r.name} has no sign-in account.`);
    const password = generatePassword();
    const { error } = await supabaseAdmin().auth.admin.updateUserById(uid, { password });
    if (error) return fail(error.message);
    const mail = await sendAccessEmail('password', r, { password });
    return mail.sent
      ? done(`New password emailed to ${r.email}.`)
      : done(`Password reset, but the email was not sent (${mail.reason}). Share it securely:`, password);
  });
}

export async function regeneratePin(id: string) {
  return guard(async () => {
    const r = await load(id);
    const db = supabaseAdmin();
    for (let attempt = 0; attempt < 5; attempt++) {
      const pin = generatePin();
      const { error } = await db.from('restaurants').update({ staff_pin: pin }).eq('id', r.id);
      if (error?.code === '23505') continue;
      if (error) return fail(error.message);
      const mail = await sendAccessEmail('pin', { ...r, staff_pin: pin });
      return done(mail.sent ? `New staff PIN emailed to ${r.email}.` : `New staff PIN set; the email was not sent (${mail.reason}). New PIN:`, mail.sent ? undefined : pin);
    }
    return fail('Could not generate a unique PIN. Try again.');
  });
}

// ---------- billing ----------
// A Razorpay payment link for one period of the chosen plan. Razorpay emails it to the restaurant;
// when it's paid, the webhook marks the restaurant paid and extends the plan.
export async function sendPaymentLink(id: string, plan: Plan) {
  return guard(async () => {
    if (!isPlan(plan)) return fail('Choose a plan.');
    const r = await load(id);
    const link = await createPaymentLink(r, plan);
    if ('error' in link) return fail(link.error);
    return done(`Payment link sent to ${r.email} by Razorpay. When it's paid, ${r.name} is marked paid and extended automatically:`, link.url);
  });
}

export async function runReminders() {
  return guard(async () => {
    const { sent, failed } = await sendDueReminders();
    if (!sent.length && !failed.length) return done('No reminders are due. Restaurants are emailed 7 days and 1 day before their plan ends.');
    if (failed.length && !sent.length) return fail(`No reminders could be sent: ${failed.join('; ')}`);
    return done(`Reminders sent: ${sent.join(', ')}.${failed.length ? ` Not sent: ${failed.join('; ')}.` : ''}`);
  });
}

// ---------- alerts ----------
export async function dismissAlert(id: string) {
  return guard(async () => {
    if (!UUID.test(id)) return fail('Unknown alert.');
    const db = supabaseAdmin();
    const { data, error } = await db.from('admin_alerts').update({ resolved_at: new Date().toISOString() }).eq('id', id).select('kind').single();
    if (error) return fail(error.message);
    return done(data?.kind === 'abuse' ? 'Alert dismissed. The restaurant stays flagged until you activate it.' : 'Alert dismissed.');
  });
}
