// SQLite-backed store shared by the customer app and the restaurant dashboard.
// Every write goes through here; callers broadcast the change afterwards.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { SEED_MENU, DEFAULT_BILLING, billing, totals, priceLine, sizeOf, hasSizes, withSize } from '../shared/engine.js';

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
    -- The one device each table belongs to, until staff release it. Only a hash of its token is kept.
    CREATE TABLE IF NOT EXISTS table_claims (
      table_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, claimed_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
    );
    -- Printed bills: numbered in order, each with a copy of what it said.
    CREATE TABLE IF NOT EXISTS bills (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, table_id TEXT NOT NULL, created_at INTEGER NOT NULL, order_ids TEXT NOT NULL, data TEXT NOT NULL
    );
    DROP TABLE IF EXISTS devices; -- tablet pairing was removed
    DROP TABLE IF EXISTS pairing_codes;
    CREATE TABLE IF NOT EXISTS allergen_log (
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, table_id TEXT NOT NULL, item_name TEXT NOT NULL, allergen TEXT NOT NULL,
      answer TEXT NOT NULL CHECK (answer IN ('contains', 'free', 'unknown'))
    );
  `);

  const q = (sql) => db.prepare(sql);
  // Columns added after the first release, for databases that already exist.
  const addColumn = (table, column, type) => {
    if (!q(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn('cart_lines', 'size', 'TEXT');
  addColumn('orders', 'service', 'REAL NOT NULL DEFAULT 0');
  addColumn('orders', 'billing', 'TEXT');
  const tx = (fn) => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(...args); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  if (!q('SELECT COUNT(*) n FROM menu_items').get().n) {
    tx(() => SEED_MENU.forEach((m, i) => q('INSERT INTO menu_items (id, sort, data) VALUES (?, ?, ?)').run(m.id, i, json(m))))();
  }

  if (!q('SELECT value FROM settings WHERE key = ?').get('table_occupancy_order_v1')) {
    q(`UPDATE table_statuses
       SET occupied = CASE WHEN EXISTS (
         SELECT 1 FROM orders WHERE orders.table_id = table_statuses.table_id AND orders.paid = 0
       ) THEN 1 ELSE 0 END`).run();
    q('INSERT INTO settings (key, value) VALUES (?, ?)').run('table_occupancy_order_v1', '1');
  }

  // ---------- menu ----------
  const menu = () => q('SELECT data FROM menu_items ORDER BY sort').all().map((r) => JSON.parse(r.data));
  const item = (itemId) => { const r = q('SELECT data FROM menu_items WHERE id = ?').get(itemId); return r ? JSON.parse(r.data) : null; };
  const saveItem = (m) => q('UPDATE menu_items SET data = ? WHERE id = ?').run(json(m), m.id);

  const updateItem = tx((itemId, patch) => {
    const m = item(itemId);
    if (!m) return null;
    const next = { ...m, ...patch };
    if (patch.vegan || patch.jain) next.diet = 'veg';
    if (patch.diet === 'nonveg') { next.vegan = false; next.jain = false; }
    saveItem(next);
    // Carts can't keep a size that no longer exists, or a line without one on a dish that now needs it.
    if ('sizes' in patch && hasSizes(next)) {
      for (const l of q('SELECT id, size FROM cart_lines WHERE item_id = ?').all(itemId)) {
        if (!sizeOf(next, l.size)) q('DELETE FROM cart_lines WHERE id = ?').run(l.id);
      }
    }
    return next;
  });

  const insertItems = (rows) => {
    let sort = q('SELECT COALESCE(MAX(sort), 0) s FROM menu_items').get().s;
    const taken = new Set(menu().map((m) => m.name.toLowerCase()));
    const added = [];
    for (const r of rows) {
      if (taken.has(r.name.toLowerCase())) continue;
      taken.add(r.name.toLowerCase());
      const m = { aliases: [], ...r, id: id('dish-').toLowerCase(), rating: null, reviews: 0, prep: 15, img: null, available: true, isNew: true };
      q('INSERT INTO menu_items (id, sort, data) VALUES (?, ?, ?)').run(m.id, ++sort, json(m));
      added.push(m);
    }
    return added;
  };
  const publishItems = tx(insertItems);
  // An imported menu that replaces the whole menu. Carts held the old dishes, so they are emptied;
  // orders already sent keep their own copy of each line.
  const replaceMenu = tx((rows) => {
    q('DELETE FROM menu_items').run();
    q('DELETE FROM cart_lines').run();
    return insertItems(rows);
  });

  // The restaurant's currency, imported menu sections ([{ id, label }]) and tax and bill details.
  // billingSet stays false until staff save those details, so the dashboard can ask for them.
  const menuMeta = () => {
    let sections = [];
    let saved = null;
    try { sections = JSON.parse(setting('menu_sections') || '[]'); } catch { /* keep none */ }
    try { saved = JSON.parse(setting('billing') || 'null'); } catch { /* keep none */ }
    return { currency: setting('currency') || 'USD', sections, billing: { ...DEFAULT_BILLING, ...saved }, billingSet: !!saved };
  };
  const setMenuMeta = ({ currency, sections, billing: details }) => {
    if (currency) setting('currency', currency);
    if (sections) setting('menu_sections', JSON.stringify(sections));
    if (details) setting('billing', JSON.stringify(details));
  };

  // ---------- carts ----------
  const cart = (table) => q('SELECT id, item_id, qty, mods, size FROM cart_lines WHERE table_id = ? ORDER BY created_at')
    .all(table).map((r) => ({ id: r.id, itemId: r.item_id, qty: r.qty, mods: JSON.parse(r.mods), size: r.size || null }));
  const note = (table) => (q('SELECT note FROM table_notes WHERE table_id = ?').get(table) || {}).note || '';

  const writeToCart = (table, itemId, qty, mods, size = null) => {
    const key = [...mods].sort().join(',');
    const same = cart(table).find((l) => l.itemId === itemId && l.size === size && [...l.mods].sort().join(',') === key);
    if (same) q('UPDATE cart_lines SET qty = ? WHERE id = ?').run(Math.min(10, same.qty + qty), same.id);
    else q('INSERT INTO cart_lines (id, table_id, item_id, qty, mods, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id('L'), table, itemId, Math.min(10, qty), json(mods), size, now());
  };
  const addToCart = tx(writeToCart);
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
  const writeTableOccupied = (table, occupied) =>
    q('INSERT INTO table_statuses (table_id, occupied) VALUES (?, ?) ON CONFLICT(table_id) DO UPDATE SET occupied = excluded.occupied')
      .run(table, occupied ? 1 : 0);
  const setTableOccupied = tx(writeTableOccupied);
  const clearTable = (table) => {
    q('DELETE FROM cart_lines WHERE table_id = ?').run(table);
    q('DELETE FROM table_notes WHERE table_id = ?').run(table);
  };
  const resetTable = tx(clearTable);

  // ---------- orders ----------
  const rowToOrder = (r) => ({
    id: r.id, table: r.table_id, status: r.status, createdAt: r.created_at, kitchenAt: r.kitchen_at, servedAt: r.served_at,
    prepMins: r.prep_mins, note: r.note, lines: JSON.parse(r.lines), subtotal: r.subtotal, service: r.service, tax: r.tax, total: r.total, paid: !!r.paid,
    billing: r.billing ? JSON.parse(r.billing) : null,
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
      lines: lines.map((l) => { const p = priceLine(m, l); const it = m.find((x) => x.id === l.itemId); return { itemId: l.itemId, name: withSize(it.name, it, l.size), size: l.size, qty: l.qty, mods: l.mods, unit: p.unit, total: p.total }; }),
    };
    // Each order keeps the amounts and rates it was sent with, whatever staff change later.
    const { taxRate, taxLabel, taxIncluded, serviceRate } = billing();
    q(`INSERT INTO orders (id, seq, table_id, status, created_at, prep_mins, note, lines, subtotal, service, tax, total, billing)
       VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(order.id, seq, table, now(), order.prepMins, note(table), json(order.lines), t.subtotal, t.service, t.tax, t.total, json({ taxRate, taxLabel, taxIncluded, serviceRate }));
    writeTableOccupied(table, true);
    clearTable(table);
    return order.id;
  });
  // A guest may take an order back shortly after sending it, as long as the kitchen hasn't started it.
  // Its dishes go back into the cart so they can be changed.
  const cancelOrder = tx((table, orderId, windowMs) => {
    const r = q('SELECT * FROM orders WHERE id = ? AND table_id = ? AND paid = 0').get(orderId, table);
    if (!r) return { ok: false, reason: 'not_found' };
    if (r.status !== 'received' || r.created_at < now() - windowMs) return { ok: false, reason: 'too_late' };
    for (const l of JSON.parse(r.lines)) {
      const it = item(l.itemId);
      if (!it || (hasSizes(it) && !sizeOf(it, l.size))) continue;
      writeToCart(table, l.itemId, l.qty, l.mods, sizeOf(it, l.size) ? l.size : null);
    }
    if (r.note) setNote(table, note(table) ? `${note(table)}; ${r.note}` : r.note);
    q('DELETE FROM orders WHERE id = ?').run(orderId);
    return { ok: true, id: orderId };
  });
  const latestOrder = (table) => {
    const r = q('SELECT * FROM orders WHERE table_id = ? AND paid = 0 ORDER BY created_at DESC LIMIT 1').get(table);
    return r ? rowToOrder(r) : null;
  };
  const advanceOrder = (orderId) => {
    const r = q('SELECT status FROM orders WHERE id = ?').get(orderId);
    if (!r) return false;
    if (r.status === 'received') q("UPDATE orders SET status = 'kitchen', kitchen_at = ? WHERE id = ?").run(now(), orderId);
    else if (r.status === 'kitchen') q("UPDATE orders SET status = 'served', served_at = ? WHERE id = ?").run(now(), orderId);
    return true;
  };

  // ---------- printed bills ----------
  // The bill for a table's open orders. Printing it again keeps its number; orders added or taken back
  // since then make it a new bill. With nothing open, the table's last bill can be printed again.
  const createBill = tx((table, { restaurant }) => {
    const orders = tableOrders(table).reverse();
    const last = q('SELECT * FROM bills WHERE table_id = ? ORDER BY seq DESC LIMIT 1').get(table);
    if (!orders.length) return last ? { ...JSON.parse(last.data), reprint: true } : null;
    const ids = json(orders.map((o) => o.id));
    const open = q("SELECT split FROM service_requests WHERE table_id = ? AND type = 'bill' AND status != 'done' ORDER BY created_at DESC LIMIT 1").get(table);
    const split = open ? open.split : 1;
    if (last && last.order_ids === ids) {
      const again = { ...JSON.parse(last.data), split };
      q('UPDATE bills SET data = ? WHERE seq = ?').run(json(again), last.seq);
      return again;
    }
    const merged = new Map();
    for (const l of orders.flatMap((o) => o.lines)) {
      const key = `${l.itemId}|${l.size || ''}|${[...l.mods].sort().join(',')}`;
      const m = merged.get(key);
      if (m) { m.qty += l.qty; m.total += l.total; } else merged.set(key, { name: l.name, mods: l.mods, qty: l.qty, unit: l.unit, total: l.total });
    }
    const sum = (k) => Math.round(orders.reduce((s, o) => s + o[k], 0) * 100) / 100;
    // The rates to print, when all the orders were sent with the same ones.
    const rates = orders.map((o) => json(o.billing));
    const details = menuMeta().billing;
    const at = now();
    const data = {
      table, at, orders: orders.map((o) => o.id), restaurant, address: details.address, taxId: details.taxId, footer: details.footer,
      lines: [...merged.values()], subtotal: sum('subtotal'), service: sum('service'), tax: sum('tax'), total: sum('total'), split,
      billing: new Set(rates).size === 1 ? orders[0].billing : null, taxLabel: (orders[orders.length - 1].billing || details).taxLabel,
    };
    const { lastInsertRowid } = q('INSERT INTO bills (table_id, created_at, order_ids, data) VALUES (?, ?, ?, ?)').run(table, at, ids, json(data));
    data.number = Number(lastInsertRowid);
    q('UPDATE bills SET data = ? WHERE seq = ?').run(json(data), lastInsertRowid);
    return data;
  });

  // ---------- table claims ----------
  // A table belongs to the first device that opens it, until staff release it.
  const claimOf = (table) => {
    const r = q('SELECT token_hash, claimed_at, last_seen FROM table_claims WHERE table_id = ?').get(table);
    return r ? { tokenHash: r.token_hash, claimedAt: r.claimed_at, lastSeen: r.last_seen } : null;
  };
  const claimedBy = (tokenHash) => q('SELECT table_id FROM table_claims WHERE token_hash = ? ORDER BY claimed_at').all(tokenHash).map((r) => r.table_id);
  const claimTable = tx((table, tokenHash) => {
    if (claimOf(table)) return false;
    q('INSERT INTO table_claims (table_id, token_hash, claimed_at, last_seen) VALUES (?, ?, ?, ?)').run(table, tokenHash, now(), now());
    return true;
  });
  const touchClaim = (table) => q('UPDATE table_claims SET last_seen = ? WHERE table_id = ? AND last_seen < ?').run(now(), table, now() - 60e3);
  const releaseTable = (table) => q('DELETE FROM table_claims WHERE table_id = ?').run(table).changes > 0;
  const claims = () => Object.fromEntries(q('SELECT table_id, claimed_at, last_seen FROM table_claims').all()
    .map((r) => [r.table_id, { claimedAt: r.claimed_at, lastSeen: r.last_seen }]));

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
  const dropAllSessions = () => q('DELETE FROM staff_sessions').run();

  // ---------- allergy questions ----------
  // A record of what each table was told, so staff can see it and follow up.
  const logAllergen = (table, itemName, allergen, answer) => {
    q('INSERT INTO allergen_log (id, at, table_id, item_name, allergen, answer) VALUES (?, ?, ?, ?, ?, ?)').run(id('ALG-'), now(), table, itemName, allergen, answer);
    q('DELETE FROM allergen_log WHERE at < ?').run(now() - 30 * 864e5);
  };
  const allergenLog = () => q('SELECT * FROM allergen_log ORDER BY at DESC LIMIT 60').all()
    .map((r) => ({ id: r.id, at: r.at, table: r.table_id, item: r.item_name, allergen: r.allergen, answer: r.answer }));

  // ---------- backups ----------
  // VACUUM INTO writes a consistent copy even while the server keeps working.
  const backupTo = (file) => db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

  return {
    db, menu, item, updateItem, publishItems, replaceMenu, menuMeta, setMenuMeta, cart, note, addToCart, changeQty, removeLine, removeItem, setNote, resetTable,
    tableOrders, recentOrders, placeOrder, cancelOrder, latestOrder, advanceOrder, requests, addRequest, setRequestStatus, tableStatuses, setTableOccupied,
    logSecurity, security, setting, addSession, hasSession, dropSession, dropAllSessions,
    logAllergen, allergenLog, backupTo, createBill, claimOf, claimedBy, claimTable, touchClaim, releaseTable, claims,
  };
}
