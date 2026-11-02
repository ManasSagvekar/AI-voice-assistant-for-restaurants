'use client';
import { useTransition } from 'react';
import { dismissAlert } from '@/app/actions';
import type { Alert, AlertKind } from '@/lib/types';

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const KIND: Record<AlertKind, { label: string; tone: string }> = {
  abuse: { label: 'Revoked: possible abuse', tone: 'danger' },
  rate_limit: { label: 'Voice limit reached', tone: 'warn' },
  usage_warning: { label: '80% of voice limit', tone: 'neutral' },
  payment: { label: 'Payment', tone: 'warn' },
};

export function AlertsPanel({ alerts }: { alerts: (Alert & { restaurant: string })[] }) {
  const [pending, start] = useTransition();
  const revoked = alerts.some((a) => a.kind === 'abuse');
  return (
    <section id="alerts" className={`alerts${revoked ? '' : ' alerts-soft'}`} aria-label="Alerts">
      <h2>Alerts</h2>
      <ul>
        {alerts.map((a) => {
          const k = KIND[a.kind] ?? KIND.rate_limit;
          return (
            <li key={a.id}>
              <div>
                <span className={`badge badge-${k.tone}`}>{k.label}</span> <strong>{a.restaurant}</strong> <span className="muted">· {ago(a.created_at)}</span>
                <p>{a.message}</p>
              </div>
              <button className="btn ghost small" disabled={pending} onClick={() => start(async () => { await dismissAlert(a.id); })}>Dismiss</button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Reaching the limit only slows voice down until the next hour or day, and those alerts clear by themselves. A restaurant revoked for abuse stays off until you review it and press Activate, which resets its usage counter.</p>
    </section>
  );
}
