// Shared backend for the two Tazte apps: the customer tablet app (customer-app/, served at /table/:n)
// and the staff dashboard (staff-app/, served at /restaurant). One process, one SQLite database, with live
// updates pushed to both over Server-Sent Events.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createAssistant } from './assistant.js';
import { createWhisper } from './whisper.js';
import { createLicense } from './license.js';
import { createBackups } from './backup.js';
import { validateCall, CATEGORIES, ALLERGEN_KEYS, UNDO_MS } from '../shared/engine.js';
import { isLang } from '../shared/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file; use the real environment */ }
const PORT = Number(process.env.PORT) || 3000;
// Where people reach this server, if that differs from PORT (e.g. behind the root `npm run dev` proxy).
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'flavoria.db');
const SESSION_TTL = 12 * 3600e3;

await mkdir(path.dirname(DB_FILE), { recursive: true });
const store = createStore(DB_FILE);
const assistant = createAssistant(store);
const whisper = createWhisper(ROOT);
const transcribeStamps = new Map(); // table -> timestamps, caps GPU work per tablet
const TRANSCRIBE_LIMIT = 12;
const speakStamps = new Map(); // table -> timestamps for spoken replies
const SPEAK_LIMIT = 30;
// Over the restaurant's voice limit, each table gets one voice turn every SLOW_MS instead of being
// cut off; ordering by touch and the staff dashboard are never limited.
const SLOW_MS = 20000;
const slowStamps = new Map(); // table -> last voice turn allowed while throttled
const slowTickets = new Map(); // table -> a transcribed turn whose assistant call may follow
function slowLane(table, { ticket = false } = {}) {
  if (license.status().usage !== 'throttled') return 0;
  if (ticket && Date.now() - (slowTickets.get(table) || 0) < 30000) { slowTickets.delete(table); return 0; }
  const wait = (slowStamps.get(table) || 0) + SLOW_MS - Date.now();
  if (wait > 0) return Math.ceil(wait / 1000);
  slowStamps.set(table, Date.now());
  return 0;
}
const tableList = (count) => Array.from({ length: count }, (_, i) => 'T' + (i + 1));
const envTableCount = Number(process.env.TABLE_COUNT);
const savedTableCount = Number(store.setting('table_count'));
let TABLE_COUNT = Number.isInteger(savedTableCount) && savedTableCount >= 1 && savedTableCount <= 99
  ? savedTableCount
  : Number.isInteger(envTableCount) && envTableCount >= 1 && envTableCount <= 99 ? envTableCount : 8;
let TABLES = tableList(TABLE_COUNT);
store.setting('table_count', String(TABLE_COUNT));

// ---------- restaurant licence (admin app) ----------
// Suspending, flagging or an unpaid plan closes every staff session and live screen at once.
const license = createLicense(store, {
  url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY, name: process.env.RESTAURANT_NAME || 'Restaurant',
  onBlock: (s) => {
    store.dropAllSessions();
    for (const c of clients) c.res.end();
    clients.clear();
    console.log(`[license] Service ${s.state}: staff sessions and live screens closed.`);
  },
});
const suspended = (res, s) => send(res, 403, { error: 'service_suspended', state: s.state });

// ---------- staff PIN ----------
// Licensed: the 6-digit PIN set in the admin app, checked by Supabase. Standalone: STAFF_PIN.
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const staffPin = process.env.STAFF_PIN ?? '1801';
let pinHash = sha(staffPin);
store.setting('staff_pin_hash', pinHash);
if (!license.licensed && !process.env.STAFF_PIN) {
  console.log(`\n  Using default staff PIN: ${staffPin}  (set STAFF_PIN to choose your own)\n`);
}
const pinOk = (pin) => timingSafeEqual(Buffer.from(sha(pin), 'hex'), Buffer.from(pinHash, 'hex'));
const loginAttempts = new Map(); // ip -> timestamps
const allowAttempt = (req) => {
  const ip = req.socket.remoteAddress;
  const recent = (loginAttempts.get(ip) || []).filter((t) => Date.now() - t < 60000);
  if (recent.length >= 5) return false;
  recent.push(Date.now()); loginAttempts.set(ip, recent);
  return true;
};

// ---------- backups ----------
const backups = createBackups(store, {
  dir: process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups'),
  copyDir: process.env.BACKUP_COPY_DIR || '', keep: Number(process.env.BACKUP_KEEP) || 14,
  hour: /^\d{1,2}$/.test(process.env.BACKUP_HOUR || '') ? Number(process.env.BACKUP_HOUR) : 3,
});

