// Emails to restaurants, sent through Resend's HTTP API. White-label: the restaurant's own name only,
// no product logos. Plain text and simple HTML, no tracking.
import 'server-only';
import { planLabel, type Restaurant } from './types';

type Kind = 'welcome' | 'password' | 'pin' | 'reminder';
export type EmailOutcome = { sent: true } | { sent: false; reason: string };
type EmailExtras = { setPasswordUrl?: string; daysLeft?: number; payUrl?: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null);

function compose(kind: Kind, r: Restaurant, { setPasswordUrl, daysLeft, payUrl }: EmailExtras) {
  const until = date(r.subscription_expires_at);
  const live = r.status === 'active';
  const days = daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  const subject = {
    welcome: `${r.name}: your voice assistant access`,
    password: `${r.name}: set your password`,
    pin: `${r.name}: your new staff PIN`,
    reminder: `${r.name}: your plan ends ${days}`,
  }[kind];
  const intro = {
    welcome: 'Your restaurant has been approved for the table voice assistant. Here are your sign-in details.',
    password: 'Please choose a new password for your restaurant account, using the button below. Your old one no longer works. Computers already connected stay connected.',
    pin: 'Your staff PIN has changed. The old PIN no longer works.',
    reminder: `Your ${planLabel(r.subscription_plan)} plan ends on ${until}. Renew before then so your tablets and staff dashboard keep working without a break.`,
  }[kind];
  const status = kind === 'reminder'
    ? (payUrl ? 'Pay securely with the link below. Your plan is extended as soon as the payment goes through.' : 'Reply to this email or contact us to renew.')
    : live
      ? `Access is active${until ? ` until ${until}` : ''} on the ${planLabel(r.subscription_plan)} plan.`
      : r.payment_status === 'unpaid'
        ? 'Access will start as soon as your payment is confirmed.'
        : 'Access is currently paused. Contact us to restore it.';
  const rows: [string, string][] = kind === 'reminder'
    ? [['Restaurant', r.name], ['Username', r.username], ['Plan', planLabel(r.subscription_plan)], ['Ends on', until ?? '']]
    : [
      ['Restaurant', r.name],
      ['Username', r.username],
      ['Staff PIN', r.staff_pin],
    ];
  const url = process.env.VOICE_ASSISTANT_URL;
  const steps = [
    'Choose your password with the button in this email.',
    `Open the restaurant dashboard${url ? ` at ${url}` : ''}.`,
    'The first time, choose Connect and sign in with your username and that password.',
    'After that, staff sign in with the 6-digit staff PIN.',
  ];
  const footer = kind === 'reminder' ? '' : 'Keep these details private. Anyone with the staff PIN can open your dashboard.';
  const text = [
    `Hello ${r.name},`, '', intro, '',
    ...rows.map(([k, v]) => `${k}: ${v}`), '',
    status, ...(setPasswordUrl ? ['', `Set your password (this link works once and expires soon; ask us for a new one if it has): ${setPasswordUrl}`] : []), ...(payUrl ? ['', `Pay now: ${payUrl}`] : []), '',
    ...(kind === 'welcome' ? ['Getting started:', ...steps.map((s, i) => `${i + 1}. ${s}`), ''] : []),
    footer,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5f2;font-family:Segoe UI,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
  <h1 style="font-size:22px;margin:0 0 16px">${esc(r.name)}</h1>
  <p style="font-size:15px;line-height:1.5">${esc(intro)}</p>
  <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e2dc;border-radius:8px;margin:16px 0">
    ${rows.map(([k, v]) => `<tr><td style="padding:10px 14px;color:#6b665e;font-size:13px;width:40%">${esc(k)}</td><td style="padding:10px 14px;font-family:Consolas,monospace;font-size:15px">${esc(v)}</td></tr>`).join('')}
  </table>
  <p style="font-size:15px;line-height:1.5"><strong>${esc(status)}</strong></p>
  ${setPasswordUrl ? `<p style="margin:20px 0"><a href="${esc(setPasswordUrl)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Set your password</a></p><p style="font-size:12px;color:#6b665e">This link works once and expires soon. If it has, ask us for a new one.</p>` : ''}
  ${payUrl ? `<p style="margin:20px 0"><a href="${esc(payUrl)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Renew now</a></p><p style="font-size:12px;color:#6b665e;word-break:break-all">${esc(payUrl)}</p>` : ''}
  ${kind === 'welcome' ? `<ol style="font-size:15px;line-height:1.6;padding-left:20px">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
  ${footer ? `<p style="font-size:13px;color:#6b665e;line-height:1.5">${esc(footer)}</p>` : ''}
</div></body></html>`;
  return { subject, text, html };
}

export async function sendAccessEmail(kind: Kind, r: Restaurant, extras: EmailExtras = {}): Promise<EmailOutcome> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) return { sent: false, reason: 'Email is not configured (RESEND_API_KEY, EMAIL_FROM).' };
  const { subject, text, html } = compose(kind, r, extras);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [r.email], subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { sent: false, reason: `Email provider refused it: ${body?.message ?? res.status}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `Could not reach the email provider: ${(e as Error).message}` };
  }
}
