import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStore } from '../server/store.js';

function withStore(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tazte-store-test-'));
  const store = createStore(path.join(directory, 'restaurant.db'));
  try {
    return run(store);
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a table becomes occupied only after an order is placed', () => {
  withStore((store) => {
    assert.deepEqual(store.tableStatuses(['T1']), { T1: false });
    assert.equal(store.placeOrder('T1'), null);
    assert.deepEqual(store.tableStatuses(['T1']), { T1: false });

    store.addToCart('T1', store.menu()[0].id, 1, []);
    assert.deepEqual(store.tableStatuses(['T1']), { T1: false });
    assert.ok(store.placeOrder('T1'));
    assert.deepEqual(store.tableStatuses(['T1']), { T1: true });
  });
});

test('staff can manually change table occupancy', () => {
  withStore((store) => {
    store.setTableOccupied('T1', true);
    assert.deepEqual(store.tableStatuses(['T1']), { T1: true });
    store.setTableOccupied('T1', false);
    assert.deepEqual(store.tableStatuses(['T1']), { T1: false });
  });
});

test('existing session-only occupancy is reconciled while unpaid orders stay occupied', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tazte-store-migration-test-'));
  const file = path.join(directory, 'restaurant.db');
  let store = createStore(file);
  try {
    store.setTableOccupied('T1', true);
    store.addToCart('T2', store.menu()[0].id, 1, []);
    store.placeOrder('T2');
    store.db.prepare('DELETE FROM settings WHERE key = ?').run('table_occupancy_order_v1');
    store.db.close();

    store = createStore(file);
    assert.deepEqual(store.tableStatuses(['T1', 'T2']), { T1: false, T2: true });
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
