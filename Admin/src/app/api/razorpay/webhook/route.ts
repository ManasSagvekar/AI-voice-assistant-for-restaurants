// Razorpay webhook: point Razorpay at https://<admin host>/admin/api/razorpay/webhook with the events
// payment_link.paid, subscription.charged, subscription.pending and subscription.halted, and the same
// secret as RAZORPAY_WEBHOOK_SECRET. Not behind the admin sign-in; the signature is the check.
import { NextResponse } from 'next/server';
import { handlePaymentEvent, verifyWebhook } from '@/lib/billing';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return NextResponse.json({ error: 'Razorpay webhooks are not configured.' }, { status: 503 });
  const raw = await request.text();
  if (!verifyWebhook(raw, request.headers.get('x-razorpay-signature'))) {
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 401 });
  }
  try {
    const result = await handlePaymentEvent(request.headers.get('x-razorpay-event-id'), raw);
    console.log('[razorpay]', result);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    console.error('[razorpay]', (e as Error).message);
    // A 5xx makes Razorpay retry later; the event id keeps a retry from applying twice.
    return NextResponse.json({ error: 'Could not apply the event.' }, { status: 500 });
  }
}
