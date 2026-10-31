// SQLite-backed store shared by the customer app and the restaurant dashboard.
// Every write goes through here; callers broadcast the change afterwards.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { SEED_MENU, CATEGORIES, totals, priceLine } from '../shared/engine.js';

const now = () => Date.now();
const id = (p) => p + randomBytes(4).toString('hex').toUpperCase();
const json = (v) => JSON.stringify(v);

export function createStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY, sort INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cart_lines (
      id TEXT PRIMARY KEY, table_id TEXT NOT NULL,
      item_id TEXT NOT NULL REFERENCES menu_items(id),
      qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 10),
      mods TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cart_by_table ON cart_lines(table_id);
    CREATE TABLE IF NOT EXISTS table_notes (table_id TEXT PRIMARY KEY, note TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS table_statuses (
      table_id TEXT PRIMARY KEY, occupied INTEGER NOT NULL DEFAULT 0 CHECK (occupied IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, table_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('received','kitchen','served')),
      created_at INTEGER NOT NULL, kitchen_at INTEGER, served_at INTEGER,
      prep_mins INTEGER NOT NULL, note TEXT NOT NULL, lines TEXT NOT NULL,
      subtotal REAL NOT NULL, tax REAL NOT NULL, total REAL NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS orders_by_table ON orders(table_id, paid);
    CREATE TABLE IF NOT EXISTS service_requests (
      id TEXT PRIMARY KEY, table_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('server','bill')),
      detail TEXT NOT NULL, split INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('open','acknowledged','done')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS security_log (
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, table_id TEXT NOT NULL,
      type TEXT NOT NULL, kind TEXT NOT NULL, input TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS staff_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const q = (sql) => db.prepare(sql);
  const tx = (fn) => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(...args); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  if (!q('SELECT COUNT(*) n FROM menu_items').get().n) {
    tx(() => SEED_MENU.forEach((m, i) => q('INSERT INTO menu_items (id, sort, data) VALUES (?, ?, ?)').run(m.id, i, json(m))))();
  }

  // ---------- menu ----------
  const menu = () => q('SELECT data FROM menu_items ORDER BY sort').all().map((r) => JSON.parse(r.data));
  const item = (itemId) => { const r = q('SELECT data FROM menu_items WHERE id = ?').get(itemId); return r ? JSON.parse(r.data) : null; };
  const saveItem = (m) => q('UPDATE menu_items SET data = ? WHERE id = ?').run(json(m), m.id);

  const updateItem = tx((itemId, patch) => {
    const m = item(itemId);
    if (!m) return null;
    const next = { ...m, ...patch };
    if (patch.vegan) next.diet = 'veg';
    if (patch.diet === 'nonveg') next.vegan = false;
    saveItem(next);
    return next;
  });

  const publishItems = tx((rows) => {
    let sort = q('SELECT COALESCE(MAX(sort), 0) s FROM menu_items').get().s;
    const taken = new Set(menu().map((m) => m.name.toLowerCase()));
    const added = [];
    for (const r of rows) {
      if (taken.has(r.name.toLowerCase())) continue;
      taken.add(r.name.toLowerCase());
      const m = { ...r, id: id('dish-').toLowerCase(), rating: null, reviews: 0, prep: 15, img: null, aliases: [], available: true, isNew: true };
      q('INSERT INTO menu_items (id, sort, data) VALUES (?, ?, ?)').run(m.id, ++sort, json(m));
      added.push(m);
    }
    return added;
  });

  // ---------- carts ----------
  const cart = (table) => q('SELECT id, item_id, qty, mods FROM cart_lines WHERE table_id = ? ORDER BY created_at')
    .all(table).map((r) => ({ id: r.id, itemId: r.item_id, qty: r.qty, mods: JSON.parse(r.mods) }));
  const note = (table) => (q('SELECT note FROM table_notes WHERE table_id = ?').get(table) || {}).note || '';

  const addToCart = tx((table, itemId, qty, mods) => {
    const key = [...mods].sort().join(',');
    const same = cart(table).find((l) => l.itemId === itemId && [...l.mods].sort().join(',') === key);
    if (same) q('UPDATE cart_lines SET qty = ? WHERE id = ?').run(Math.min(10, same.qty + qty), same.id);
    else q('INSERT INTO cart_lines (id, table_id, item_id, qty, mods, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id('L'), table, itemId, qty, json(mods), now());
  });
  const changeQty = tx((table, lineId, delta) => {
    const l = q('SELECT qty FROM cart_lines WHERE id = ? AND table_id = ?').get(lineId, table);
    if (!l) return false;
    const n = Math.min(10, l.qty + delta);
    if (n <= 0) q('DELETE FROM cart_lines WHERE id = ?').run(lineId);
    else q('UPDATE cart_lines SET qty = ? WHERE id = ?').run(n, lineId);
    return true;
  });
  const removeLine = (table, lineId) => q('DELETE FROM cart_lines WHERE id = ? AND table_id = ?').run(lineId, table).changes > 0;
  const removeItem = (table, itemId) => q('DELETE FROM cart_lines WHERE item_id = ? AND table_id = ?').run(itemId, table).changes > 0;
  const setNote = (table, text) => q('INSERT INTO table_notes (table_id, note) VALUES (?, ?) ON CONFLICT(table_id) DO UPDATE SET note = excluded.note').run(table, text);
  const tableStatuses = (tables) => Object.fromEntries(tables.map((table) => {
    const row = q('SELECT occupied FROM table_statuses WHERE table_id = ?').get(table);
    return [table, !!row?.occupied];
  }));
  const setTableOccupied = tx((table, occupied) =>
    q('INSERT INTO table_statuses (table_id, occupied) VALUES (?, ?) ON CONFLICT(table_id) DO UPDATE SET occupied = excluded.occupied')
      .run(table, occupied ? 1 : 0));
  const clearTable = (table) => {
    q('DELETE FROM cart_lines WHERE table_id = ?').run(table);
    q('DELETE FROM table_notes WHERE table_id = ?').run(table);
  };
  const resetTable = tx(clearTable);

  // ---------- orders ----------
  const rowToOrder = (r) => ({
    id: r.id, table: r.table_id, status: r.status, createdAt: r.created_at, kitchenAt: r.kitchen_at, servedAt: r.served_at,
    prepMins: r.prep_mins, note: r.note, lines: JSON.parse(r.lines), subtotal: r.subtotal, tax: r.tax, total: r.total, paid: !!r.paid,
  });
  const tableOrders = (table) => q('SELECT * FROM orders WHERE table_id = ? AND paid = 0 ORDER BY created_at DESC').all(table).map(rowToOrder);
  const recentOrders = () => q('SELECT * FROM orders WHERE status != ? OR served_at > ? ORDER BY created_at DESC LIMIT 100').all('served', now() - 3 * 3600e3).map(rowToOrder);

  // Prices come only from the menu table, never from the client.
  const placeOrder = tx((table) => {
    const m = menu();
    const lines = cart(table).filter((l) => (m.find((x) => x.id === l.itemId) || {}).available);
    if (!lines.length) return null;
    const t = totals(m, lines);
    const items = lines.map((l) => m.find((x) => x.id === l.itemId));
    const seq = q('SELECT COALESCE(MAX(seq), 2040) s FROM orders').get().s + 1;
    const order = {
      id: 'ORD-' + seq, prepMins: Math.min(45, Math.max(...items.map((i) => i.prep)) + (lines.length - 1) * 2),
      lines: lines.map((l) => { const p = priceLine(m, l); return { itemId: l.itemId, name: m.find((x) => x.id === l.itemId).name, qty: l.qty, mods: l.mods, unit: p.unit, total: p.total }; }),
    };
    q(`INSERT INTO orders (id, seq, table_id, status, created_at, prep_mins, note, lines, subtotal, tax, total)
       VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?)`).run(order.id, seq, table, now(), order.prepMins, note(table), json(order.lines), t.subtotal, t.tax, t.total);
    clearTable(table);
    return order.id;
  });
  const advanceOrder = (orderId) => {
    const r = q('SELECT status FROM orders WHERE id = ?').get(orderId);
    if (!r) return false;
    if (r.status === 'received') q("UPDATE orders SET status = 'kitchen', kitchen_at = ? WHERE id = ?").run(now(), orderId);
    else if (r.status === 'kitchen') q("UPDATE orders SET status = 'served', served_at = ? WHERE id = ?").run(now(), orderId);
    return true;
  };

  // ---------- service requests ----------
  const rowToReq = (r) => ({ id: r.id, table: r.table_id, type: r.type, detail: r.detail, split: r.split, status: r.status, at: r.created_at });
  const requests = (table) => (table
    ? q("SELECT * FROM service_requests WHERE table_id = ? AND (status != 'done' OR created_at > ?) ORDER BY created_at DESC").all(table, now() - 600e3)
    : q("SELECT * FROM service_requests WHERE status != 'done' OR created_at > ? ORDER BY created_at DESC LIMIT 100").all(now() - 3 * 3600e3)
  ).map(rowToReq);
  const addRequest = (table, type, detail, split = 1) =>
    q("INSERT INTO service_requests (id, table_id, type, detail, split, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)").run(id('REQ-'), table, type, detail, split, now());
  // Closing a bill request settles that table's open orders.
  const setRequestStatus = tx((reqId, status) => {
    const r = q('SELECT * FROM service_requests WHERE id = ?').get(reqId);
    if (!r) return false;
    q('UPDATE service_requests SET status = ? WHERE id = ?').run(status, reqId);
    if (r.type === 'bill' && status === 'done') {
      q('UPDATE orders SET paid = 1 WHERE table_id = ? AND created_at <= ?').run(r.table_id, r.created_at);
      q('INSERT INTO table_statuses (table_id, occupied) VALUES (?, 0) ON CONFLICT(table_id) DO UPDATE SET occupied = 0').run(r.table_id);
    }
    return true;
  });

  // ---------- security log ----------
  const logSecurity = (e) => {
    q('INSERT INTO security_log (id, at, table_id, type, kind, input, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id('SEC-'), now(), e.table, e.type, e.kind, String(e.input).slice(0, 240), e.detail);
    q('DELETE FROM security_log WHERE id NOT IN (SELECT id FROM security_log ORDER BY at DESC LIMIT 500)').run();
  };
  const security = () => q('SELECT * FROM security_log ORDER BY at DESC LIMIT 100').all()
    .map((r) => ({ id: r.id, at: r.at, table: r.table_id, type: r.type, kind: r.kind, input: r.input, detail: r.detail }));

  // ---------- staff auth ----------
  const setting = (key, value) => {
    if (value === undefined) return (q('SELECT value FROM settings WHERE key = ?').get(key) || {}).value;
    q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  };
  const addSession = (hash, ttlMs) => { q('DELETE FROM staff_sessions WHERE expires_at < ?').run(now()); q('INSERT INTO staff_sessions VALUES (?, ?)').run(hash, now() + ttlMs); };
  const hasSession = (hash) => !!q('SELECT 1 FROM staff_sessions WHERE token_hash = ? AND expires_at > ?').get(hash, now());
  const dropSession = (hash) => q('DELETE FROM staff_sessions WHERE token_hash = ?').run(hash);

  return {
    db, menu, item, updateItem, publishItems, cart, note, addToCart, changeQty, removeLine, removeItem, setNote, resetTable,
    tableOrders, recentOrders, placeOrder, advanceOrder, requests, addRequest, setRequestStatus, tableStatuses, setTableOccupied, logSecurity, security,
    setting, addSession, hasSession, dropSession, categories: CATEGORIES,
  };
}
