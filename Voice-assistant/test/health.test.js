import assert from 'node:assert/strict';
import test from 'node:test';
import { healthChecks } from '../server/health.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const active = { state: 'active', active: true, linked: true, offline: false, usage: 'ok', until: '2027-06-01T00:00:00Z' };
const card = (facts) => healthChecks({ now: NOW, licensed: true, licence: active, ...facts }).checks[0];

test('the Health tab reports on the licence and nothing else', () => {
  const { checks, at } = healthChecks({ now: NOW, licensed: true, licence: active });
  assert.equal(at, NOW);
  assert.deepEqual(checks.map((c) => c.id), ['licence']);
  assert.equal(checks[0].status, 'ok');
  assert.match(checks[0].detail, /Active until 1 Jun 2027/);
});

test('licence: paused or not connected is down, ending soon is a warning, no account is fine', () => {
  const unpaid = card({ licence: { ...active, active: false, state: 'unpaid' } });
  assert.equal(unpaid.status, 'down');
  assert.match(unpaid.detail, /payment is due/);
  assert.ok(unpaid.fix);
  assert.equal(card({ licence: { state: 'unlinked', active: false, linked: false } }).status, 'down');
  assert.equal(card({ licence: { ...active, until: new Date(NOW + 2 * 864e5).toISOString() } }).status, 'warn');
  assert.equal(card({ licensed: false, licence: { state: 'standalone', active: true, linked: true } }).status, 'ok');
});
