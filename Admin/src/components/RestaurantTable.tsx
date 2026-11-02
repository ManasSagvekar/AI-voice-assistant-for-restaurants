'use client';
import { useState, useTransition } from 'react';
import { activate, extendPlan, regeneratePin, resetPassword, setPayment, setRateLimit, suspend } from '@/app/actions';
import { PLANS, planLabel, isDailyWindow, type ActionResult, type Plan, type RestaurantRow } from '@/lib/types';
import { Badge, Switch } from './StatusBadge';

type Filter = 'all' | 'active' | 'suspended' | 'flagged';
const FILTERS: [Filter, string][] = [['all', 'All'], ['active', 'Active'], ['suspended', 'Suspended'], ['flagged', 'Flagged']];
const REASONS = { payment: 'Payment unpaid', expired: 'Plan expired', manual: 'Suspended by admin' } as const;
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export function RestaurantTable({ rows }: { rows: RestaurantRow[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<ActionResult | null>(null);
  const q = query.trim().toLowerCase();
  const list = rows.filter((r) => (filter === 'all' || r.status === filter)
    && (!q || r.name.toLowerCase().includes(q) || r.username.includes(q) || r.email.includes(q)));
  const count = (f: Filter) => (f === 'all' ? rows.length : rows.filter((r) => r.status === f).length);

  return (
    <section className="card table-card">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter by service status">
          {FILTERS.map(([f, label]) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)} className={f === 'flagged' && count(f) > 0 ? 'has-flag' : ''}>
              {label} <span className="count">{count(f)}</span>
            </button>
          ))}
        </div>
        <input type="search" placeholder="Search name, username or email" aria-label="Search restaurants" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {notice && (
        <div className={`notice ${notice.ok ? 'notice-ok' : 'notice-error'}`} role="status">
          <span>{notice.ok ? notice.message : notice.error}</span>
          {notice.ok && notice.secret && <code className="secret">{notice.secret}</code>}
          <button className="btn ghost small" onClick={() => setNotice(null)} aria-label="Dismiss message">Close</button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="empty">No restaurants yet. Use <strong>Onboard restaurant</strong> to add the first one.</p>
      ) : list.length === 0 ? (
        <p className="empty">No restaurants match this filter.</p>
      ) : (
        <table className="rtable">
          <thead>
            <tr>
              <th>Name</th><th>Username</th><th>Staff PIN</th><th>Subscription plan</th><th>Payment</th>
              <th>Service</th><th>Rate limit</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>{list.map((r) => <Row key={r.id} r={r} onResult={setNotice} />)}</tbody>
        </table>
      )}
    </section>
  );
}

