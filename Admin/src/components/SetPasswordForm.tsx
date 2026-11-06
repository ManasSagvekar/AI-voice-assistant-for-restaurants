'use client';
import { useActionState } from 'react';
import { setPassword, type SetPasswordState } from '@/app/set-password/actions';

export function SetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<SetPasswordState, FormData>(setPassword, null);
  if (state?.done) {
    return <p className="success" role="status">Your password is set. You can now connect your restaurant&apos;s computer with your username and this password.</p>;
  }
  return (
    <form action={action} className="stack">
      <p className="muted">You&apos;ll use this with your username to connect your restaurant&apos;s computer. Staff use the staff PIN instead.</p>
      <input type="hidden" name="token" value={token} />
      <label className="field">
        <span>New password</span>
        <input name="password" type="password" autoComplete="new-password" minLength={10} maxLength={72} required autoFocus />
        <small>At least 10 characters.</small>
      </label>
      <label className="field">
        <span>Repeat it</span>
        <input name="confirm" type="password" autoComplete="new-password" minLength={10} maxLength={72} required />
      </label>
      {state?.error && <p className="error" role="alert">{state.error}</p>}
      <button className="btn primary" disabled={pending}>{pending ? 'Saving…' : 'Set password'}</button>
    </form>
  );
}
