'use client';
import { useActionState, useState } from 'react';
import { startEnroll, verifyCode, type EnrollResult } from '@/app/login/two-step/actions';

export function TwoStepForm({ enrolled }: { enrolled: boolean }) {
  const [error, action, pending] = useActionState(verifyCode, null);
  const [enroll, setEnroll] = useState<EnrollResult | null>(null);
  const [starting, setStarting] = useState(false);
  const setup = enroll && 'factorId' in enroll ? enroll : null;

  if (!enrolled && !setup) {
    return (
      <div className="stack">
        <p className="muted">This account controls every restaurant, so it needs a second step as well as a password. You&apos;ll need an authenticator app on your phone, such as Google Authenticator or Microsoft Authenticator.</p>
        {enroll && 'error' in enroll && <p className="error" role="alert">{enroll.error}</p>}
        <button className="btn primary" disabled={starting} onClick={async () => { setStarting(true); setEnroll(await startEnroll()); setStarting(false); }}>{starting ? 'Starting…' : 'Set up 2-step sign-in'}</button>
      </div>
    );
  }
  return (
    <form action={action} className="stack">
      {setup ? (
        <>
          <p className="muted">Scan this with your authenticator app, then enter the 6-digit code it shows.</p>
          {/* A QR code from Supabase as a data URL; next/image doesn't apply. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="QR code for your authenticator app" width={200} height={200} style={{ alignSelf: 'center', background: '#fff', padding: 8, borderRadius: 8 }} />
          <details><summary className="muted">Can&apos;t scan it?</summary><p className="muted">Enter this key in the app: <code className="secret">{setup.secret}</code></p></details>
          <input type="hidden" name="factorId" value={setup.factorId} />
        </>
      ) : <p className="muted">Enter the 6-digit code from your authenticator app.</p>}
      <label className="field">
        <span>Code</span>
        <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required autoFocus />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary" disabled={pending}>{pending ? 'Checking…' : setup ? 'Finish setup' : 'Continue'}</button>
    </form>
  );
}
