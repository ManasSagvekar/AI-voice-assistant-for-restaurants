'use client';
import { useActionState } from 'react';
import { signIn } from '@/app/login/actions';

export function LoginForm({ initialError }: { initialError: string | null }) {
  const [error, action, pending] = useActionState(signIn, initialError);
  return (
    <form action={action} className="stack">
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="username" required autoFocus />
      </label>
      <label className="field">
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
