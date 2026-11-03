// Restaurant licence: links this server to its restaurant account in Supabase (managed from the
// admin app) and decides whether tablets and the staff dashboard may be used right now.
//
// The device signs in once as the restaurant (username + password); only the refresh token is kept,
// in the settings table. Access is re-checked every 10 seconds and on every voice request, which is
// also counted against the restaurant's rate limit. Only request counts leave this server: orders,
// bills and totals stay in the local database.
//
// A paid restaurant is never stopped mid-service by its own internet: while Supabase can't be
// reached, the last answer stands until the plan's end date. Going over the voice limit slows voice
// down (see `usage`) instead of closing the restaurant; only a manual suspension, an unpaid or
// expired plan, or an abuse flag closes it.
//
// Staff can sign this computer out of its restaurant (signOut), after which another restaurant can
// connect. onRestaurant(id) is told which restaurant's data to use (null when signed out).
//
// Without SUPABASE_URL and SUPABASE_ANON_KEY it runs standalone, always active, with the local STAFF_PIN.
import { createSupabase, SupabaseError } from './supabase.js';

const POLL_MS = 10000;
const OFFLINE_AFTER_MS = 45000; // no answer for this long counts as offline (shown to staff only)

export function createLicense(store, { url, anonKey, name = 'Restaurant', onBlock = () => {}, onRestaurant = () => {} }) {
  if (!url || !anonKey) {
    const standalone = { state: 'standalone', active: true, linked: true, name, offline: false, usage: 'ok' };
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
    if (!linked()) return { state: 'unlinked', active: false, linked: false, name, offline: false, usage: 'ok' };
    if (!access) return { state: 'offline', active: false, linked: true, name, offline: true, usage: 'ok' };
    // The last answer stands while Supabase can't be reached; the plan's end date is still enforced here.
    const offline = Date.now() - access.checkedAt > OFFLINE_AFTER_MS;
    const expired = !access.subscription_expires_at || Date.parse(access.subscription_expires_at) <= Date.now();
    const active = !!access.allowed && !expired;
    const state = active ? 'active' : expired ? 'expired' : access.reason || 'suspended';
    // 'warn' from 80% of the voice limit, 'throttled' at the limit, for the rest of the window.
    // Databases without the soft-limit migration don't send these, and simply report 'ok'.
    const usage = access.throttled ? 'throttled' : access.warn ? 'warn' : 'ok';
    return { state, active, linked: true, name: access.name, offline, usage, until: access.subscription_expires_at };
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
    onRestaurant(access ? access.restaurant_id || null : null);
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
      notify(); // the plan may have just reached its end date
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

  // Whether these are the username and password of the restaurant this computer is signed in to.
  async function isOwner(username, password) {
    const email = await sb.rpc('login_email', { p_username: username });
    if (!email) return false;
    let s;
    try { s = await sb.signIn(email, password); } catch (e) { if (e.status === 400) return false; throw e; }
    const a = await sb.rpc('restaurant_access', {}, s.access_token);
    sb.signOut(s.access_token).catch(() => {}); // this check needs no session of its own
    return !!a && !!access && a.restaurant_id === access.restaurant_id;
  }

  // Ends this computer's restaurant session, here and (when reachable) in Supabase.
  async function signOut() {
    const s = session;
    unlink('signed out from the staff dashboard');
    if (s) await sb.signOut(s.token).catch(() => {});
  }

  async function verifyPin(pin) {
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return false;
    const ok = (await sb.rpc('verify_staff_pin', { p_pin: pin }, await token())) === true;
    if (!ok) check(); // a refusal can also mean the service was just suspended
    return ok;
  }

  // Counts one voice request. Returns ok: false when the restaurant is (or has just become) blocked,
  // and capped: true (with the service still active) when voice is paused for the rest of the window.
  async function useVoice(kind) {
    if (!status().active) return { ok: false, status: status() };
    // Three times the limit in one window flags the restaurant for abuse and revokes access, and the
    // tablets are open to anyone on the network. So this server stops counting at twice the limit and
    // pauses voice until the window resets: guests can never get their own restaurant locked out.
    // (Only with the soft-limit migration, which reports usage per window.)
    if (access && 'throttled' in access && access.limit > 0 && access.usage >= access.limit * 2) return { ok: false, capped: true, status: status() };
    try {
      setAccess(await sb.rpc('increment_usage', { p_restaurant_id: access.restaurant_id, p_kind: kind }, await token()));
      lastError = '';
    } catch (e) {
      logError(e);
      if (e instanceof SupabaseError && e.status >= 400 && e.status < 500) await check();
      // Otherwise Supabase is unreachable: serve on the last known status.
    }
    const s = status();
    return { ok: s.active, status: s };
  }

  function start() {
    if (linked() && access && access.restaurant_id) onRestaurant(access.restaurant_id);
    wasActive = status().active;
    if (linked()) check();
    setInterval(() => linked() && check(), POLL_MS);
  }

  return { licensed: true, status, start, link, isOwner, signOut, verifyPin, useVoice };
}