function Row({ r, onResult }: { r: RestaurantRow; onResult: (r: ActionResult) => void }) {
  const [pending, start] = useTransition();
  const [showPin, setShowPin] = useState(false);
  const [plan, setPlan] = useState<Plan>(r.subscription_plan);
  const daily = isDailyWindow(r.rate_limit_window);
  const [limit, setLimit] = useState(String(r.rate_limit_max));
  const [limitDaily, setLimitDaily] = useState(daily);
  const run = (fn: () => Promise<ActionResult>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    start(async () => onResult(await fn()));
  };

  const paid = r.payment_status === 'paid';
  const expired = !r.subscription_expires_at || Date.parse(r.subscription_expires_at) <= Date.now();
  const windowOpen = Date.parse(r.rate_limit_window_started_at) + (daily ? 864e5 : 36e5) > Date.now();
  const used = windowOpen ? r.rate_limit_usage_count : 0;
  const pct = Math.min(100, Math.round((used / r.rate_limit_max) * 100));
  const flagged = r.status === 'flagged';
  const blockedBy = !paid ? 'Mark as paid first' : expired ? 'Extend the plan first' : '';

  return (
    <tr className={pending ? 'busy' : flagged ? 'row-flagged' : ''} aria-busy={pending}>
      <td data-label="Name">
        <div className="strong">{r.name}</div>
        <div className="sub">{r.email}</div>
      </td>
      <td data-label="Username"><code>{r.username}</code></td>
      <td data-label="Staff PIN">
        <button className="pin" onClick={() => setShowPin((s) => !s)} aria-label={showPin ? 'Hide staff PIN' : 'Show staff PIN'}>
          <code>{showPin ? r.staff_pin : '••••••'}</code>
        </button>
      </td>
      <td data-label="Subscription plan">
        <div>{planLabel(r.subscription_plan)}</div>
        <div className={`sub${expired ? ' text-warn' : ''}`}>{r.subscription_expires_at ? `${expired ? 'Expired' : 'Until'} ${fmtDate(r.subscription_expires_at)}` : 'Not started'}</div>
      </td>
      <td data-label="Payment">
        <div className="inline">
          <Switch on={paid} disabled={pending} label={`${r.name} payment status`}
            onChange={() => run(() => setPayment(r.id, !paid), paid ? `Mark ${r.name} as unpaid? Their voice assistant and staff access stop immediately.` : undefined)} />
          <Badge tone={paid ? 'ok' : 'warn'}>{paid ? 'Paid' : 'Unpaid'}</Badge>
        </div>
      </td>
      <td data-label="Service">
        <Badge tone={r.status === 'active' ? 'ok' : flagged ? 'danger' : 'warn'}>{r.status === 'active' ? 'Active' : 'Suspended'}</Badge>
        <div className="sub">{flagged ? 'Revoked for abuse' : r.suspension_reason ? REASONS[r.suspension_reason] : ''}</div>
      </td>
      <td data-label="Rate limit">
        <Badge tone={flagged ? 'danger' : pct >= 80 ? 'warn' : 'neutral'}>{flagged ? 'Flagged' : pct >= 80 ? 'Near limit' : 'Normal'}</Badge>
        <div className="meter" aria-hidden="true"><span style={{ width: `${pct}%` }} className={flagged || pct >= 80 ? 'hot' : ''} /></div>
        <div className="sub">{used.toLocaleString()} / {r.rate_limit_max.toLocaleString()} per {daily ? 'day' : 'hour'} · {r.requests_24h.toLocaleString()} in 24 h</div>
      </td>
      <td data-label="Actions">
        <div className="actions">
          {r.status === 'active' ? (
            <button className="btn danger small" disabled={pending} onClick={() => run(() => suspend(r.id), `Suspend ${r.name}? Their tablets and staff dashboard stop within seconds.`)}>Suspend</button>
          ) : (
            <button className="btn primary small" disabled={pending || !!blockedBy} title={blockedBy || undefined} onClick={() => run(() => activate(r.id))}>Activate</button>
          )}
          <div className="extend">
            <select aria-label={`Plan to extend ${r.name} by`} value={plan} onChange={(e) => setPlan(e.target.value as Plan)} disabled={pending}>
              {PLANS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            <button className="btn small" disabled={pending} onClick={() => run(() => extendPlan(r.id, plan))}>Extend plan</button>
          </div>
          <details className="more">
            <summary className="btn ghost small">More</summary>
            <div className="menu">
              <form className="limit-form" onSubmit={(e) => { e.preventDefault(); run(() => setRateLimit(r.id, Number(limit), limitDaily)); }}>
                <label className="field compact">
                  <span>Rate limit</span>
                  <div className="inline">
                    <input type="number" min={1} step={1} value={limit} onChange={(e) => setLimit(e.target.value)} aria-label="Requests allowed" />
                    <select value={limitDaily ? 'day' : 'hour'} onChange={(e) => setLimitDaily(e.target.value === 'day')} aria-label="Per">
                      <option value="hour">per hour</option><option value="day">per day</option>
                    </select>
                  </div>
                </label>
                <button className="btn small" disabled={pending}>Save limit</button>
              </form>
              <button className="btn small" disabled={pending} onClick={() => run(() => regeneratePin(r.id), `Give ${r.name} a new staff PIN? The current PIN stops working for new sign-ins.`)}>New staff PIN</button>
              <button className="btn small" disabled={pending} onClick={() => run(() => resetPassword(r.id), `Reset ${r.name}'s password and email the new one?`)}>Reset password &amp; email</button>
            </div>
          </details>
        </div>
      </td>
    </tr>
  );
}
