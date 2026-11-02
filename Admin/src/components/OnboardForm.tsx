'use client';
import { useActionState, useState } from 'react';
import Link from 'next/link';
import { createRestaurant, type CreateState } from '@/app/actions';
import { PLANS } from '@/lib/types';

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const randomPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');

export function OnboardForm({ emailConfigured }: { emailConfigured: boolean }) {
  const [state, action, pending] = useActionState<CreateState, FormData>(createRestaurant, null);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [pin, setPin] = useState('');
  const err = state?.fields ?? {};
  const v = state?.values ?? {};

  if (state?.created) {
    const c = state.created;
    return (
      <div className="card stack">
        <h2>{c.name} is onboarded</h2>
        <p className={c.mail.sent ? 'success' : 'warning'}>
          {c.mail.sent ? `Welcome email sent to ${c.email}.` : `No email was sent: ${c.mail.reason} Share these details securely; the password is not shown again.`}
        </p>
        <dl className="creds">
          <dt>Username</dt><dd><code>{c.username}</code></dd>
          <dt>Password</dt><dd><code>{c.password}</code></dd>
          <dt>Staff PIN</dt><dd><code>{c.pin}</code></dd>
          <dt>Service</dt><dd>{c.status === 'active' ? `Active${c.expires ? ` until ${new Date(c.expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}` : 'Suspended until payment is marked as received'}</dd>
        </dl>
        <div className="inline">
          <Link href="/" className="btn primary">Back to restaurants</Link>
          <a href="/admin/restaurants/new" className="btn">Onboard another</a>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="card form-grid" noValidate>
      {state?.error && <p className="error span-2" role="alert">{state.error}</p>}

      <label className={`field span-2${err.name ? ' invalid' : ''}`}>
        <span>Restaurant name</span>
        <input name="name" required maxLength={120} value={name} autoFocus
          onChange={(e) => { setName(e.target.value); if (!usernameEdited) setUsername(slug(e.target.value)); }} />
        <small>Shown on the restaurant&apos;s tablets and staff dashboard in place of any product branding.</small>
        {err.name && <em>{err.name}</em>}
      </label>

      <label className={`field${err.username ? ' invalid' : ''}`}>
        <span>Username</span>
        <input name="username" required value={username} autoComplete="off" spellCheck={false}
          onChange={(e) => { setUsername(e.target.value.toLowerCase()); setUsernameEdited(true); }} />
        {err.username && <em>{err.username}</em>}
      </label>

      <label className={`field${err.email ? ' invalid' : ''}`}>
        <span>Email</span>
        <input name="email" type="email" required autoComplete="off" defaultValue={v.email} />
        {err.email && <em>{err.email}</em>}
      </label>

      <label className={`field${err.password ? ' invalid' : ''}`}>
        <span>Password</span>
        <input name="password" type="text" autoComplete="new-password" placeholder="Leave blank to generate" spellCheck={false} defaultValue={v.password} />
        <small>Stored hashed by Supabase Auth. Minimum 10 characters.</small>
        {err.password && <em>{err.password}</em>}
      </label>

      <label className={`field${err.staff_pin ? ' invalid' : ''}`}>
        <span>Staff PIN</span>
        <div className="inline">
          <input name="staff_pin" inputMode="numeric" maxLength={6} placeholder="Generated automatically" value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} className="mono" />
          <button type="button" className="btn small" onClick={() => setPin(randomPin())}>Generate</button>
        </div>
        <small>6 digits, unique across restaurants. Staff use it to sign in to the dashboard.</small>
        {err.staff_pin && <em>{err.staff_pin}</em>}
      </label>

      <label className={`field${err.plan ? ' invalid' : ''}`}>
        <span>Subscription plan</span>
        <select name="plan" defaultValue={v.plan ?? 'monthly'}>
          {PLANS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </label>

      <label className="field check">
        <input type="checkbox" name="paid" defaultChecked={v.paid === 'on'} />
        <span>Payment received<small>Starts the plan today. Unpaid restaurants stay suspended until you mark them paid.</small></span>
      </label>

      <label className={`field${err.rate_limit_max ? ' invalid' : ''}`}>
        <span>Voice request limit</span>
        <div className="inline">
          <input name="rate_limit_max" type="number" min={1} step={1} defaultValue={v.rate_limit_max ?? 1000} />
          <select name="rate_limit_window" defaultValue={v.rate_limit_window ?? 'hour'} aria-label="Per">
            <option value="hour">per hour</option><option value="day">per day</option>
          </select>
        </div>
        <small>Reaching it flags the restaurant and revokes access automatically.</small>
        {err.rate_limit_max && <em>{err.rate_limit_max}</em>}
      </label>

      <label className="field check">
        <input type="checkbox" name="send_email" defaultChecked={emailConfigured && (!state || v.send_email === 'on')} disabled={!emailConfigured} />
        <span>Email the login details and staff PIN
          <small>{emailConfigured ? 'Sent to the address above once the restaurant is created.' : 'Email is not configured; the details are shown on screen instead.'}</small>
        </span>
      </label>

      <div className="span-2 inline end">
        <Link href="/" className="btn ghost">Cancel</Link>
        <button className="btn primary" disabled={pending}>{pending ? 'Creating…' : 'Approve & create restaurant'}</button>
      </div>
    </form>
  );
}
