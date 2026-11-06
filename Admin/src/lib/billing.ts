// Razorpay billing. Payment links carry the restaurant's id and plan in their notes; when Razorpay
// confirms a payment (webhook), the restaurant is marked paid and its plan extended by one period.
// Each webhook event is recorded once in payment_events, without any amount, so a retried delivery
// never extends a plan twice.
import 'server-only';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from './supabaseAdmin';
import { audit } from './audit';
import { isPlan, planLabel, UUID, type Plan, type Restaurant } from './types';

const PRICE_ENV: Record<Plan, string> = {
  monthly: 'RAZORPAY_PRICE_MONTHLY', '3_month': 'RAZORPAY_PRICE_3_MONTH', '6_month': 'RAZORPAY_PRICE_6_MONTH', yearly: 'RAZORPAY_PRICE_YEARLY',
};

export const razorpayConfigured = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

// The plan's price in the currency's smallest unit (paise for INR), from RAZORPAY_PRICE_* in rupees.
function priceOf(plan: Plan): number | null {
  const n = Number(process.env[PRICE_ENV[plan]]);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

export async function createPaymentLink(r: Restaurant, plan: Plan): Promise<{ url: string } | { error: string }> {
  if (!razorpayConfigured()) return { error: 'Razorpay is not configured (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET).' };
  const amount = priceOf(plan);
  if (!amount) return { error: `Set ${PRICE_ENV[plan]} to the ${planLabel(plan)} price first.` };
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  try {
    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount, currency: process.env.BILLING_CURRENCY || 'INR', accept_partial: false,
        description: `${r.name}: ${planLabel(plan)} plan`,
        customer: { name: r.name, email: r.email },
        notify: { email: true, sms: false }, reminder_enable: true,
        notes: { restaurant_id: r.id, plan },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.short_url) return { error: `Razorpay refused the payment link: ${body?.error?.description ?? res.status}` };
    return { url: body.short_url as string };
  } catch (e) {
    return { error: `Could not reach Razorpay: ${(e as Error).message}` };
  }
}

export function verifyWebhook(raw: string, signature: string | null): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

type RazorpayEvent = { event?: string; payload?: Record<string, { entity?: { notes?: Record<string, unknown> } }> };

// Applies one verified webhook. Returns what happened, for the response body and the logs.
export async function handlePaymentEvent(eventId: string | null, raw: string): Promise<string> {
  const body = JSON.parse(raw) as RazorpayEvent;
  const event = body.event ?? 'unknown';
  const notes = body.payload?.payment_link?.entity?.notes ?? body.payload?.subscription?.entity?.notes ?? body.payload?.payment?.entity?.notes ?? {};
  const restaurantId = typeof notes.restaurant_id === 'string' && UUID.test(notes.restaurant_id) ? notes.restaurant_id : null;
  const plan = isPlan(notes.plan) ? notes.plan : null;
  const db = supabaseAdmin();

  const id = eventId || 'sha256:' + createHash('sha256').update(raw).digest('hex');
  const { error: dup } = await db.from('payment_events').insert({ id, restaurant_id: restaurantId, event });
  if (dup?.code === '23505') return 'duplicate';
  if (dup) throw new Error(dup.message);
  if (!restaurantId) return 'ignored: no restaurant_id in the notes';
  const { data: r } = await db.from('restaurants').select('id,name').eq('id', restaurantId).single();
  if (!r) return 'ignored: unknown restaurant';

  if (event === 'payment_link.paid' || event === 'subscription.charged') {
    // Paid first, then one more period: the service-lock trigger restores access by itself.
    await db.from('restaurants').update({ payment_status: 'paid', last_payment_at: new Date().toISOString() }).eq('id', restaurantId);
    const { error } = await db.rpc('extend_subscription', { p_restaurant_id: restaurantId, p_plan: plan });
    if (error) throw new Error(error.message);
    await audit('Razorpay', 'payment_received', { restaurantId, detail: `${event}, ${plan ?? 'current'} plan` });
    return `paid: ${r.name} extended by one ${plan ?? 'current'} period`;
  }
  if (event === 'subscription.halted') {
    await db.from('restaurants').update({ payment_status: 'unpaid' }).eq('id', restaurantId);
    await db.from('admin_alerts').insert({ restaurant_id: restaurantId, kind: 'payment', message: `${r.name}: Razorpay stopped the subscription after repeated failed payments. Marked unpaid.` });
    await audit('Razorpay', 'payment_halted', { restaurantId, detail: event });
    return `halted: ${r.name} marked unpaid`;
  }
  if (event === 'subscription.pending') {
    await db.from('admin_alerts').insert({ restaurant_id: restaurantId, kind: 'payment', message: `${r.name}: a subscription payment failed. Razorpay will retry it.` });
    return `pending: alert raised for ${r.name}`;
  }
  return `ignored: ${event}`;
}
