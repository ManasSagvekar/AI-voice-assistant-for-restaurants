'use client';
import { useState, useTransition } from 'react';
import { runReminders } from '@/app/actions';
import type { ActionResult } from '@/lib/types';

// Sends any due expiry reminders now. In production the daily cron route does this on its own.
export function RemindersButton() {
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<ActionResult | null>(null);
  return (
    <div className="tools">
      {notice ? (
        <div className={`notice ${notice.ok ? 'notice-ok' : 'notice-error'}`} role="status">
          <span>{notice.ok ? notice.message : notice.error}</span>
          <button className="btn ghost small" onClick={() => setNotice(null)} aria-label="Dismiss message">Close</button>
        </div>
      ) : <span className="muted small">Plan-end reminders go out 7 days and 1 day before, with a payment link when Razorpay is set up.</span>}
      <button className="btn small" disabled={pending} onClick={() => start(async () => setNotice(await runReminders()))}>
        {pending ? 'Sending…' : 'Send due reminders'}
      </button>
    </div>
  );
}
