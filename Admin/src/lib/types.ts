// Mirrors public.restaurants in supabase/migrations. No revenue or order data exists to model.
type RestaurantStatus = 'active' | 'suspended' | 'flagged';
type PaymentStatus = 'paid' | 'unpaid';
export type Plan = 'monthly' | '3_month' | '6_month' | 'yearly';

export interface Restaurant {
  id: string;
  name: string;
  username: string;
  email: string;
  staff_pin: string;
  status: RestaurantStatus;
  suspension_reason: 'payment' | 'expired' | 'manual' | null;
  payment_status: PaymentStatus;
  subscription_plan: Plan;
  subscription_expires_at: string | null;
  rate_limit_usage_count: number;
  rate_limit_max: number;
  rate_limit_window: string; // Postgres interval: '01:00:00' or '1 day'
  rate_limit_window_started_at: string;
  flagged_at: string | null;
  welcome_email_sent_at: string | null;
  created_at: string;
}

// Everything the admin UI reads; auth_user_id stays server-side.
export const RESTAURANT_COLUMNS = 'id,name,username,email,staff_pin,status,suspension_reason,payment_status,subscription_plan,subscription_expires_at,rate_limit_usage_count,rate_limit_max,rate_limit_window,rate_limit_window_started_at,flagged_at,welcome_email_sent_at,created_at';

export interface RestaurantRow extends Restaurant {
  requests_24h: number;
}

// usage_warning: 80% of the voice limit; rate_limit: limit reached, voice slowed; abuse: 3x the
// limit, access revoked; payment: a Razorpay subscription payment failed or stopped.
export type AlertKind = 'usage_warning' | 'rate_limit' | 'abuse' | 'payment';
export interface Alert {
  id: string;
  restaurant_id: string;
  kind: AlertKind;
  message: string;
  created_at: string;
}

export const PLANS: { value: Plan; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: '3_month', label: '3 months' },
  { value: '6_month', label: '6 months' },
  { value: 'yearly', label: 'Yearly' },
];
export const isPlan = (v: unknown): v is Plan => PLANS.some((p) => p.value === v);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const planLabel = (p: Plan) => PLANS.find((x) => x.value === p)?.label ?? p;
export const isDailyWindow = (w: string) => /day/.test(w);

// `secret` carries a new password or PIN to show once when it could not be emailed.
export type ActionResult = { ok: true; message: string; secret?: string } | { ok: false; error: string };
