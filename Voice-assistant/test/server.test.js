// Runs the real server: table claims, the HTTPS certificate and the redirect from plain HTTP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tlsClient from 'node:tls';
import test, { after, before } from 'node:test';
import { networkAddresses, newServerCert } from '../server/tls.js';

const PORT = 3921;
const HTTPS_PORT = 3922;
const PIN = '246810';
const LAN_GUEST = '192.168.1.50';
const directory = mkdtempSync(path.join(tmpdir(), 'tazte-server-test-'));
let server;

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), DB_FILE: path.join(directory, 'restaurant.db'), BACKUP_DIR: path.join(directory, 'b'), WHISPER_AUTOSTART: '0', VOICEBOX: 'off', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', STAFF_PIN: PIN, HOST: '127.0.0.1', TABLE_COUNT: '8', HTTPS: '' },
  });
  let log = '';
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { log += d; if (/Tablets:|Flavoria is running/.test(log) && log.includes('Backups')) setTimeout(resolve, 400); });
    server.on('exit', (c) => reject(new Error(`server exited ${c}: ${log}`)));
  });
  server.removeAllListeners('exit');
});
after(async () => {
  server.kill();
  await new Promise((r) => server.once('exit', r));
  rmSync(directory, { recursive: true, force: true });
});

// One simulated device: its own cookies and its own address, as the dev proxy reports it.
function device(address = LAN_GUEST) {
  let cookie = '';
  return async (p, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method, redirect: 'manual',
      headers: { ...(address ? { 'X-Forwarded-For': address, 'X-Forwarded-Proto': 'https' } : {}), 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };
}

test('the first device holds a table; others can neither read nor change it', async () => {
  const first = device('192.168.1.60');
  const other = device('192.168.1.61');
  assert.equal((await first('/api/tables/T1/claim', 'POST', {})).status, 200);
  const dish = (await first('/api/tables/T1')).data.menu[0].id;
  assert.equal((await first('/api/tables/T1/cart', 'POST', { itemId: dish, qty: 1, mods: [] })).status, 200);
  assert.equal((await first('/api/tables/T1/orders', 'POST', {})).status, 201);

  assert.equal((await other('/api/tables/T1/claim', 'POST', {})).data.error, 'table_held');
  assert.equal((await other('/api/tables/T1')).status, 423, "another device can't read the table's orders");
  assert.equal((await other('/api/tables/T1/events')).status, 423);
  assert.equal((await other('/api/tables/T1/orders', 'POST', {})).status, 423);
  assert.equal((await other('/api/tables/T1/requests', 'POST', { type: 'server' })).status, 423);
  const page = await other('/table/1');
  assert.equal(page.status, 303, 'the page sends other devices back to the table list');
  assert.equal((await first('/table/1')).status, 200, 'the device holding it can still open it after ordering');
  const cfg = (await other('/api/config')).data;
  assert.ok(cfg.held.includes('T1'));
  assert.deepEqual(cfg.mine, []);
});

test("a tablet holds one table, and a device can't sweep up every table", async () => {
  const tablet = device('192.168.1.62');
  assert.equal((await tablet('/api/tables/T2/claim', 'POST', {})).status, 200);
  const again = await tablet('/api/tables/T3/claim', 'POST', {});
  assert.equal(again.data.error, 'device_has_table');
  assert.equal(again.data.table, 'T2');

  // No cookies: looks like a new device each time, from the same address.
  assert.equal((await device('192.168.1.63')('/api/tables/T4/claim', 'POST', {})).status, 200);
  const swept = await device('192.168.1.63')('/api/tables/T5/claim', 'POST', {});
  assert.equal(swept.status, 429);
  assert.equal(swept.data.error, 'claim_limit');
});

test('staff can open any table without taking it, and release it for a new device', async () => {
  const held = device('192.168.1.64');
  assert.equal((await held('/api/tables/T6/claim', 'POST', {})).status, 200);
  const staff = device('192.168.1.65');
  assert.equal((await staff('/api/admin/tables/T6/release', 'POST', {})).status, 401, 'releasing needs a staff sign-in');
  assert.equal((await staff('/api/admin/login', 'POST', { pin: PIN })).status, 200);
  assert.equal((await staff('/api/tables/T6')).status, 200);
  assert.equal((await staff('/api/tables/T6/claim')).data.mine, false);
  assert.equal((await staff('/api/admin/tables/T6/release', 'POST', {})).status, 200);
  assert.equal((await held('/api/tables/T6')).status, 423, 'the old tablet no longer has it');
  assert.equal((await device('192.168.1.66')('/api/tables/T6/claim', 'POST', {})).status, 200);
});

test('this computer can try out several tables', async () => {
  const local = device(null);
  assert.equal((await local('/api/tables/T7/claim', 'POST', {})).status, 200);
  assert.equal((await local('/api/tables/T8/claim', 'POST', {})).status, 200);
});

test('prices can only be changed per size on a dish with sizes, and bills need a sign-in', async () => {
  const staff = device('192.168.1.67');
  const guest = device('192.168.1.68');
  assert.equal((await guest('/api/admin/tables/T1/bill', 'POST', {})).status, 401);
  assert.equal((await guest('/api/admin/settings/billing', 'PATCH', { taxRate: 1, serviceRate: 0 })).status, 401);
  await staff('/api/admin/login', 'POST', { pin: PIN });
  const patch = (body) => staff('/api/admin/menu/tiramisu', 'PATCH', body);
  assert.equal((await patch({ sizes: [{ label: 'Half', price: 5 }] })).status, 400, 'one size is not a choice');
  assert.equal((await patch({ sizes: [{ label: 'Half', price: 5 }, { label: 'half', price: 6 }] })).status, 400, 'names must differ');
  assert.equal((await patch({ sizes: [{ label: 'Half', price: 5 }, { label: 'Full', price: 0 }] })).status, 400);
  assert.equal((await patch({ sizes: [{ label: 'Half', price: 5 }, { label: 'Full', price: 9 }] })).status, 200);
  assert.equal((await patch({ price: 1 })).status, 400);
  assert.equal((await patch({ sizes: null })).status, 200);
  assert.equal((await staff('/api/admin/settings/billing', 'PATCH', { taxRate: 90, serviceRate: 0 })).status, 400);
  assert.equal((await staff('/api/admin/tables/T1/bill', 'POST', {})).data.table, 'T1');
});

test('the health report needs a staff sign-in, and reports on the running server', async () => {
  const guest = device('192.168.1.69');
  assert.equal((await guest('/api/admin/health')).status, 401);
  const staff = device('192.168.1.70');
  await staff('/api/admin/login', 'POST', { pin: PIN });
  const { data } = await staff('/api/admin/health');
  assert.deepEqual(data.checks.map((c) => c.id), ['licence']);
  assert.equal(data.checks[0].status, 'ok');
});

test('plain HTTP from the network goes to HTTPS, except the tablet setup page', async () => {
  const get = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, { redirect: 'manual', headers: { 'X-Forwarded-For': LAN_GUEST, 'X-Forwarded-Proto': 'http' } });
  // fetch won't send a chosen Host header, and the redirect keeps the address the tablet used.
  const page = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/table/1', headers: { Host: '192.168.1.20:3000', 'X-Forwarded-For': LAN_GUEST, 'X-Forwarded-Proto': 'http' } }, (r) => { r.resume(); resolve(r); }).on('error', reject);
  });
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, `https://192.168.1.20:${HTTPS_PORT}/table/1`);
  assert.equal((await get('/tablet-setup')).status, 200);
  const ca = await get('/tablet-ca.crt');
  assert.equal(ca.status, 200);
  assert.match(await ca.text(), /BEGIN CERTIFICATE/);
  const post = await fetch(`http://127.0.0.1:${PORT}/api/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'X-Forwarded-For': LAN_GUEST, 'X-Forwarded-Proto': 'http', 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
  assert.equal(post.status, 426, "a PIN isn't accepted over plain HTTP from the network");
  // On this computer plain HTTP keeps working.
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/`, { redirect: 'manual' })).status, 200);
});

