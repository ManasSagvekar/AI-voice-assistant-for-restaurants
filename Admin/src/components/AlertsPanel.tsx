'use client';
import { useTransition } from 'react';
import { dismissAlert } from '@/app/actions';
import type { Alert } from '@/lib/types';

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export function AlertsPanel({ alerts }: { alerts: (Alert & { restaurant: string })[] }) {
  const [pending, start] = useTransition();
  return (
    <section id="alerts" className="alerts" aria-label="Abuse alerts">
      <h2>Automatically revoked</h2>
      <ul>
        {alerts.map((a) => (
          <li key={a.id}>
            <div>
              <strong>{a.restaurant}</strong> <span className="muted">· {ago(a.created_at)}</span>
              <p>{a.message}</p>
            </div>
            <button className="btn ghost small" disabled={pending} onClick={() => start(async () => { await dismissAlert(a.id); })}>Dismiss</button>
          </li>
        ))}
      </ul>
      <p className="muted small">Review the restaurant below, then use Activate to restore access. Activating resets its usage counter.</p>
    </section>
  );
}
