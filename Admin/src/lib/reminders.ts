// Emails restaurants 7 days and 1 day before their plan ends, with a payment link when Razorpay is
// set up. Each reminder remembers the end date it was sent for, so extending the plan re-arms both.
// Run daily, by the cron route (src/app/api/cron/reminders) or the dashboard's "Send due reminders".
import 'server-only';
import { supabaseAdmin } from './supabaseAdmin';
import { sendAccessEmail } from './email';
import { createPaymentLink, razorpayConfigured } from './billing';
import { RESTAURANT_COLUMNS, type Restaurant } from './types';

type Due = Restaurant & { reminder_7d_sent_for: string | null; reminder_1d_sent_for: string | null };
const sameTime = (a: string | null, b: string | null) => !!a && !!b && Date.parse(a) === Date.parse(b);

export async function sendDueReminders(): Promise<{ sent: string[]; failed: string[] }> {
  const db = supabaseAdmin();
  const now = Date.now();
  const { data, error } = await db.from('restaurants')
    .select(`${RESTAURANT_COLUMNS},reminder_7d_sent_for,reminder_1d_sent_for`)
    .eq('status', 'active').eq('payment_status', 'paid')
    .gt('subscription_expires_at', new Date(now).toISOString())
    .lte('subscription_expires_at', new Date(now + 7 * 864e5).toISOString());
  if (error) throw new Error(`Could not load restaurants: ${error.message}`);

  const sent: string[] = [];
  const failed: string[] = [];
  for (const r of data as Due[]) {
    const daysLeft = Math.max(1, Math.ceil((Date.parse(r.subscription_expires_at!) - now) / 864e5));
    const column = daysLeft <= 1 ? 'reminder_1d_sent_for' : 'reminder_7d_sent_for';
    if (sameTime(r[column], r.subscription_expires_at)) continue;
    const link = razorpayConfigured() ? await createPaymentLink(r, r.subscription_plan) : null;
    const payUrl = link && 'url' in link ? link.url : undefined;
    const mail = await sendAccessEmail('reminder', r, { daysLeft, payUrl });
    if (!mail.sent) { failed.push(`${r.name}: ${mail.reason}`); continue; }
    await db.from('restaurants').update({ [column]: r.subscription_expires_at }).eq('id', r.id);
    sent.push(`${r.name} (${daysLeft === 1 ? '1 day' : `${daysLeft} days`} left${payUrl ? ', with payment link' : ''})`);
  }
  return { sent, failed };
}
