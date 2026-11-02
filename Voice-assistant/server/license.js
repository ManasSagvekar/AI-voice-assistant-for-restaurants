// Restaurant licence: links this server to its restaurant account in Supabase (managed from the
// admin app) and decides whether tablets and the staff dashboard may be used right now.
//
// The device signs in once as the restaurant (username + password); only the refresh token is kept,
// in the settings table. Access is re-checked every 10 seconds and on every voice request, which is
// also counted against the restaurant's rate limit. Only request counts leave this server: orders,
// bills and totals stay in the local database.
//
// Without SUPABASE_URL and SUPABASE_ANON_KEY it runs standalone, always active, with the local STAFF_PIN.
import { createSupabase, SupabaseError } from './supabase.js';

const POLL_MS = 10000;

export function createLicense(store, { url, anonKey, name = 'Restaurant', graceMs = 15 * 60e3, onBlock = () => {} }) {
  if (!url || !anonKey) {
    const standalone = { state: 'standalone', active: true, linked: true, name };
    return { licensed: false, status: () => standalone, start() {}, useVoice: async () => ({ ok: true, status: standalone }) };
  }

  const sb = createSupabase(url, anonKey);
  let session = null; // { token, expiresAt }
  let refreshing = null;
  let access = (() => { try { return JSON.parse(store.setting('license_access') || 'null'); } catch { return null; } })();
  let wasActive = null;
  let lastError = '';

  const linked = () => !!store.setting('license_refresh_token');

  function saveSession(s) {
    session = { token: s.access_token, expiresAt: Date.now() + s.expires_in * 1000 };
    store.setting('license_refresh_token', s.refresh_token); // Supabase rotates it on every refresh
  }
  async function token() {
    if (session && session.expiresAt - 60e3 > Date.now()) return session.token;
    refreshing ||= (async () => {
      try { saveSession(await sb.refresh(store.setting('license_refresh_token'))); }
      catch (e) { if (e.status === 400 || e.status === 401) unlink('the restaurant account signed this device out'); throw e; }
    })().finally(() => { refreshing = null; });
    await refreshing;
    return session.token;
  }

  function status() {
    if (!linked()) return { state: 'unlinked', active: false, linked: false, name };
    if (!access) return { state: 'offline', active: false, linked: true, name };
    // Use the last answer for a while if Supabase can't be reached, so a network blip doesn't stop
    // dinner service; the plan's end date is still enforced locally.
    const stale = Date.now() - access.checkedAt > graceMs;
    const expired = !access.subscription_expires_at || Date.parse(access.subscription_expires_at) <= Date.now();
    const active = !!access.allowed && !expired && !stale;
    const state = active ? 'active' : stale ? 'offline' : expired ? 'expired' : access.reason || 'suspended';
    return { state, active, linked: true, name: access.name };
  }
  function notify() {
    const s = status();
    if (wasActive && !s.active) onBlock(s);
    wasActive = s.active;
  }
  function setAccess(a) {
    access = a ? { ...a, checkedAt: Date.now() } : null;
    store.setting('license_access', JSON.stringify(access));
    notify();
  }
  function unlink(why) {
    console.log(`[license] Device unlinked: ${why}.`);
    store.setting('license_refresh_token', '');
    session = null;
    setAccess(null);
  }
  function logError(e) {
    if (e.message !== lastError) console.error('[license]', e.message);
    lastError = e.message;
  }

  async function check() {
    try {
      const a = await sb.rpc('restaurant_access', {}, await token());
      lastError = '';
      if (a) setAccess(a); else unlink('the restaurant account no longer exists');
    } catch (e) {
      if (linked()) logError(e);
      notify(); // the grace period may have just run out
    }
  }

  // Errors marked userFacing are about the credentials; anything else is configuration or network.
  const refuse = (status, message) => Object.assign(new SupabaseError(status, message), { userFacing: true });
  async function link(username, password) {
    const email = await sb.rpc('login_email', { p_username: username });
    if (!email) throw refuse(401, 'That username or password is not correct.');
    let s;
    try { s = await sb.signIn(email, password); } catch (e) {
      throw e.status === 400 ? refuse(401, 'That username or password is not correct.') : e;
    }
    const a = await sb.rpc('restaurant_access', {}, s.access_token);
    if (!a) throw refuse(403, 'That account is not a restaurant account.');
    saveSession(s);
    setAccess(a);
    console.log(`[license] Linked to ${a.name}.`);
    return status();
  }

  async function verifyPin(pin) {
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return false;
    const ok = (await sb.rpc('verify_staff_pin', { p_pin: pin }, await token())) === true;
    if (!ok) check(); // a refusal can also mean the service was just suspended
    return ok;
  }

  // Counts one voice request. Returns ok: false when the restaurant is (or has just become) blocked.
  async function useVoice(kind) {
    if (!status().active) return { ok: false, status: status() };
    try {
      setAccess(await sb.rpc('increment_usage', { p_restaurant_id: access.restaurant_id, p_kind: kind }, await token()));
      lastError = '';
    } catch (e) {
      logError(e);
      if (e instanceof SupabaseError && e.status >= 400 && e.status < 500) await check();
      // Otherwise Supabase is unreachable: serve on the last known status within the grace period.
    }
    const s = status();
    return { ok: s.active, status: s };
  }

  function start() {
    wasActive = status().active;
    if (linked()) check();
    setInterval(() => linked() && check(), POLL_MS);
  }

  return { licensed: true, status, start, link, verifyPin, useVoice };
}
