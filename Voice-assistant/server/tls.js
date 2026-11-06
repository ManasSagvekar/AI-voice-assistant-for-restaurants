// HTTPS for the restaurant's own network. Browsers only allow the microphone on secure pages, so
// tablets must reach this server over HTTPS, and on a private network nobody can issue a public
// certificate for an address like 192.168.1.20.
//
// So this computer creates its own small certificate authority (once) and a server certificate for
// its current network addresses (again whenever they change). Each tablet installs the authority's
// certificate once, from /tablet-setup. The authority is limited by name constraints to private
// addresses and .local names, so even a stolen key can't impersonate a public website on a tablet.
//
// With TLS_CERT_FILE and TLS_KEY_FILE set, those are used instead (for a real domain name).
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import path from 'node:path';

// ---------- the few pieces of DER (the X.509 encoding) a certificate needs ----------
const len = (n) => {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const octets = (...parts) => tlv(0x04, ...parts);
const bits = (buf) => tlv(0x03, Buffer.from([0]), buf);
// A flag list as a bit string: DER counts the unused bits at the end of its one byte.
const flags = (byte) => { let unused = 0; while (unused < 7 && !((byte >> unused) & 1)) unused++; return tlv(0x03, Buffer.from([unused, byte])); };
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, ...parts) => tlv(0xa0 | n, ...parts);
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a * 40 + b];
  for (const v of rest) {
    const chunk = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const time = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, 'ascii'));
};
const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ipBytes = (ip) => Buffer.from(ip.split('.').map(Number));
const generalName = (host) => (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? tlv(0x87, ipBytes(host)) : tlv(0x82, Buffer.from(host, 'ascii')));
const extension = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const keyId = (publicDer) => createHash('sha1').update(publicDer).digest();
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function issue({ subject, issuer, publicKey, signingKey, days, extensions }) {
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40; // positive and non-zero
  const now = Date.now();
  const tbs = seq(
    explicit(0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), ECDSA_SHA256, name(issuer),
    seq(time(new Date(now - 864e5)), time(new Date(now + days * 864e5))),
    name(subject), publicKey.export({ type: 'spki', format: 'der' }), explicit(3, seq(...extensions)),
  );
  const der = seq(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, signingKey)));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}
const rawPublic = (publicKey) => publicKey.export({ type: 'spki', format: 'der' });

const CA_NAME = 'Restaurant tablets (this computer only)';
const PRIVATE_RANGES = [['10.0.0.0', '255.0.0.0'], ['172.16.0.0', '255.240.0.0'], ['192.168.0.0', '255.255.0.0'], ['127.0.0.0', '255.0.0.0']];
const isPrivate = (ip) => /^(10\.|192\.168\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

function newAuthority() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const subtree = (general) => seq(general);
  const permitted = explicit(0,
    ...PRIVATE_RANGES.map(([ip, mask]) => subtree(tlv(0x87, ipBytes(ip), ipBytes(mask)))),
    subtree(tlv(0x82, Buffer.from('local', 'ascii'))), subtree(tlv(0x82, Buffer.from('localhost', 'ascii'))));
  const cert = issue({
    subject: CA_NAME, issuer: CA_NAME, publicKey, signingKey: privateKey, days: 3650,
    extensions: [
      extension('2.5.29.19', true, seq(bool(true), tlv(0x02, Buffer.from([0])))), // a CA, signing only end certificates
      extension('2.5.29.15', true, flags(0x06)), // keyCertSign, cRLSign
      extension('2.5.29.14', false, octets(keyId(rawPublic(publicKey)))),
      extension('2.5.29.30', true, seq(permitted)),
    ],
  });
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

export function newServerCert(ca, hosts) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caCert = new X509Certificate(ca.cert);
  const cert = issue({
    // Addresses belong in the alternative names; one here would be checked as a DNS name and refused.
    subject: 'Restaurant server', issuer: CA_NAME, publicKey,
    signingKey: createPrivateKey(ca.key), days: 825, // the longest Apple devices accept
    extensions: [
      extension('2.5.29.19', true, seq()),
      extension('2.5.29.15', true, flags(0x80)), // digitalSignature
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // TLS server
      extension('2.5.29.17', false, seq(...hosts.map(generalName))),
      extension('2.5.29.14', false, octets(keyId(rawPublic(publicKey)))),
      extension('2.5.29.35', false, seq(tlv(0x80, keyId(rawPublic(caCert.publicKey))))),
    ],
  });
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// The IPv4 addresses tablets can reach this computer on. Public addresses are left out: a local
// authority can't vouch for them, and a restaurant's server shouldn't be reached that way.
export function networkAddresses() {
  return Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal && isPrivate(a.address)).map((a) => a.address);
}
function currentHosts() {
  const host = hostname().toLowerCase();
  return ['localhost', '127.0.0.1', ...networkAddresses(), ...(/^[a-z0-9-]+$/.test(host) ? [`${host}.local`] : [])];
}
const covers = (x509, host) => (/^\d/.test(host) ? x509.checkIP(host) : x509.checkHost(host));

// Returns { key, cert, caCert (null with the restaurant's own certificate), refresh }. refresh()
// returns fresh credentials when the computer's addresses have changed, otherwise null.
export function createTls(dir, env = process.env) {
  if (env.TLS_CERT_FILE && env.TLS_KEY_FILE) {
    return { key: readFileSync(env.TLS_KEY_FILE), cert: readFileSync(env.TLS_CERT_FILE), caCert: null, refresh: () => null };
  }
  mkdirSync(dir, { recursive: true });
  const file = (n) => path.join(dir, n);
  const write = (n, value, secret) => writeFileSync(file(n), value, secret ? { mode: 0o600 } : undefined);
  if (!existsSync(file('ca.crt')) || !existsSync(file('ca-key.pem'))) {
    const made = newAuthority();
    write('ca.crt', made.cert);
    write('ca-key.pem', made.key, true);
    write('server.crt', ''); // anything signed by an older authority is no longer trusted
  }
  const ca = { cert: readFileSync(file('ca.crt'), 'utf8'), key: readFileSync(file('ca-key.pem'), 'utf8') };
  function serverCert() {
    const hosts = currentHosts();
    let cert = existsSync(file('server.crt')) ? readFileSync(file('server.crt'), 'utf8') : '';
    let fresh = false;
    try {
      const x = new X509Certificate(cert);
      fresh = hosts.every((h) => covers(x, h)) && Date.parse(x.validTo) - Date.now() > 30 * 864e5;
    } catch { /* missing or unreadable: make a new one */ }
    if (fresh) return { cert, key: readFileSync(file('server-key.pem'), 'utf8'), changed: false };
    const made = newServerCert(ca, hosts);
    write('server.crt', made.cert);
    write('server-key.pem', made.key, true);
    return { ...made, changed: true };
  }
  const first = serverCert();
  return {
    key: first.key, cert: first.cert, caCert: ca.cert,
    refresh() {
      const next = serverCert();
      return next.changed ? { key: next.key, cert: next.cert } : null;
    },
  };
}
