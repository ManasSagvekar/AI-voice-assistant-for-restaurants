// Daily expiry reminders. Call with `Authorization: Bearer <CRON_SECRET>`; Vercel Cron does this
// automatically (see vercel.json). Not behind the admin sign-in; the secret is the check.
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { sendDueReminders } from '@/lib/reminders';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Set CRON_SECRET to enable scheduled reminders.' }, { status: 503 });
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    return NextResponse.json(await sendDueReminders());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
