// The activity log: who did what, when and from where. Written after an action succeeds. A logging
// failure never undoes or blocks the action; it is reported, and the dashboard warns if the log's
// table is missing. Never pass passwords, PINs or links here.
import 'server-only';
import { headers } from 'next/headers';
import { supabaseAdmin } from './supabaseAdmin';
import { UUID } from './types';

export const ACTION_LABELS: Record<string, string> = {
  sign_in: 'Signed in', sign_out: 'Signed out', two_step_enrolled: 'Set up 2-step sign-in', restaurant_created: 'Onboarded restaurant',
  payment_paid: 'Marked paid', payment_unpaid: 'Marked unpaid', activated: 'Activated', suspended: 'Suspended', plan_extended: 'Extended plan',
  limit_changed: 'Changed voice limit', password_link_sent: 'Sent set-password link', password_set: 'Restaurant set its password', pin_changed: 'Issued new staff PIN',
  payment_link_sent: 'Sent payment link', reminders_sent: 'Sent plan-end reminders', alert_dismissed: 'Dismissed alert',
  payment_received: 'Payment received', payment_halted: 'Subscription stopped', two_step_reset: 'Reset 2-step sign-in',
};

export async function audit(actor: string | null | undefined, action: string, { restaurantId, detail }: { restaurantId?: string; detail?: string } = {}) {
  try {
    const db = supabaseAdmin();
    let restaurant_name: string | null = null;
    const restaurant_id = restaurantId && UUID.test(restaurantId) ? restaurantId : null;
    if (restaurant_id) {
      const { data } = await db.from('restaurants').select('name').eq('id', restaurant_id).maybeSingle();
      restaurant_name = (data?.name as string | undefined) ?? null;
    }
    let ip: string | null = null;
    try { ip = (await headers()).get('x-forwarded-for')?.split(',').pop()?.trim().slice(0, 64) || null; } catch { /* not in a request */ }
    const { error } = await db.from('admin_audit_log').insert({ actor: actor || 'unknown', action, restaurant_id, restaurant_name, detail: detail?.slice(0, 500) ?? null, ip });
    if (error) console.error('[audit] Could not record', action, error.message);
  } catch (e) {
    console.error('[audit] Could not record', action, (e as Error).message);
  }
}