// ---------- tablet settings (staff dashboard) ----------
// vad: 'normal', or 'noisy' for stricter speech detection and hold-to-talk in a loud room.
// voicePrivacy: 'standard', or 'offline' to keep all speech on this computer (no Google voices and
// no browser speech recognition).
const tabletSettings = () => ({
  vad: store.setting('tablet_vad') === 'noisy' ? 'noisy' : 'normal',
  voicePrivacy: store.setting('voice_privacy') === 'offline' ? 'offline' : 'standard',
});

// ---------- live updates (SSE) ----------
const clients = new Set();
const tableSnapshot = (t) => ({ table: t, menu: store.menu(), cart: store.cart(t), note: store.note(t), orders: store.tableOrders(t), requests: store.requests(t), usage: assistant.usage(t), now: Date.now() });
const adminSnapshot = () => ({
  tables: TABLES, menu: store.menu(), orders: store.recentOrders(), requests: store.requests(), security: store.security(),
  occupancy: store.tableStatuses(TABLES), settings: tabletSettings(),
  backup: backups.status(), allergenLog: store.allergenLog(), undoMs: UNDO_MS,
  carts: Object.fromEntries(TABLES.map((t) => [t, store.cart(t).reduce((s, l) => s + l.qty, 0)])), now: Date.now(),
});
let pending = null;
function broadcast() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    let admin = null;
    const perTable = new Map();
    for (const c of clients) {
      if (c.role === 'table' && !TABLES.includes(c.table)) {
        c.res.end();
        clients.delete(c);
        continue;
      }
      let data;
      if (c.role === 'table') {
        if (!perTable.has(c.table)) perTable.set(c.table, JSON.stringify(tableSnapshot(c.table)));
        data = perTable.get(c.table);
      } else data = admin || (admin = JSON.stringify(adminSnapshot()));
      c.res.write(`event: snapshot\ndata: ${data}\n\n`);
    }
  }, 40);
}
function openStream(req, res, client) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`retry: 2000\nevent: snapshot\ndata: ${JSON.stringify(client.role === 'table' ? tableSnapshot(client.table) : adminSnapshot())}\n\n`);
  const c = { res, ...client };
  clients.add(c);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(c); });
}
setInterval(() => clients.size && broadcast(), 30000); // keeps "x min ago" labels and rate-limit counters fresh

