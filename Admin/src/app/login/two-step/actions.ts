'use server';
// The second sign-in step: a code from an authenticator app, checked by Supabase. Signing in with a
// password only gets this far; requireAdmin() and the database rules both require this step.
import { redirect } from 'next/navigation';
import { audit } from '@/lib/audit';
import { twoStepRequired } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';

export type EnrollResult = { factorId: string; qr: string; secret: string } | { error: string };

export async function startEnroll(): Promise<EnrollResult> {
  if (!twoStepRequired()) return { error: '2-step sign-in is switched off. Reload this page to continue.' };
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Your session ended. Please sign in again.' };
  const { data: isAdmin } = await supabase.rpc('is_admin');
  if (isAdmin !== true) return { error: 'This account does not have admin access.' };
  const { data: factors } = await supabase.auth.mfa.listFactors();
  if (factors?.totp.some((f) => f.status === 'verified')) return { error: '2-step sign-in is already set up on this account.' };
  // An earlier attempt that was never finished would block a new one.
  for (const f of factors?.all ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator app' });
  if (error || !data) return { error: `2-step sign-in could not be set up: ${error?.message ?? 'no response'}. Check that TOTP is enabled in Supabase, under Authentication, Multi-Factor.` };
  // Supabase's QR code is SVG in a data URL without escaping, and a "#" in it would cut the image short.
  const comma = data.totp.qr_code.indexOf(',');
  const qr = data.totp.qr_code.slice(comma + 1).trimStart().startsWith('<')
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.totp.qr_code.slice(comma + 1))}`
    : data.totp.qr_code;
  return { factorId: data.id, qr, secret: data.totp.secret };
}

export async function verifyCode(_prev: string | null, form: FormData): Promise<string | null> {
  if (!twoStepRequired()) redirect('/');
  const code = String(form.get('code') ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return 'Enter the 6-digit code from your authenticator app.';
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const verified = factors?.totp.find((f) => f.status === 'verified');
  // Enrolling sends the new factor's id; once one is verified, only that one counts.
  const enrolling = String(form.get('factorId') ?? '');
  const factorId = verified?.id ?? (factors?.all.some((f) => f.id === enrolling) ? enrolling : null);
  if (!factorId) return 'Please start again.';
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) return 'That code is not correct. Codes change every 30 seconds, so check the current one.';
  await audit(user.email, verified ? 'sign_in' : 'two_step_enrolled');
  redirect('/');
}
