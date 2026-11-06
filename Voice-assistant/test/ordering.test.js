import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { createStore } from '../server/store.js';
import { createAssistant } from '../server/assistant.js';
import { billAmounts, DEFAULT_BILLING, priceLine, setMenuMeta, totals, validateCall } from '../shared/engine.js';
import { parseMenuText } from '../shared/menuparse.js';

function withStore(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tazte-ordering-test-'));
  const store = createStore(path.join(directory, 'restaurant.db'));
  try {
    return run(store);
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
const SIZES = [{ id: 'half', label: 'Half', price: 31 }, { id: 'full', label: 'Full', price: 38 }];
afterEach(() => setMenuMeta({ billing: DEFAULT_BILLING }));

test('each size has its own price, and the two sizes of a dish stay separate lines', () => {
  withStore((store) => {
    store.updateItem('tiramisu', { sizes: SIZES, price: 31 });
    store.addToCart('T1', 'tiramisu', 1, [], 'half');
    store.addToCart('T1', 'tiramisu', 2, [], 'full');
    store.addToCart('T1', 'tiramisu', 1, [], 'full');
    const cart = store.cart('T1');
    assert.deepEqual(cart.map((l) => [l.size, l.qty]), [['half', 1], ['full', 3]]);
    assert.equal(totals(store.menu(), cart).subtotal, 31 + 3 * 38);
    const id = store.placeOrder('T1');
    const [order] = store.tableOrders('T1');
    assert.deepEqual(order.lines.map((l) => [l.name, l.qty, l.unit]), [['Classic Tiramisu (Half)', 1, 31], ['Classic Tiramisu (Full)', 3, 38]]);
    // Taking the order back returns the same sizes to the cart.
    store.cancelOrder('T1', id, 60000);
    assert.deepEqual(store.cart('T1').map((l) => [l.size, l.qty]), [['half', 1], ['full', 3]]);
  });
});

test('a price can never come from a size that dish does not have', () => {
  withStore((store) => {
    store.updateItem('tiramisu', { sizes: SIZES, price: 31 });
    const menu = store.menu();
    assert.equal(validateCall({ tool: 'add_to_cart', args: { item_id: 'tiramisu', qty: 1, modifiers: [], size: 'huge' } }, menu).ok, false);
    assert.equal(validateCall({ tool: 'add_to_cart', args: { item_id: 'brulee', qty: 1, modifiers: [], size: 'half' } }, menu).ok, false);
    assert.equal(priceLine(menu, { itemId: 'tiramisu', qty: 1, size: 'full' }).total, 38);
  });
});

test('changing a dish to sizes removes cart lines that no longer have a valid size', () => {
  withStore((store) => {
    store.addToCart('T1', 'tiramisu', 1, []);
    store.updateItem('tiramisu', { sizes: SIZES, price: 31 });
    assert.equal(store.cart('T1').length, 0);
  });
});

test('by voice: a size said with the dish is used, otherwise the assistant asks', () => {
  withStore((store) => {
    store.updateItem('tiramisu', { sizes: SIZES, price: 31 });
    const a = createAssistant(store);
    assert.match(a.handle('T1', 'two full classic tiramisu').body.text, /Added 2 × Classic Tiramisu \(Full\)/);
    assert.deepEqual(store.cart('T1').map((l) => [l.size, l.qty]), [['full', 2]]);

    const q = a.handle('T2', 'add a classic tiramisu').body.text;
    assert.match(q, /Which size/);
    assert.match(q, /Half \(\$31\.00\) or Full \(\$38\.00\)/);
    assert.equal(store.cart('T2').length, 0, 'nothing is added until a size is chosen');
    assert.match(a.handle('T2', 'half please').body.text, /Added Classic Tiramisu \(Half\)/);
    assert.deepEqual(store.cart('T2').map((l) => l.size), ['half']);

    a.handle('T3', 'add a classic tiramisu');
    assert.match(a.handle('T3', 'no').body.text, /haven't added/);
    assert.equal(store.cart('T3').length, 0);
  });
});

test('tax and service charge: added on top, or already in the prices', () => {
  const on = (b) => ({ ...DEFAULT_BILLING, ...b });
  assert.deepEqual(billAmounts(100, on({ taxRate: 5, serviceRate: 10 })), { subtotal: 100, service: 10, tax: 5.5, total: 115.5 });
  assert.deepEqual(billAmounts(105, on({ taxRate: 5, taxIncluded: true })), { subtotal: 105, service: 0, tax: 5, total: 105 });
  assert.deepEqual(billAmounts(100, on({})), { subtotal: 100, service: 0, tax: 0, total: 100 });
});

test('an order keeps the rates it was sent with, whatever staff change later', () => {
  withStore((store) => {
    setMenuMeta({ billing: { taxRate: 5, taxLabel: 'VAT', serviceRate: 10 } });
    store.addToCart('T1', 'tiramisu', 1, []); // 12.00
    store.placeOrder('T1');
    setMenuMeta({ billing: { taxRate: 20, serviceRate: 0 } });
    const [order] = store.tableOrders('T1');
    assert.deepEqual([order.subtotal, order.service, order.tax, order.total], [12, 1.2, 0.66, 13.86]);
    assert.equal(order.billing.taxLabel, 'VAT');
  });
});

test('tax settings are saved per restaurant and flagged until they are set', () => {
  withStore((store) => {
    assert.equal(store.menuMeta().billingSet, false);
    assert.equal(store.menuMeta().billing.taxRate, 0);
    store.setMenuMeta({ billing: { ...DEFAULT_BILLING, taxRate: 5, taxLabel: 'VAT', taxId: 'TRN 100' } });
    assert.equal(store.menuMeta().billingSet, true);
    assert.equal(store.menuMeta().billing.taxId, 'TRN 100');
  });
});

test('a bill adds up, merges repeat dishes, keeps its number on reprint and gets a new one when orders change', () => {
  withStore((store) => {
    setMenuMeta({ billing: { taxRate: 5, taxLabel: 'VAT', serviceRate: 10 } });
    store.addToCart('T1', 'tiramisu', 1, []);
    store.placeOrder('T1');
    store.addToCart('T1', 'tiramisu', 2, []);
    store.addToCart('T1', 'brulee', 1, []);
    store.placeOrder('T1');
    const bill = store.createBill('T1', { restaurant: 'Tayeb' });
    assert.equal(bill.number, 1);
    assert.equal(bill.restaurant, 'Tayeb');
    assert.deepEqual(bill.lines.map((l) => [l.name, l.qty]), [['Classic Tiramisu', 3], ['Vanilla Bean Crème Brûlée', 1]]);
    assert.equal(bill.subtotal, 3 * 12 + 11);
    assert.equal(bill.total, Math.round((bill.subtotal + bill.service + bill.tax) * 100) / 100);
    assert.equal(store.createBill('T1', { restaurant: 'Tayeb' }).number, 1, 'printing again keeps the number');

    store.addToCart('T1', 'brulee', 1, []);
    store.placeOrder('T1');
    assert.equal(store.createBill('T1', { restaurant: 'Tayeb' }).number, 2, 'a changed bill is a new bill');
    // Once paid, nothing is open: the last bill can still be printed as a copy.
    store.addRequest('T1', 'bill', 'Bill', 1);
    store.setRequestStatus(store.requests('T1')[0].id, 'done');
    const copy = store.createBill('T1', { restaurant: 'Tayeb' });
    assert.equal(copy.number, 2);
    assert.equal(copy.reprint, true);
    assert.equal(store.createBill('T2', { restaurant: 'Tayeb' }), null);
  });
});

test('a table can be held by one device at a time, until staff release it', () => {
  withStore((store) => {
    assert.equal(store.claimTable('T1', 'device-a'), true);
    assert.equal(store.claimTable('T1', 'device-b'), false);
    assert.equal(store.claimOf('T1').tokenHash, 'device-a');
    assert.deepEqual(store.claimedBy('device-a'), ['T1']);
    assert.equal(store.releaseTable('T1'), true);
    assert.equal(store.claimTable('T1', 'device-b'), true);
    assert.deepEqual(store.claimedBy('device-a'), []);
  });
});

test('a database from before sizes and service charges upgrades in place', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tazte-upgrade-test-'));
  const file = path.join(directory, 'restaurant.db');
  let store = createStore(file);
  try {
    store.addToCart('T1', 'tiramisu', 1, []);
    store.placeOrder('T1');
    store.addToCart('T2', 'brulee', 1, []);
    for (const [t, c] of [['cart_lines', 'size'], ['orders', 'service'], ['orders', 'billing']]) store.db.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    store.db.close();
    store = createStore(file);
    assert.equal(store.tableOrders('T1')[0].service, 0);
    assert.equal(store.tableOrders('T1')[0].billing, null);
    assert.equal(store.cart('T2')[0].size, null);
    assert.ok(store.createBill('T1', { restaurant: 'Old' }).total > 0, 'old orders can still be billed');
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('menu import: named sizes, size columns, and ranges left for staff to decide', () => {
  const named = parseMenuText('BIRYANI:\nMutton Biryani  Half 120 / Full 220\nChicken Biryani - Half: 100, Full: 180\nFries   Small $4  Large $6');
  assert.deepEqual(named.rows[0].sizes, [{ label: 'Half', price: 120 }, { label: 'Full', price: 220 }]);
  assert.equal(named.rows[0].name, 'Mutton Biryani');
  assert.equal(named.rows[0].price, 120);
  assert.equal(named.rows[1].name, 'Chicken Biryani');
  assert.deepEqual(named.rows[2].sizes, [{ label: 'Small', price: 4 }, { label: 'Large', price: 6 }]);

  const columns = parseMenuText('CURRIES   Half   Full\nButter Chicken   150   280\nChicken 65   140   260');
  assert.deepEqual(columns.rows.map((r) => [r.name, r.sizes.map((s) => `${s.label} ${s.price}`).join(', ')]), [
    ['Butter Chicken', 'Half 150, Full 280'], ['Chicken 65', 'Half 140, Full 260'],
  ]);
  assert.deepEqual(columns.sections.map((s) => s.label), ['Curries']);

  const range = parseMenuText('Mutton Dum Biryani\tAED 31.00 – 38.00').rows[0];
  assert.deepEqual(range.priceRange, [31, 38]);
  assert.equal(range.sizes, undefined, "a range doesn't say what its prices are for");

  const unnamed = parseMenuText('Paneer Tikka\t120\t220').rows[0];
  assert.deepEqual(unnamed.sizes.map((s) => s.price), [120, 220]);
  assert.match(unnamed.priceNote, /guess/);

  const one = parseMenuText('Tandoori Chicken (Full)\tAED 49.00\nChicken 65 Dry\tAED 24.00').rows;
  assert.deepEqual(one.map((r) => [r.name, r.price, r.sizes]), [['Tandoori Chicken (Full)', 49, undefined], ['Chicken 65 Dry', 24, undefined]]);
});