// ---------- http helpers ----------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: https://images.unsplash.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'",
};
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
};
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Send JSON.');
  let size = 0; const chunks = [];
  for await (const ch of req) { size += ch.length; if (size > 256 * 1024) throw new HttpError(413, 'Request too large.'); chunks.push(ch); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
async function readAudio(req, maxBytes) {
  if (!/^application\/octet-stream\b/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Send 16 kHz mono 16-bit PCM.');
  let size = 0; const chunks = [];
  for await (const ch of req) { size += ch.length; if (size > maxBytes) throw new HttpError(413, 'Recording too long.'); chunks.push(ch); }
  if (!size || size % 2) throw new HttpError(400, 'Empty or malformed recording.');
  return Buffer.concat(chunks);
}
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const isStaff = (req) => { const t = cookies(req).flv_staff; return !!t && store.hasSession(sha(t)); };
const secureCookie = (req) => (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '');
const sameOrigin = (req) => { try { return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; } catch { return false; } };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };
// The customer and staff apps each keep their own HTML + client source; only the built
// JS/CSS bundle output and the backend below are shared between them.
const CUSTOMER_PUBLIC = path.join(ROOT, 'customer-app', 'public');
const STAFF_PUBLIC = path.join(ROOT, 'staff-app', 'public');
const ASSETS = path.join(ROOT, 'public', 'assets');
async function serveFile(res, base, rel, cache = 'no-cache') {
  const file = path.join(base, rel);
  if (!file.startsWith(base + path.sep)) return send(res, 404, { error: 'Not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache, ...SECURITY_HEADERS });
    res.end(body);
  } catch { send(res, 404, { error: 'Not found' }); }
}

// ---------- validation for staff edits ----------
const CAT_IDS = CATEGORIES.map((c) => c.id).filter((c) => c !== 'all' && c !== 'specials');
const MEALS = ['breakfast', 'lunch', 'dinner'];
const str = (v, max, field) => (typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : bad(`${field} must be 1-${max} characters.`));
const money = (v) => (typeof v === 'number' && isFinite(v) && v >= 0.5 && v <= 500 ? Math.round(v * 100) / 100 : bad('Price must be between $0.50 and $500.'));
function itemPatch(body, itemId) {
  const p = {};
  if ('price' in body) p.price = money(body.price);
  if ('available' in body) p.available = body.available === true;
  if ('diet' in body) p.diet = ['veg', 'nonveg'].includes(body.diet) ? body.diet : bad('Diet must be veg or nonveg.');
  for (const k of ['vegan', 'gf', 'chefSpecial', 'jain', 'halal', 'allergensChecked']) if (k in body) p[k] = body[k] === true;
  if ('spicy' in body) p.spicy = [0, 1, 2, 3].includes(body.spicy) ? body.spicy : bad('Spice level must be 0-3.');
  if ('allergens' in body) {
    p.allergens = Array.isArray(body.allergens) && body.allergens.every((a) => ALLERGEN_KEYS.includes(a)) ? [...new Set(body.allergens)] : bad('Unknown allergen.');
  }
  // The dish the assistant suggests once alongside this one, chosen by the owner.
  if ('pairWith' in body) {
    p.pairWith = body.pairWith === null ? null
      : typeof body.pairWith === 'string' && body.pairWith !== itemId && store.item(body.pairWith) ? body.pairWith : bad('Pick another dish from the menu.');
  }
  for (const [k, label] of [['nameHi', 'Hindi name'], ['nameMr', 'Marathi name']]) {
    if (k in body) p[k] = typeof body[k] === 'string' && body[k].length <= 80 ? body[k].trim() : bad(`${label} must be up to 80 characters.`);
  }
  if (!Object.keys(p).length) bad('Nothing to update.');
  return p;
}
function newItem(r) {
  return {
    name: str(r.name, 80, 'Name'), desc: typeof r.desc === 'string' ? r.desc.slice(0, 200) : '', price: money(r.price),
    category: CAT_IDS.includes(r.category) ? r.category : bad('Unknown category.'),
    diet: r.diet === 'nonveg' ? 'nonveg' : 'veg', vegan: r.vegan === true && r.diet !== 'nonveg', gf: r.gf === true,
    spicy: [0, 1, 2, 3].includes(r.spicy) ? r.spicy : 0,
    meals: Array.isArray(r.meals) && r.meals.length && r.meals.every((m) => MEALS.includes(m)) ? [...new Set(r.meals)] : bad('Pick at least one meal time.'),
    // Inferred from the menu text, so the kitchen still has to confirm them in Menu Control.
    allergens: Array.isArray(r.allergens) ? [...new Set(r.allergens.filter((a) => ALLERGEN_KEYS.includes(a)))] : [], allergensChecked: false,
  };
}
const fmtMoney = (n) => '$' + n.toFixed(2);

// ---------- routes ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const method = req.method;
  let r;

  // pages
  if (method === 'GET' && p === '/') return serveFile(res, CUSTOMER_PUBLIC, 'index.html');
  if (method === 'GET' && (r = p.match(/^\/table\/(\d{1,2})\/?$/))) {
    const table = 'T' + Number(r[1]);
    if (!TABLES.includes(table)) return serveFile(res, CUSTOMER_PUBLIC, 'index.html');
    // Guests pick a table on the landing page, so an occupied one sends them back.
    if (store.tableStatuses([table])[table]) {
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return serveFile(res, CUSTOMER_PUBLIC, 'table.html');
  }
  // One staff app, three views: the dashboard, a kitchen screen and a phone view for the floor.
  if (method === 'GET' && /^\/(restaurant|kitchen|floor)\/?$/.test(p)) return serveFile(res, STAFF_PUBLIC, 'admin.html');
  // The dashboard used to live at /admin; that name now belongs to the super-admin app.
  if (method === 'GET' && (p === '/admin' || p === '/admin/')) { res.writeHead(302, { Location: '/restaurant' }); return res.end(); }
  // Vendored runtimes (React, ONNX wasm, the VAD model) only change on upgrade, so tablets may keep them a day.
  if (method === 'GET' && p.startsWith('/assets/')) return serveFile(res, ASSETS, p.slice('/assets/'.length), p.startsWith('/assets/vendor/') ? 'public, max-age=86400' : 'public, max-age=300');
  if (method === 'GET' && p === '/api/config') {
    const s = license.status();
    const occupancy = store.tableStatuses(TABLES);
    return send(res, 200, {
      tables: TABLES, busy: s.active ? TABLES.filter((t) => occupancy[t]) : [],
      restaurant: s.name, service: { state: s.state, active: s.active, linked: s.linked, offline: s.offline, usage: s.usage },
    });
  }
  if (method === 'GET' && p === '/api/voice') {
    const w = whisper.status();
    const set = tabletSettings();
    const tts = w && w.voice ? { tts: 'piper', voice: w.voice } : { tts: 'browser' };
    const common = { vad: set.vad, offlineOnly: set.voicePrivacy === 'offline', ...tts };
    return send(res, 200, w
      ? { engine: 'whisper', model: w.model, device: w.device, languages: w.languages || ['en'], ...common }
      : { engine: 'browser', languages: ['en'], ...common });
  }

  if (method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused.' });

  // Connect this server to its restaurant account, once, with the credentials from the welcome email.
  if (p === '/api/admin/connect' && method === 'POST') {
    if (!license.licensed || license.status().linked) return send(res, 409, { error: 'This system is already connected.' });
    if (!allowAttempt(req)) return send(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
    const body = await readJson(req);
    if (typeof body.username !== 'string' || typeof body.password !== 'string' || !body.username || !body.password) bad('Enter the restaurant username and password.');
    try {
      const s = await license.link(body.username.slice(0, 64), body.password.slice(0, 200));
      loginAttempts.delete(req.socket.remoteAddress);
      return send(res, 200, { service: { state: s.state, active: s.active, linked: s.linked }, restaurant: s.name });
    } catch (e) {
      if (e.userFacing) return send(res, e.status, { error: e.message });
      console.error('[license]', e.message);
      return send(res, 503, { error: e.status
        ? 'The licence server refused this system. Check SUPABASE_URL and SUPABASE_ANON_KEY in its .env.'
        : "Can't reach the licence server. Check the internet connection and try again." });
    }
  }

  const service = license.status();
  if (!service.active && (p.startsWith('/api/tables/') || p.startsWith('/api/admin/'))) return suspended(res, service);

  // ----- customer (table) API -----
  if ((r = p.match(/^\/api\/tables\/(T\d{1,2})(\/.*)?$/))) {
    const table = r[1];
    if (!TABLES.includes(table)) return send(res, 404, { error: 'Unknown table.' });
    const sub = r[2] || '';
    if (method === 'GET' && sub === '/events') return openStream(req, res, { role: 'table', table });
    if (method === 'GET' && sub === '') return send(res, 200, tableSnapshot(table));
    if (method === 'POST' && sub === '/transcribe') {
      const now = Date.now();
      const recent = (transcribeStamps.get(table) || []).filter((t) => now - t < 60000);
      if (recent.length >= TRANSCRIBE_LIMIT) {
        const retryAfter = Math.ceil((recent[0] + 60000 - now) / 1000);
        return send(res, 429, { error: 'rate_limited', retryAfter }, { 'Retry-After': String(retryAfter) });
      }
      const pcm = await readAudio(req, 20 * 16000 * 2); // 20 s cap; the tablet stops at 12 s (18 s when the guest takes their time)
      if (!whisper.status()) return send(res, 503, { error: 'Voice transcription is offline.' });
      const lang = url.searchParams.get('lang') || 'en';
      if (!isLang(lang)) bad('Unknown language.');
      const wait = slowLane(table);
      if (wait) return send(res, 429, { error: 'voice_busy', retryAfter: wait }, { 'Retry-After': String(wait) });
      const gate = await license.useVoice('transcribe');
      if (!gate.ok) return suspended(res, gate.status);
      recent.push(now); transcribeStamps.set(table, recent);
      // Dish names steer Whisper toward the menu's spelling ("burrata", "arrabbiata", "tiramisu").
      const prompt = 'Restaurant order. Menu: ' + store.menu().filter((m) => m.available).map((m) => m.name).join(', ') + '.';
      try {
        const out = await whisper.transcribe(pcm, prompt, lang);
        if (license.status().usage === 'throttled') slowTickets.set(table, Date.now());
        return send(res, 200, { text: out.text, ms: out.ms });
      } catch (e) {
        if (e.code === 'english_only') return send(res, 409, { error: 'language_unavailable' });
        console.error('[whisper]', e.message);
        return send(res, 503, { error: 'Voice transcription is offline.' });
      }
    }
    const body = method === 'DELETE' ? {} : await readJson(req);

    if (method === 'POST' && sub === '/cart') {
      const v = validateCall({ tool: 'add_to_cart', args: { item_id: body.itemId, qty: body.qty, modifiers: body.mods } }, store.menu());
      if (!v.ok || v.stripped.length) bad(v.errors[0] || 'That option is not available for this dish.');
      if (!store.item(v.args.item_id).available) return send(res, 409, { error: 'That dish is unavailable tonight.' });
      store.addToCart(table, v.args.item_id, v.args.qty, v.args.modifiers);
    } else if (method === 'PATCH' && (r = sub.match(/^\/cart\/([\w-]+)$/))) {
      if (![-1, 1].includes(body.delta)) bad('delta must be 1 or -1.');
      if (!store.changeQty(table, r[1], body.delta)) return send(res, 404, { error: 'Line not found.' });
    } else if (method === 'DELETE' && (r = sub.match(/^\/cart\/([\w-]+)$/))) {
      store.removeLine(table, r[1]);
    } else if (method === 'PUT' && sub === '/note') {
      store.setNote(table, typeof body.note === 'string' ? body.note.slice(0, 200) : '');
    } else if (method === 'POST' && sub === '/reset') {
      store.resetTable(table);
      assistant.forget(table);
    } else if (method === 'POST' && sub === '/orders') {
      const orderId = store.placeOrder(table);
      if (!orderId) return send(res, 409, { error: 'Your order is empty.' });
      assistant.forget(table);
      broadcast();
      return send(res, 201, { orderId, undoUntil: Date.now() + UNDO_MS });
    } else if (method === 'POST' && (r = sub.match(/^\/orders\/([\w-]+)\/cancel$/))) {
      const out = store.cancelOrder(table, r[1], UNDO_MS);
      if (!out.ok) return send(res, 409, { error: out.reason === 'too_late' ? 'The kitchen has already started this order. Please ask your server.' : 'Order not found.' });
    } else if (method === 'POST' && sub === '/requests') {
      if (body.type === 'server') store.addRequest(table, 'server', typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 120) : 'Call Server button');
      else if (body.type === 'bill') {
        const split = Number.isInteger(body.split) && body.split >= 1 && body.split <= 12 ? body.split : bad('Split must be 1-12.');
        const total = store.tableOrders(table).reduce((s, o) => s + o.total, 0);
        if (!total) return send(res, 409, { error: 'Send your order to the kitchen first, then request the bill.' });
        store.addRequest(table, 'bill', `Bill ${fmtMoney(total)}${split > 1 ? ` · split ${split} ways (${fmtMoney(total / split)} each)` : ''}`, split);
      } else bad('Unknown request type.');
    } else if (method === 'POST' && sub === '/speak') {
      // Alice's Piper voice, synthesized locally by the voice service; the tablet plays the WAV.
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 400) : '';
      if (!text) bad('Nothing to say.');
      const w = whisper.status();
      // The local voice speaks English only; over the voice limit the tablet uses its own voice.
      if (!w || !w.voice || (body.lang && body.lang !== 'en') || license.status().usage === 'throttled') return send(res, 503, { error: 'The assistant voice is offline.' });
      const now = Date.now();
      const recent = (speakStamps.get(table) || []).filter((t) => now - t < 60000);
      if (recent.length >= SPEAK_LIMIT) return send(res, 429, { error: 'rate_limited' });
      const gate = await license.useVoice('speak');
      if (!gate.ok) return suspended(res, gate.status);
      recent.push(now); speakStamps.set(table, recent);
      try {
        const wav = await whisper.speak(text, body.rate === 'slow' ? 'slow' : 'normal');
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
        return res.end(wav);
      } catch (e) {
        console.error('[piper]', e.message);
        return send(res, 503, { error: 'The assistant voice is offline.' });
      }
    } else if (method === 'POST' && sub === '/assistant') {
      const lang = isLang(body.lang) ? body.lang : 'en';
      const wait = slowLane(table, { ticket: true });
      if (wait) return send(res, 429, { error: 'voice_busy', retryAfter: wait }, { 'Retry-After': String(wait) });
      const gate = await license.useVoice('assistant');
      if (!gate.ok) return suspended(res, gate.status);
      const out = assistant.handle(table, typeof body.text === 'string' ? body.text.slice(0, 1000) : '', lang);
      broadcast();
      return send(res, out.status, out.body, out.status === 429 ? { 'Retry-After': String(out.body.retryAfter) } : {});
    } else return send(res, 404, { error: 'Not found' });
    broadcast();
    return send(res, 200, { ok: true });
  }

  // ----- staff (admin) API -----
  if (p === '/api/admin/login' && method === 'POST') {
    if (!allowAttempt(req)) return send(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
    const body = await readJson(req);
    let ok;
    try { ok = typeof body.pin === 'string' && (license.licensed ? await license.verifyPin(body.pin) : pinOk(body.pin)); } catch (e) {
      console.error('[license]', e.message);
      return send(res, 503, { error: "Can't reach the licence server. Check the internet connection and try again." });
    }
    if (!ok) return send(res, 401, { error: 'That PIN is not correct.' });
    loginAttempts.delete(req.socket.remoteAddress);
    const token = randomBytes(32).toString('base64url');
    store.addSession(sha(token), SESSION_TTL);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `flv_staff=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${secureCookie(req)}` });
  }
  if (p.startsWith('/api/admin/')) {
    if (!isStaff(req)) return send(res, 401, { error: 'Staff login required.' });
    const sub = p.slice('/api/admin'.length);
    if (method === 'GET' && sub === '/me') return send(res, 200, { ok: true });
    if (method === 'GET' && sub === '/events') return openStream(req, res, { role: 'admin' });
    if (method === 'POST' && sub === '/logout') {
      store.dropSession(sha(cookies(req).flv_staff));
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'flv_staff=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    const body = method === 'GET' ? {} : await readJson(req);
    if (method === 'PATCH' && (r = sub.match(/^\/menu\/([\w-]+)$/))) {
      if (!store.updateItem(r[1], itemPatch(body, r[1]))) return send(res, 404, { error: 'Dish not found.' });
    } else if (method === 'POST' && sub === '/menu') {
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 60) bad('Send 1-60 dishes.');
      const added = store.publishItems(body.items.map(newItem));
      broadcast();
      return send(res, 201, { added: added.length });
    } else if (method === 'PATCH' && (r = sub.match(/^\/tables\/(T\d{1,2})\/occupancy$/))) {
      if (!TABLES.includes(r[1])) return send(res, 404, { error: 'Unknown table.' });
      if (typeof body.occupied !== 'boolean') bad('occupied must be a boolean.');
      store.setTableOccupied(r[1], body.occupied);
    } else if (method === 'PATCH' && sub === '/settings/tablets') {
      if ('vad' in body) store.setting('tablet_vad', ['normal', 'noisy'].includes(body.vad) ? body.vad : bad('Unknown microphone setting.'));
      if ('voicePrivacy' in body) store.setting('voice_privacy', ['standard', 'offline'].includes(body.voicePrivacy) ? body.voicePrivacy : bad('Unknown voice setting.'));
    } else if (method === 'POST' && sub === '/backup') {
      const out = backups.run();
      if (out.error) return send(res, 500, { error: `Backup failed: ${out.error}` });
    } else if (method === 'PATCH' && sub === '/settings/table-count') {
      if (!Number.isInteger(body.count) || body.count < 1 || body.count > 99) bad('Table count must be an integer from 1 to 99.');
      TABLE_COUNT = body.count;
      TABLES = tableList(TABLE_COUNT);
      store.setting('table_count', String(TABLE_COUNT));
      broadcast();
      return send(res, 200, { tables: TABLES });
    } else if (method === 'POST' && (r = sub.match(/^\/orders\/([\w-]+)\/advance$/))) {
      if (!store.advanceOrder(r[1])) return send(res, 404, { error: 'Order not found.' });
    } else if (method === 'POST' && (r = sub.match(/^\/requests\/([\w-]+)$/))) {
      if (!['acknowledged', 'done'].includes(body.status)) bad('Unknown status.');
      if (!store.setRequestStatus(r[1], body.status)) return send(res, 404, { error: 'Request not found.' });
    } else return send(res, 404, { error: 'Not found' });
    broadcast();
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found' });
}

export const server = http.createServer(async (req, res) => {
  try { await route(req, res); } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});
server.listen(PORT, () => {
  console.log('Flavoria is running');
  console.log(`  Customer tablets:  ${PUBLIC_URL}/table/1 ... /table/${TABLE_COUNT}`);
  console.log(`  Restaurant staff:  ${PUBLIC_URL}/restaurant`);
  console.log(`  Database:          ${DB_FILE}`);
  console.log(`  Licence:           ${license.licensed ? license.status().state : 'standalone (no SUPABASE_URL)'}`);
  console.log(`  Backups:           ${backups.status().dir}${process.env.BACKUP_COPY_DIR ? ' + ' + process.env.BACKUP_COPY_DIR : ''}`);
  license.start();
  backups.start();
  whisper.start();
});
