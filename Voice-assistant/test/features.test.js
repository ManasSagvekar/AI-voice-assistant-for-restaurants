import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStore } from '../server/store.js';
import { createAssistant } from '../server/assistant.js';
import { createBackups } from '../server/backup.js';
import { createLicense } from '../server/license.js';
import { EMPTY_FILTERS, matchesFilters, UNDO_MS } from '../shared/engine.js';
import { isLang, LANGS } from '../shared/i18n.js';

test('the guest language list includes every requested language', () => {
  const expected = ['en', 'hi', 'mr', 'es', 'fr', 'ar', 'de', 'pt', 'zh', 'ja', 'bn', 'ta', 'te'];
  assert.deepEqual(LANGS.map((language) => language.id), expected);
  for (const language of expected) assert.equal(isLang(language), true);
});

function withStore(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tazte-features-test-'));
  const store = createStore(path.join(directory, 'restaurant.db'));
  try {
    return run(store, directory);
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a guest can take an order back within the undo window, and the dishes return to the cart', () => {
  withStore((store) => {
    store.addToCart('T1', 'tiramisu', 2, ['no_nuts']);
    store.setNote('T1', 'Birthday candle');
    const id = store.placeOrder('T1');
    assert.equal(store.cart('T1').length, 0);
    assert.deepEqual(store.cancelOrder('T1', id, UNDO_MS), { ok: true, id });
    assert.deepEqual(store.cart('T1').map((l) => [l.itemId, l.qty, l.mods]), [['tiramisu', 2, ['no_nuts']]]);
    assert.equal(store.note('T1'), 'Birthday candle');
    assert.equal(store.tableOrders('T1').length, 0);
  });
});

test('an order the kitchen has started, or from another table, cannot be taken back', () => {
  withStore((store) => {
    store.addToCart('T1', 'tiramisu', 1, []);
    const id = store.placeOrder('T1');
    assert.equal(store.cancelOrder('T2', id, UNDO_MS).reason, 'not_found');
    store.advanceOrder(id);
    assert.equal(store.cancelOrder('T1', id, UNDO_MS).reason, 'too_late');
    store.addToCart('T1', 'brulee', 1, []);
    const late = store.placeOrder('T1');
    assert.equal(store.cancelOrder('T1', late, -1).reason, 'too_late');
  });
});

test('backups write a copy and keep only the newest ones', () => {
  withStore((store, directory) => {
    const dir = path.join(directory, 'backups');
    const copyDir = path.join(directory, 'usb');
    const backups = createBackups(store, { dir, copyDir, keep: 2 });
    for (let i = 0; i < 3; i++) {
      assert.equal(backups.run().error, null);
      // File names carry the time to the second, so wait for the next one.
      if (i < 2) { const t = Date.now(); while (Date.now() - t < 1050) { /* busy wait */ } }
    }
    assert.equal(readdirSync(dir).length, 2);
    assert.equal(readdirSync(copyDir).length, 2);
    const last = backups.status();
    assert.ok(existsSync(path.join(dir, last.file)));
  });
});

test('sending by voice offers the pairing once, then reads back and waits for a yes', () => {
  withStore((store) => {
    store.updateItem('tiramisu', { pairWith: 'flatwhite' });
    const a = createAssistant(store);
    a.handle('T1', 'add a tiramisu');
    let r = a.handle('T1', 'send my order').body;
    assert.match(r.text, /Single-Origin Flat White/);
    assert.equal(r.effects.openConfirm, true);
    r = a.handle('T1', 'yes please').body;
    assert.match(r.text, /Added the Single-Origin Flat White/);
    assert.match(r.text, /Shall I send it to the kitchen\?/);
    assert.equal(store.tableOrders('T1').length, 0, 'nothing is sent before the guest confirms');
    r = a.handle('T1', 'yes').body;
    assert.ok(r.effects.orderPlaced);
    assert.equal(store.tableOrders('T1')[0].lines.length, 2);
    // Each new order may hear the suggestion once.
    a.handle('T1', 'add a tiramisu');
    assert.match(a.handle('T1', 'send my order').body.text, /Single-Origin Flat White/);
  });
});