test('the HTTPS certificate is valid for this computer and chains to the local authority', async () => {
  const caPem = readFileSync(path.join(directory, 'tls', 'ca.crt'), 'utf8');
  const ca = new X509Certificate(caPem);
  assert.equal(ca.ca, true);
  assert.ok(ca.checkIssued(ca));
  const connect = (host) => new Promise((resolve, reject) => {
    const s = tlsClient.connect({ host: '127.0.0.1', port: HTTPS_PORT, ca: caPem, servername: /^\d/.test(host) ? undefined : host, checkServerIdentity: (_, cert) => tlsClient.checkServerIdentity(host, cert) }, () => { resolve(s.authorized); s.destroy(); });
    s.on('error', reject);
  });
  assert.equal(await connect('localhost'), true);
  for (const ip of networkAddresses()) assert.equal(await connect(ip), true, ip);
  await assert.rejects(connect('example.com'), /does not match|altnames/i, 'not valid for any other name');

  const res = await new Promise((resolve, reject) => {
    const s = tlsClient.connect({ host: '127.0.0.1', port: HTTPS_PORT, ca: caPem, servername: 'localhost' }, () => s.write('GET /api/config HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('end', () => resolve(out));
    s.on('error', reject);
  });
  assert.match(res, /^HTTP\/1\.1 200/);
});

test("the local authority can't vouch for a public website, even with its own key", async () => {
  const ca = { cert: readFileSync(path.join(directory, 'tls', 'ca.crt'), 'utf8'), key: readFileSync(path.join(directory, 'tls', 'ca-key.pem'), 'utf8') };
  const attempt = async (hosts, name) => {
    const forged = newServerCert(ca, hosts);
    const site = tlsClient.createServer({ key: forged.key, cert: forged.cert }, (s) => s.end());
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    try {
      return await new Promise((resolve, reject) => {
        const s = tlsClient.connect({ host: '127.0.0.1', port: site.address().port, ca: ca.cert, servername: /^\d/.test(name) ? undefined : name, checkServerIdentity: (_, cert) => tlsClient.checkServerIdentity(name, cert) }, () => { resolve(s.authorized); s.destroy(); });
        s.on('error', reject);
      });
    } finally { site.close(); }
  };
  assert.equal(await attempt(['192.168.1.20'], '192.168.1.20'), true, 'a private address is fine');
  assert.equal(await attempt(['tablets.local'], 'tablets.local'), true);
  await assert.rejects(attempt(['example.com'], 'example.com'), /permitted subtree|name constraint/i);
  await assert.rejects(attempt(['8.8.8.8'], '8.8.8.8'), /permitted subtree|name constraint/i);
});
