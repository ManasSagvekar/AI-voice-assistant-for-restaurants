// The staff Health tab: says whether the licence is working ('ok'), needs a look ('warn') or isn't
// working ('down'), and what to do about it.
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const check = (id, label, status, detail, fix) => ({ id, label, status, detail, ...(fix ? { fix } : {}) });

function licence({ licence: l, licensed, now }) {
  if (!licensed) return check('licence', 'Licence', 'ok', 'Running standalone, with no restaurant account.');
  if (!l.linked) return check('licence', 'Licence', 'down', 'This computer is not connected to a restaurant.', 'Connect it from the restaurant sign-in page.');
  if (!l.active) return check('licence', 'Licence', 'down', `Service is paused: ${{ expired: 'the plan has ended', unpaid: 'payment is due', flagged: 'flagged for unusual use', suspended: 'suspended' }[l.state] || l.state}.`, 'Contact your provider to restore service.');
  if (l.until && Date.parse(l.until) - now < 7 * 864e5) return check('licence', 'Licence', 'warn', `Active, but the plan ends on ${day(l.until)}.`, 'Renew before then to avoid a break in service.');
  return check('licence', 'Licence', 'ok', `Active${l.until ? ` until ${day(l.until)}` : ''}.`);
}

export function healthChecks(facts) {
  return { at: facts.now, checks: [licence(facts)] };
}