test('a "no" at the read-back keeps the order on the tablet', () => {
  withStore((store) => {
    const a = createAssistant(store);
    a.handle('T2', 'add a classic tiramisu');
    assert.match(a.handle('T2', "that's all").body.text, /Shall I send it/);
    const r = a.handle('T2', 'no wait').body;
    assert.equal(r.effects.closeConfirm, true);
    assert.equal(store.tableOrders('T2').length, 0);
    assert.equal(store.cart('T2').length, 1);
  });
});

test('allergy questions are answered only from a list the kitchen confirmed', () => {
  withStore((store) => {
    const a = createAssistant(store);
    let r = a.handle('T1', 'Does the tiramisu have nuts?').body;
    assert.match(r.text, /asked a server/);
    assert.equal(store.requests('T1')[0].type, 'server');
    assert.equal(store.allergenLog()[0].answer, 'unknown');

    store.updateItem('tiramisu', { allergensChecked: true });
    r = a.handle('T1', 'Does the tiramisu have nuts?').body;
    assert.match(r.text, /has no tree nuts/);
    r = a.handle('T1', 'is there dairy in the tiramisu').body;
    assert.match(r.text, /contains dairy/);
    assert.deepEqual(store.allergenLog().map((e) => e.answer), ['contains', 'free', 'unknown']);
  });
});

test('"free of" filters show only dishes with a confirmed allergen list', () => {
  const f = { ...EMPTY_FILTERS, avoid: ['nuts'] };
  assert.equal(matchesFilters({ allergens: [], allergensChecked: false, meals: [] }, f), false);
  assert.equal(matchesFilters({ allergens: [], allergensChecked: true, meals: [] }, f), true);
  assert.equal(matchesFilters({ allergens: ['nuts'], allergensChecked: true, meals: [] }, f), false);
});

test('a paid restaurant keeps serving while offline until its plan ends, and reports voice usage', () => {
  withStore((store) => {
    const day = 864e5;
    const seed = (access) => {
      store.setting('license_refresh_token', 'stored-token');
      store.setting('license_access', JSON.stringify({ name: 'Bistro', reason: null, ...access }));
      return createLicense(store, { url: 'http://127.0.0.1:9', anonKey: 'anon' });
    };
    // Last heard from the licence server two days ago, plan runs another week.
    let s = seed({ allowed: true, subscription_expires_at: new Date(Date.now() + 7 * day).toISOString(), checkedAt: Date.now() - 2 * day }).status();
    assert.equal(s.active, true); assert.equal(s.offline, true); assert.equal(s.usage, 'ok');
    // The end date still applies while offline.
    s = seed({ allowed: true, subscription_expires_at: new Date(Date.now() - 1000).toISOString(), checkedAt: Date.now() - 2 * day }).status();
    assert.equal(s.active, false); assert.equal(s.state, 'expired');
    // Over the limit: still active, voice throttled.
    s = seed({ allowed: true, throttled: true, warn: true, subscription_expires_at: new Date(Date.now() + day).toISOString(), checkedAt: Date.now() }).status();
    assert.equal(s.active, true); assert.equal(s.usage, 'throttled'); assert.equal(s.offline, false);
    // Suspended by the admin: closed, whatever the connection.
    s = seed({ allowed: false, reason: 'suspended', subscription_expires_at: new Date(Date.now() + day).toISOString(), checkedAt: Date.now() }).status();
    assert.equal(s.active, false); assert.equal(s.state, 'suspended');
  });
});

test('replies follow the guest language, and voice can cancel a just-sent order', () => {
  withStore((store) => {
    const a = createAssistant(store);
    assert.match(a.handle('T4', 'add a tiramisu', 'hi').body.text, /जोड़ दिया/);
    a.handle('T4', 'send it to the kitchen', 'mr');
    const sent = a.handle('T4', 'yes', 'mr').body;
    assert.ok(sent.effects.orderPlaced);
    assert.match(sent.text, /किचनमध्ये पाठवली/);
    const undone = a.handle('T4', 'cancel my order').body;
    assert.equal(undone.effects.orderCancelled, sent.effects.orderPlaced.id);
    assert.equal(store.cart('T4').length, 1);
  });
});
