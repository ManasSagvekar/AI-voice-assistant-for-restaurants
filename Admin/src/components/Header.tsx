import Link from 'next/link';
import { signOut } from '@/app/login/actions';

export function Header({ alerts = 0, email }: { alerts?: number; email?: string }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="brand">Restaurant Admin</Link>
        {alerts > 0 && (
          <a href="#alerts" className="alert-pill" aria-label={`${alerts} open abuse alert${alerts === 1 ? '' : 's'}`}>
            <span className="dot" aria-hidden="true" />{alerts} alert{alerts === 1 ? '' : 's'}
          </a>
        )}
        <span className="spacer" />
        <Link href="/restaurants/new" className="btn primary">Onboard restaurant</Link>
        <form action={signOut}>
          <button className="btn ghost" title={email}>Sign out</button>
        </form>
      </div>
    </header>
  );
}
