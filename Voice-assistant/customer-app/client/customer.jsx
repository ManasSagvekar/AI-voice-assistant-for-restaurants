import {
  IDLE_LIMIT, WARN_AT, MAX_TURN_MS, LONG_TURN_MS, RATE_LIMIT, TAX_RATE, UNDO_MS, fmt, CATEGORIES, MODIFIERS, ALLERGENS, allowedMods, priceLine, totals,
  EMPTY_FILTERS, matchesFilters, describeFilters, sanitizeTranscript, upsellFor,
} from '../../shared/engine.js';
import { LANGS, ui, labels, dishName, allergenName, EXAMPLES } from '../../shared/i18n.js';
import {
  useState, useEffect, useRef, useMemo, useCallback, createContext, tableName, mmss, modsText, Icon, Chili, DietMark, DishImage, Waveform,
  VOICE_LABEL, Toasts, StatusPill, api, useLive, useToasts, Brand, LiveBadge, Loading, chime,
  useContext, RestaurantContext, useRestaurant, ServicePaused, serviceChanged,
} from '../../client/ui.jsx';

const SAMPLE_PHRASES = [
  'Show me spicy vegetarian main courses for lunch',
  'Add Truffle Mushroom Risotto, extra cheese, no garlic',
  'Two mango passion mocktails and a classic tiramisu',
  'Does the tiramisu have nuts?',
  'Something gluten-free under $30',
  'Call a server please',
  'Request the bill, split three ways',
];

// What one guest chose for this session: language, larger text, a slower voice, more time to speak.
// Everything goes back to the defaults when the session ends, ready for the next guests.
const DEFAULT_PREFS = { lang: 'en', large: false, slow: false, patient: false };
const PrefsContext = createContext({ prefs: DEFAULT_PREFS, setPrefs: () => {} });
const usePrefs = () => useContext(PrefsContext);
const useT = () => ui(usePrefs().prefs.lang);

function timeGreeting(lang) {
  const h = new Date().getHours();
  const greetings = { en: ['Good morning', 'Good afternoon', 'Good evening'], hi: ['सुप्रभात', 'नमस्कार', 'शुभ संध्या'], mr: ['सुप्रभात', 'नमस्कार', 'शुभ संध्याकाळ'] };
  const g = greetings[lang] || greetings.en;
  return g[h < 12 ? 0 : h < 17 ? 1 : 2];
}
// Assistant voice: Chrome's "Google UK English Female" at a natural conversational pace. Without it,
// another British female voice; failing that, the restaurant's Piper voice, then the browser default.
// Hindi and Marathi use the browser's hi-IN / mr-IN voice. With the restaurant's "offline only"
// setting, online (Google) voices are skipped so no reply text leaves the building.
const VOICE_NAME = 'Google UK English Female';
const VOICE_RATE = { normal: 1.12, slow: 0.9 };
const hasTts = () => typeof speechSynthesis !== 'undefined';
function preferredVoice(lang = 'en', offlineOnly = false) {
  if (!hasTts()) return null;
  const all = speechSynthesis.getVoices().filter((v) => !offlineOnly || v.localService);
  if (lang !== 'en') {
    const locale = LANGS.find((item) => item.id === lang)?.speech;
    const languageCode = locale && locale.split('-')[0];
    return languageCode ? all.find((v) => v.lang.toLowerCase().startsWith(languageCode.toLowerCase() + '-')) || null : null;
  }
  const gb = all.filter((v) => /^en[-_]GB$/i.test(v.lang));
  return gb.find((v) => v.name === VOICE_NAME)
    || gb.find((v) => /female|libby|sonia|hazel|susan|serena|kate|martha|maisie|mia/i.test(v.name))
    || gb.find((v) => !/\bmale\b|george|ryan|thomas|oliver|daniel|arthur|alfie/i.test(v.name))
    || null;
}
// Chrome fills the voice list asynchronously.
const voicesLoaded = new Promise((resolve) => {
  if (!hasTts() || speechSynthesis.getVoices().length) return resolve();
  speechSynthesis.addEventListener('voiceschanged', resolve, { once: true });
  setTimeout(resolve, 1500);
});

// VAD callbacks while no turn is listening.
const VAD_IDLE = { start() {}, misfire() {}, end() {} };

// Downsample captured Float32 audio to 16 kHz mono 16-bit PCM, the format the Whisper service reads.
function toPcm16(parts, rate) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const all = new Float32Array(len);
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  const ratio = rate / 16000;
  const out = new Int16Array(Math.floor(len / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(len, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b; j++) s += all[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

// Ask for the microphone while a tap still counts as a user gesture, so the browser shows its
// permission prompt instead of quietly blocking a later, timer-driven start. Resolves to true,
// or to the DOMException name when access is refused.
let micGranted = false;
function primeMic() {
  if (micGranted || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return Promise.resolve(true);
  return navigator.mediaDevices.getUserMedia({ audio: true }).then(
    (s) => { s.getTracks().forEach((t) => t.stop()); micGranted = true; return true; },
    (e) => e.name || 'NotAllowedError',
  );
}

// What the restaurant's voice service offers right now, and the staff's tablet settings.
function useVoiceInfo() {
  const [info, setInfo] = useState({ engine: 'browser', tts: 'browser', languages: ['en'], vad: 'normal', offlineOnly: false });
  useEffect(() => {
    const check = () => fetch('/api/voice', { cache: 'no-store' }).then((r) => r.json())
      .then((d) => setInfo((prev) => (JSON.stringify(prev) === JSON.stringify(d) ? prev : d))).catch(() => {});
    check();
    const id = setInterval(check, 30000);
    return () => clearInterval(id);
  }, []);
  return info;
}

const tableFromUrl = () => 'T' + Number((location.pathname.match(/\/table\/(\d+)/) || [])[1] || 1);

// Remounting the tablet when service resumes reopens its live connection.
function TableApp() {
  const cfg = useRestaurant();
  const table = tableFromUrl();
  return (
    <RestaurantContext.Provider value={cfg || { restaurant: '', service: { state: 'active', active: true, linked: true } }}>
      {!cfg ? <Loading label="Connecting to the restaurant…" />
        : !cfg.service.active ? <ServicePaused state={cfg.service.state} />
        : <TableScreen table={table} />}
    </RestaurantContext.Provider>
  );
}

function TableScreen({ table }) {
  const { restaurant } = useContext(RestaurantContext);
  const { snap, online, now } = useLive(`/api/tables/${table}/events`);
  const voice = useVoiceInfo();
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [voiceState, setVoiceState] = useState('standby');
  const [toasts, toast] = useToasts();
  const t = ui(prefs.lang);
  useEffect(() => { document.title = `${tableName(table)} · ${restaurant}`; }, [table, restaurant]);
  useEffect(() => { document.documentElement.lang = prefs.lang; }, [prefs.lang]);
  return (
    <PrefsContext.Provider value={{ prefs, setPrefs }}>
      <div className="min-h-full" style={{ zoom: prefs.large ? 1.2 : 1 }}>
        <header className="sticky z-50 pt-3 pb-2 gutter" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
          <nav className="max-w-[1400px] mx-auto glass-nav rounded-2xl px-3 sm:px-5 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="mr-auto"><Brand /></div>
            <span className="font-serif text-lg text-ink">{tableName(table)}</span>
            <LanguagePicker compact />
            <DisplaySettings />
            <LiveBadge online={online} />
            <div className={'flex items-center gap-2 rounded-full pl-2.5 pr-3 py-1.5 text-xs font-medium border ' + (voiceState === 'listening' ? 'border-[#E3B9AE] bg-[#FBEFEB] text-[#8A2E1C]' : voiceState === 'cooldown' ? 'border-[#EBC88F] bg-[#FFF4E5] text-[#7A4B06]' : 'border-line bg-cream text-ink')} aria-live="polite">
              <Waveform state={voiceState} size="sm" />
              <span className="whitespace-nowrap">{VOICE_LABEL[voiceState]}</span>
            </div>
          </nav>
        </header>
        {snap ? <Tablet table={table} state={snap} voice={voice} setVoiceState={setVoiceState} toast={toast} now={now} t={t} /> : <Loading label="Connecting to the restaurant…" />}
        <Toasts toasts={toasts} />
      </div>
    </PrefsContext.Provider>
  );
}

function LanguagePicker({ compact }) {
  const { prefs, setPrefs } = usePrefs();
  return (
    <div className="flex items-center">
      {!compact && <Icon name="globe" className="w-4 h-4 text-gold-dark mx-1.5" />}
      <select aria-label={ui(prefs.lang).language} value={prefs.lang} onClick={(e) => e.stopPropagation()}
        onChange={(e) => setPrefs((p) => ({ ...p, lang: e.target.value }))}
        className={'max-w-[min(13rem,45vw)] rounded-full border border-line bg-cream text-ink focus:outline-none focus:ring-2 focus:ring-gold/50 ' + (compact ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm')}>
        {LANGS.map((l) => <option key={l.id} value={l.id} lang={l.id}>{l.label}</option>)}
      </select>
    </div>
  );
}

// Larger text, a slower voice and more time to speak, for whoever is at the table.
function DisplaySettings() {
  const { prefs, setPrefs } = usePrefs();
  const t = ui(prefs.lang);
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const opt = (key, label) => (
    <label className="flex items-center justify-between gap-4 py-2 cursor-pointer">
      <span className="text-sm">{label}</span>
      <input type="checkbox" checked={prefs[key]} onChange={() => setPrefs((p) => ({ ...p, [key]: !p[key] }))} className="w-5 h-5 accent-[#B8862F]" />
    </label>
  );
  return (
    <div className="relative" ref={box}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={t.settings} title={t.settings}
        className={'w-9 h-9 rounded-full border flex items-center justify-center ' + (prefs.large || prefs.slow || prefs.patient ? 'border-gold bg-gold-wash text-ink' : 'border-line bg-cream text-ink')}>
        <Icon name="text" className="w-5 h-5" />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 glass-strong rounded-2xl shadow-2xl p-4 z-[60]">
          <p className="label mb-1">{t.settings}</p>
          {opt('large', t.largeText)}
          {opt('slow', t.slowVoice)}
          {opt('patient', t.patient)}
          <div className="mt-2 pt-3 border-t border-line"><p className="label mb-2">{t.language}</p><LanguagePicker /></div>
        </div>
      )}
    </div>
  );
}

function Tablet({ table, state, voice, setVoiceState, toast, now, t }) {
  const { menu, cart, orders: tableOrders, requests } = state;
  const { prefs, setPrefs } = usePrefs();
  const lang = prefs.lang;
  const [session, setSession] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [drawer, setDrawer] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sent, setSent] = useState(null); // { id, undoUntil } for the overlay after sending
  const [upsellDone, setUpsellDone] = useState(false);
  const [caption, setCaption] = useState(null);
  const [remaining, setRemaining] = useState(IDLE_LIMIT);
  const [customizing, setCustomizing] = useState(null);
  const [serverCall, setServerCall] = useState(null);
  const [liveFeed, setLiveFeed] = useState([]);
  const [cartPulse, setCartPulse] = useState(0);
  const lastAct = useRef(Date.now());
  const voiceRef = useRef(null);
  const warnedRef = useRef(false);
  const visible = true;

  const bump = useCallback(() => { lastAct.current = Date.now(); }, []);
  const pushFeed = useCallback((text) => setLiveFeed((f) => [{ id: Math.random(), text, at: Date.now() }, ...f].slice(0, 6)), []);
  const call = useCallback(async (path, method, body) => {
    try { return await api(`/api/tables/${table}${path}`, method, body); } catch (e) { toast(e.message, 'warn'); return null; }
  }, [table, toast]);

  // Kitchen and staff updates arrive through the live snapshot.
  const prevOrders = useRef(null);
  useEffect(() => {
    const prev = prevOrders.current;
    if (prev) for (const o of tableOrders) {
      const before = prev.find((x) => x.id === o.id);
      if (before && before.status !== o.status) {
        const msg = o.status === 'kitchen' ? `Order ${o.id} is being prepared` : `Order ${o.id} has been served. Enjoy!`;
        pushFeed(msg); toast(msg);
      }
    }
    prevOrders.current = tableOrders;
  }, [tableOrders, pushFeed, toast]);

  const endSession = useCallback((why) => {
    voiceRef.current && voiceRef.current.reset();
    call('/reset', 'POST', {});
    setFilters(EMPTY_FILTERS);
    setDrawer(false); setConfirm(false); setSent(null); setCustomizing(null); setLiveFeed([]); setServerCall(null); setCaption(null); setUpsellDone(false);
    setSession(false);
    setPrefs(DEFAULT_PREFS);
    setRemaining(IDLE_LIMIT);
    if (why === 'timeout') toast(`Session reset after ${IDLE_LIMIT} seconds of inactivity. Cart and filters cleared.`, 'warn');
  }, [call, toast, setPrefs]);
  const endRef = useRef(endSession); endRef.current = endSession;

  const [autoListen, setAutoListen] = useState(false);
  const startSession = useCallback(async (withVoice) => {
    lastAct.current = Date.now();
    warnedRef.current = false;
    setRemaining(IDLE_LIMIT);
    setAutoListen(withVoice);
    setSession(true);
  }, []);

  useEffect(() => { setVoiceState((s) => (session ? (s === 'standby' ? 'idle' : s) : 'standby')); }, [session, setVoiceState]);

  // Inactivity lifecycle. Dialogs the guest is reading (confirm, order sent) count as activity.
  const tRef = useRef(t); tRef.current = t;
  useEffect(() => {
    if (!session || !visible) return;
    lastAct.current = Date.now();
    const id = setInterval(() => {
      const vs = voiceRef.current && voiceRef.current.state();
      if (vs && vs !== 'idle' && vs !== 'cooldown') lastAct.current = Date.now();
      const rem = Math.max(0, IDLE_LIMIT - Math.floor((Date.now() - lastAct.current) / 1000));
      setRemaining(rem);
      if (rem <= WARN_AT && rem > 0 && !warnedRef.current) {
        warnedRef.current = true;
        chime('warn');
        voiceRef.current && voiceRef.current.say(tRef.current.stillThereSay(WARN_AT), true);
      }
      if (rem > WARN_AT) warnedRef.current = false;
      if (rem <= 0) endRef.current('timeout');
    }, 250);
    return () => clearInterval(id);
  }, [session, visible]);

  const shown = useMemo(() => menu.filter((m) => matchesFilters(m, filters)), [menu, filters]);
  const cartCount = cart.reduce((s, l) => s + l.qty, 0);
  const cartTotals = totals(menu, cart);
  const L = labels(lang);

  const addLine = useCallback(async (itemId, qty, mods) => {
    const item = menu.find((m) => m.id === itemId);
    if (!(await call('/cart', 'POST', { itemId, qty, mods }))) return false;
    setCartPulse((p) => p + 1);
    pushFeed(`Touch: added ${qty} × ${item.name}${mods.length ? ' (' + modsText(mods) + ')' : ''} · ${fmt(priceLine(menu, { itemId, qty, mods }).total)}`);
    toast(`${dishName(item, lang)} ✓`);
    return true;
  }, [menu, call, pushFeed, toast, lang]);

  const callServer = useCallback(async (reason) => {
    if (!(await call('/requests', 'POST', { type: 'server', ...(reason ? { reason } : {}) }))) return;
    setServerCall({ at: Date.now() });
    pushFeed('Server called to ' + tableName(table));
    toast(t.serverOnWay);
  }, [call, table, toast, pushFeed, t]);

  const requestBill = useCallback(async (split) => {
    if (!(await call('/requests', 'POST', { type: 'bill', split }))) return;
    pushFeed(`Bill requested${split > 1 ? `, split ${split} ways` : ''}`);
    toast(t.billOnWay);
  }, [call, toast, pushFeed, t]);

  // "Send to kitchen" always goes through the read-back dialog first.
  const placeOrder = useCallback(async () => {
    const r = await call('/orders', 'POST', {});
    if (!r) return;
    setConfirm(false); setDrawer(false); setUpsellDone(false);
    setSent({ id: r.orderId, undoUntil: r.undoUntil });
    chime('order');
    pushFeed(`Order ${r.orderId} sent to the kitchen`);
  }, [call, pushFeed]);

  const undoOrder = useCallback(async (id) => {
    if (!(await call(`/orders/${id}/cancel`, 'POST', {}))) return;
    setSent(null);
    toast(t.undone(id));
    pushFeed(`Order ${id} taken back`);
    setTimeout(() => setDrawer(true), 300);
  }, [call, toast, pushFeed, t]);

  // Results of a server-side assistant turn
  const onAssistant = useCallback((res) => {
    const fx = res.effects || {};
    if (fx.filters) { setFilters(fx.filters); pushFeed('Filters applied: ' + describeFilters(fx.filters)); }
    if (fx.serverCalled) { setServerCall({ at: Date.now() }); pushFeed('Server called by voice'); }
    for (const c of res.inspected || []) {
      if (c.ok && c.tool === 'add_to_cart') {
        const item = menu.find((m) => m.id === c.args.item_id);
        if (item && item.available) { setCartPulse((p) => p + 1); pushFeed(`Voice: added ${c.args.qty} × ${item.name}${c.args.modifiers.length ? ' (' + modsText(c.args.modifiers) + ')' : ''}`); }
      }
      if (c.ok && c.tool === 'set_instructions') pushFeed('Special instruction noted: ' + c.args.text);
    }
    if (fx.upsellAdded) { setCartPulse((p) => p + 1); setUpsellDone(true); }
    if (fx.openConfirm) { setDrawer(false); setConfirm(true); setUpsellDone(true); }
    if (fx.closeConfirm) setConfirm(false);
    if (fx.orderPlaced) { setConfirm(false); setDrawer(false); setUpsellDone(false); setSent({ id: fx.orderPlaced.id, undoUntil: fx.orderPlaced.undoUntil }); chime('order'); }
    if (fx.orderCancelled) { setSent(null); pushFeed(`Order ${fx.orderCancelled} taken back`); }
    if (fx.openCart && !fx.openConfirm && !fx.orderPlaced) setTimeout(() => setDrawer(true), 400);
  }, [menu, pushFeed]);

  const serverReq = serverCall && requests.find((r) => r.type === 'server' && r.at >= serverCall.at - 5000);
  const serverFree = !serverCall || (serverReq && serverReq.status === 'done');
  const saveNote = useCallback((n) => call('/note', 'PUT', { note: n }), [call]);
  const upsell = !upsellDone && upsellFor(menu, cart);

  return (
    <main className="gutter pb-28" onPointerDownCapture={bump} onKeyDownCapture={bump} onWheel={bump} onTouchStart={bump}>
      {!session ? (
        <Standby table={table} onStart={startSession} t={t} />
      ) : (
        <div className="max-w-[1400px] mx-auto">
          <section className="mt-3 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="on-photo text-[11px] tracking-[0.3em] text-[#6E5120] uppercase font-semibold">{tableName(table)} · {t.tonight}</p>
              <h1 className="font-serif text-3xl sm:text-[40px] leading-tight text-ink mt-1 text-balance">{t.whatLike}</h1>
            </div>
            <SessionRing remaining={remaining} />
          </section>

          <div className="mt-5 grid lg:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
            <div className="min-w-0 order-2 lg:order-1">
              <Preferences filters={filters} setFilters={setFilters} />
              <CategoryRail filters={filters} setFilters={setFilters} menu={menu} />
              <div className="flex items-baseline justify-between mt-6 mb-3 gap-3">
                <h2 className="on-photo font-serif text-2xl text-ink first-letter:uppercase">{lang === 'en' ? describeFilters(filters) : L.cats[filters.category]}</h2>
                <span className="on-photo text-sm text-ink/80 tabular-nums shrink-0">{t.dishes(shown.length)}</span>
              </div>
              {shown.length ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
                  {shown.map((item) => (
                    <ProductCard key={item.id} item={item} onAdd={() => setCustomizing(item)} onVoice={() => voiceRef.current && voiceRef.current.simulate('Add ' + item.name)} />
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-line bg-white/60 p-10 text-center">
                  <p className="font-serif text-xl">{t.nothingMatches}</p>
                  <p className="text-muted text-sm mt-1">{t.nothingHint}</p>
                  <button onClick={() => setFilters(EMPTY_FILTERS)} className="mt-4 btn-outline">{t.showFull}</button>
                </div>
              )}
            </div>
            <aside className="order-1 lg:order-2 lg:sticky lg:top-[96px] min-w-0">
              <VoiceAssistant ref={voiceRef} table={table} usage={state.usage} voice={voice} onResult={onAssistant} onCaption={setCaption}
                setVoiceState={setVoiceState} bump={bump} toast={toast} autoListen={autoListen} />
            </aside>
          </div>

          <button onClick={() => serverFree && callServer()}
            className={'fixed z-40 flex items-center gap-2 rounded-full px-4 py-3 shadow-xl border text-sm font-medium transition ' + (serverCall ? 'bg-white/70 backdrop-blur-xl border-white/80 text-ink' : 'bg-white/70 backdrop-blur-xl border-gold text-ink hover:bg-gold-wash')}
            style={{ left: 'max(16px, calc(env(safe-area-inset-left, 0px) + 16px))', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)' }}>
            <Icon name="bell" className="w-5 h-5 text-gold-dark" />
            {serverFree ? t.callServer : serverReq && serverReq.status === 'acknowledged' ? t.serverOnWay : t.serverCalled(mmss(now - serverCall.at))}
          </button>

          <button key={cartPulse} onClick={() => setDrawer(true)}
            className={'fixed z-40 flex items-center gap-3 rounded-full pl-4 pr-5 py-3 bg-ink text-cream shadow-xl hover:bg-black transition ' + (cartPulse ? 'cart-pulse' : '')}
            style={{ right: 'max(16px, calc(env(safe-area-inset-right, 0px) + 16px))', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)' }}>
            <Icon name="bag" className="w-5 h-5 text-gold" />
            <span className="text-sm">{t.yourOrder}</span>
            <span className="tabular-nums text-sm font-semibold">{cartCount ? `${cartCount} · ${fmt(cartTotals.total)}` : t.empty}</span>
          </button>

          {caption && <Caption text={caption} />}

          <CartDrawer open={drawer} onClose={() => setDrawer(false)} table={table} menu={menu} cart={cart} note={state.note} saveNote={saveNote} call={call} now={now}
            liveFeed={liveFeed} orders={tableOrders} onSend={() => { setDrawer(false); setConfirm(true); }} requestBill={requestBill} requests={requests}
            undoOrder={undoOrder} callServer={() => serverFree && callServer()} />
          {confirm && <ConfirmOrder menu={menu} cart={cart} note={state.note} upsell={upsell} onSend={placeOrder} onClose={() => setConfirm(false)}
            onAddUpsell={async (item) => { setUpsellDone(true); await addLine(item.id, 1, []); }} onSkipUpsell={() => setUpsellDone(true)} />}
          {sent && <OrderSent sent={sent} now={now} onUndo={() => undoOrder(sent.id)} onClose={() => setSent(null)} />}
          {customizing && <Customizer item={menu.find((m) => m.id === customizing.id)} onClose={() => setCustomizing(null)}
            onAsk={() => callServer(`Allergy question about the ${customizing.name}`)}
            onAdd={async (qty, mods) => { if (await addLine(customizing.id, qty, mods)) setCustomizing(null); }} />}
          {remaining <= WARN_AT && <StillThere remaining={remaining} onStay={() => { bump(); setRemaining(IDLE_LIMIT); }} />}
        </div>
      )}
    </main>
  );
}

// Every spoken reply is also shown large on screen, for guests who can't hear it in a busy room.
function Caption({ text }) {
  return (
    <div className="fixed z-[45] left-1/2 -translate-x-1/2 w-[min(760px,calc(100%-32px))] pointer-events-none"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)' }} aria-live="polite">
      <p className="toast-in rounded-2xl bg-ink/90 text-cream text-lg sm:text-xl leading-snug px-5 py-3 shadow-2xl text-center text-balance">{text}</p>
    </div>
  );
}

function SessionRing({ remaining }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const warning = remaining <= WARN_AT;
  const color = warning ? '#B5462E' : '#C89547';

  return (
    <svg width="56" height="56" viewBox="0 0 56 56" role="img" aria-label={`${remaining} seconds until session reset`}>
      <circle cx="28" cy="28" r={radius} fill="none" stroke="#EFE8DC" strokeWidth="4" />
      <circle cx="28" cy="28" r={radius} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - remaining / IDLE_LIMIT)} transform="rotate(-90 28 28)"
        style={{ transition: 'stroke-dashoffset .25s linear' }} />
      <text x="28" y="33" textAnchor="middle" className="tabular-nums" fontSize="15" fontWeight="600" fill={color}>{remaining}</text>
    </svg>
  );
}

function Standby({ table, onStart, t }) {
  const { restaurant } = useContext(RestaurantContext);
  const { prefs } = usePrefs();
  const examples = { en: [['"Something spicy and vegetarian"', 'Filters the menu to match'], ['"Risotto, extra cheese, no garlic"', 'Adds it with your changes'], ['"Split the bill four ways"', 'Lets your server know']] }[prefs.lang]
    || (EXAMPLES[prefs.lang] || []).slice(0, 3).map((q) => [`"${q}"`, '']);
  return (
    <section className="max-w-[1400px] mx-auto mt-3 cursor-pointer" onClick={() => onStart(false)}>
      <div className="glass relative overflow-hidden rounded-[28px] px-6 py-14 sm:py-20 text-center">
        <div className="standby-rings" aria-hidden="true"><span /><span /><span /></div>
        <p className="relative text-[11px] tracking-[0.4em] text-gold-dark uppercase">{tableName(table)} · {t.welcomeTo(restaurant)}</p>
        <h1 className="relative font-serif text-4xl sm:text-6xl text-ink mt-4 leading-[1.08] text-balance">{timeGreeting(prefs.lang)}.<br /><em className="text-gold-dark">{t.tableReady}</em></h1>
        <p className="relative text-muted mt-5 max-w-md mx-auto">{t.standbyText}</p>
        <div className="relative mt-7 flex justify-center"><LanguagePicker /></div>
        <div className="relative mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
          <button onClick={(e) => { e.stopPropagation(); primeMic(); onStart(true); }} className="btn-gold text-base px-7 py-3.5">
            <Icon name="mic" className="w-5 h-5" /> {t.activate}
          </button>
          <span className="text-sm text-muted">{t.tapAnywhere}</span>
        </div>
        <div className="relative mt-12 grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl mx-auto text-left">
          {examples.map(([q, a]) => (
            <div key={q} className="glass-chip rounded-xl border px-4 py-3">
              <p className="font-serif italic text-ink">{q}</p>
              {a && <p className="text-xs text-muted mt-1">{a}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function StillThere({ remaining, onStay }) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-[60] bg-ink/40 backdrop-blur-[2px] flex items-center justify-center gutter" onClick={onStay}>
      <div className="glass-strong rounded-3xl shadow-2xl max-w-sm w-full p-7 text-center" role="alertdialog" aria-labelledby="still-title">
        <div className="mx-auto w-16 h-16 rounded-full bg-[#FBEAE6] text-[#B5462E] flex items-center justify-center font-serif text-3xl tabular-nums">{remaining}</div>
        <h2 id="still-title" className="font-serif text-2xl mt-4">{t.stillThere}</h2>
        <p className="text-muted text-sm mt-2">{t.resetting(remaining)}</p>
        <button className="btn-gold mt-5 w-full justify-center" onClick={onStay}>{t.stillHere}</button>
      </div>
    </div>
  );
}

function Preferences({ filters, setFilters }) {
  const { prefs } = usePrefs();
  const t = ui(prefs.lang);
  const L = labels(prefs.lang);
  const toggles = [
    ['veg', filters.diet === 'veg' && !filters.vegan && !filters.jain, () => setFilters((f) => ({ ...f, diet: f.diet === 'veg' && !f.vegan && !f.jain ? null : 'veg', vegan: false, jain: false }))],
    ['nonveg', filters.diet === 'nonveg', () => setFilters((f) => ({ ...f, diet: f.diet === 'nonveg' ? null : 'nonveg', vegan: false, jain: false }))],
    ['vegan', filters.vegan, () => setFilters((f) => ({ ...f, vegan: !f.vegan, diet: !f.vegan ? 'veg' : f.diet }))],
    ['jain', filters.jain, () => setFilters((f) => ({ ...f, jain: !f.jain, diet: !f.jain ? 'veg' : f.diet }))],
    ['halal', filters.halal, () => setFilters((f) => ({ ...f, halal: !f.halal }))],
    ['gf', filters.gf, () => setFilters((f) => ({ ...f, gf: !f.gf }))],
    ['spicy', filters.spice === 'spicy', () => setFilters((f) => ({ ...f, spice: f.spice === 'spicy' ? null : 'spicy' }))],
  ];
  const meals = ['breakfast', 'lunch', 'dinner'];
  const mealIdx = useRef(0);
  if (filters.meal) mealIdx.current = meals.indexOf(filters.meal);
  const extra = [
    filters.spice === 'mild' && [L.chips.mild, () => setFilters((f) => ({ ...f, spice: null }))],
    filters.maxPrice && [L.chips.under(fmt(filters.maxPrice).replace('.00', '')), () => setFilters((f) => ({ ...f, maxPrice: null }))],
    ...(filters.avoid || []).map((a) => [L.chips.without(allergenName(prefs.lang, a, ALLERGENS[a].label)), () => setFilters((f) => ({ ...f, avoid: f.avoid.filter((x) => x !== a) }))]),
  ].filter(Boolean);
  const anyOn = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);
  return (
    <div className="glass rounded-2xl p-3 sm:p-4 flex flex-wrap items-center gap-x-5 gap-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label">{t.dietary}</span>
        {toggles.map(([key, on, fn]) => (
          <button key={key} onClick={fn} aria-pressed={on} className={'chip ' + (on ? 'chip-on' : '')}>
            {key === 'veg' && <DietMark diet="veg" />}{key === 'nonveg' && <DietMark diet="nonveg" />}{key === 'spicy' && <Chili on />}{L.chips[key]}
          </button>
        ))}
        {extra.map(([label, fn]) => <button key={label} onClick={fn} className="chip chip-on">{label} <Icon name="x" className="w-3 h-3" /></button>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="label">{t.meal}</span>
        <div className="relative grid grid-cols-3 bg-sand rounded-full p-0.5">
          {/* One pill slides between options; when no meal is picked it fades out where it last was. */}
          <span aria-hidden="true" className="absolute top-0.5 bottom-0.5 left-0.5 w-[calc((100%-4px)/3)] rounded-full bg-white shadow transition-[transform,opacity] duration-300 ease-[cubic-bezier(.2,.8,.2,1)]"
            style={{ transform: `translateX(${mealIdx.current * 100}%) scale(${filters.meal ? 1 : 0.85})`, opacity: filters.meal ? 1 : 0 }} />
          {meals.map((m) => (
            <button key={m} onClick={() => setFilters((f) => ({ ...f, meal: f.meal === m ? null : m }))} aria-pressed={filters.meal === m}
              className={'relative px-3 py-1 rounded-full text-[13px] transition-colors duration-300 ' + (filters.meal === m ? 'text-ink' : 'text-muted hover:text-ink')}>{L.meals[m]}</button>
          ))}
        </div>
      </div>
      {anyOn && <button onClick={() => setFilters(EMPTY_FILTERS)} className="text-sm text-gold-dark hover:underline ml-auto">{t.clearAll}</button>}
    </div>
  );
}

function CategoryRail({ filters, setFilters, menu }) {
  const L = labels(usePrefs().prefs.lang);
  return (
    <div className="glass rounded-2xl mt-5 px-2 pt-3 pb-2">
      <div className="overflow-x-auto no-scrollbar">
        <div className="flex gap-4 sm:gap-6 px-1 pb-1 min-w-max">
          {CATEGORIES.map((c) => {
            const on = filters.category === c.id;
            const count = c.id === 'all' ? menu.length : c.id === 'specials' ? menu.filter((m) => m.chefSpecial).length : menu.filter((m) => m.category === c.id).length;
            return (
              <button key={c.id} onClick={() => setFilters((f) => ({ ...f, category: c.id }))} aria-pressed={on} className="group flex flex-col items-center gap-2 w-[76px]">
                <span className={'w-[66px] h-[66px] rounded-full flex items-center justify-center border transition ' + (on ? 'bg-ink border-ink text-gold shadow-lg' : 'glass-chip text-ink group-hover:border-gold')}>
                  <Icon name={c.id} className="w-7 h-7" />
                </span>
                <span className={'text-[12.5px] text-center leading-tight ' + (on ? 'text-ink font-semibold' : 'text-muted')}>{L.cats[c.id] || c.label}</span>
                <span className="text-[10.5px] text-muted/80 -mt-1.5 tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stars({ rating }) {
  return (
    <span className="inline-flex items-center gap-1 text-[12.5px] text-ink">
      <Icon name="star" className="w-3.5 h-3.5 fill-gold text-gold" />
      <span className="font-semibold tabular-nums">{rating.toFixed(1)}</span>
    </span>
  );
}

function ProductCard({ item, onAdd, onVoice }) {
  const { prefs } = usePrefs();
  const t = ui(prefs.lang);
  const L = labels(prefs.lang);
  const name = dishName(item, prefs.lang);
  const off = !item.available;
  return (
    <article className={'group glass-strong rounded-2xl overflow-hidden flex flex-col transition ' + (off ? 'opacity-60' : 'hover:shadow-[0_18px_40px_-20px_rgba(60,40,10,0.35)] hover:-translate-y-0.5')}>
      <div className={'relative aspect-[4/3] max-w-full overflow-hidden bg-sand ' + (off ? 'grayscale' : '')}>
        <DishImage item={item} className="transition duration-500 group-hover:scale-[1.03]" />
        <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
          {item.chefSpecial && <span className="tag bg-ink text-gold">{t.chefSpecial}</span>}
          {item.isNew && <span className="tag bg-gold text-white">{t.isNew}</span>}
        </div>
        {off && <div className="absolute inset-0 flex items-center justify-center"><span className="bg-white/95 text-ink text-xs tracking-[0.2em] uppercase px-3 py-1.5 rounded-full border border-line">{t.unavailable}</span></div>}
      </div>
      <div className="p-4 flex flex-col flex-1 gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-serif text-[19px] leading-snug text-ink">{name}</h3>
            {name !== item.name && <p className="text-[12px] text-muted">{item.name}</p>}
          </div>
          <DietMark diet={item.diet} />
        </div>
        <p className="text-[13px] text-muted leading-relaxed line-clamp-2">{item.desc}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-0.5">
          {item.rating ? <span className="flex items-center gap-1"><Stars rating={item.rating} /><span className="text-[11.5px] text-muted tabular-nums">({item.reviews})</span></span> : <span className="text-[12px] text-gold-dark">{t.newDish}</span>}
          {item.spicy > 0 && <span className="flex" title={`Spice level ${item.spicy} of 3`}>{[1, 2, 3].map((n) => <Chili key={n} on={n <= item.spicy} />)}</span>}
          {item.vegan && <span className="mini-tag">{L.chips.vegan}</span>}
          {item.jain && <span className="mini-tag">{L.chips.jain}</span>}
          {item.halal && <span className="mini-tag">{L.chips.halal}</span>}
          {item.gf && <span className="mini-tag">GF</span>}
        </div>
        <div className="mt-auto pt-3 flex items-center justify-between gap-2">
          <span className="font-serif text-xl text-ink tabular-nums">{fmt(item.price)}</span>
          <div className="flex items-center gap-1.5">
            <button onClick={onVoice} disabled={off} title={`Say "Add ${item.name}"`} aria-label={`Order ${item.name} by voice`} className="w-9 h-9 rounded-full border border-line flex items-center justify-center text-gold-dark hover:border-gold disabled:opacity-40 disabled:cursor-not-allowed">
              <Icon name="mic" className="w-4 h-4" />
            </button>
            <button onClick={onAdd} disabled={off} className="btn-gold py-2 px-4 text-sm disabled:bg-[#CFC6B8] disabled:cursor-not-allowed">{t.add}</button>
          </div>
        </div>
      </div>
    </article>
  );
}

function Customizer({ item, onClose, onAdd, onAsk }) {
  const { prefs } = usePrefs();
  const t = ui(prefs.lang);
  const [qty, setQty] = useState(1);
  const [mods, setMods] = useState([]);
  const [asked, setAsked] = useState(false);
  const allowed = allowedMods(item);
  const exclusive = ['medium_rare', 'medium', 'well_done'];
  const toggle = (k) => setMods((m) => (m.includes(k) ? m.filter((x) => x !== k) : [...m.filter((x) => !(exclusive.includes(k) && exclusive.includes(x)) && !(k === 'mild' && x === 'extra_spicy') && !(k === 'extra_spicy' && x === 'mild')), k]));
  const line = priceLine([item], { itemId: item.id, qty, mods });
  const allergens = item.allergens.map((a) => allergenName(prefs.lang, a, ALLERGENS[a] ? ALLERGENS[a].label : a)).join(', ');
  return (
    <div className="fixed inset-0 z-[55] bg-ink/40 flex items-end sm:items-center justify-center sm:gutter" onClick={onClose}>
      <div className="glass-strong w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Customize ${item.name}`}>
        <div className="h-40 relative"><DishImage item={item} /><button onClick={onClose} className="absolute top-3 right-3 w-9 h-9 rounded-full bg-white/90 flex items-center justify-center" aria-label="Close"><Icon name="x" className="w-4 h-4" /></button></div>
        <div className="p-5" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)' }}>
          <h3 className="font-serif text-2xl">{dishName(item, prefs.lang)}</h3>
          <p className="text-sm text-muted mt-1">{item.desc}</p>
          {item.allergensChecked ? (
            <p className="text-xs text-ink mt-2 flex items-start gap-1.5"><Icon name="shield" className="w-4 h-4 text-veg shrink-0" />{allergens ? t.contains(allergens) : t.noAllergens}</p>
          ) : (
            <div className="mt-2 rounded-xl bg-[#FFF4E5] border border-[#EBC88F] px-3 py-2 text-xs text-[#7A4B06] flex flex-wrap items-center justify-between gap-2">
              <span>{t.allergensUnchecked}</span>
              <button type="button" disabled={asked} onClick={() => { setAsked(true); onAsk(); }} className="font-semibold underline disabled:no-underline disabled:opacity-60">{asked ? t.serverOnWay : t.askAllergens}</button>
            </div>
          )}
          <p className="label mt-4 mb-2">{t.makeItYours}</p>
          <div className="flex flex-wrap gap-2">
            {allowed.map((k) => (
              <button key={k} onClick={() => toggle(k)} aria-pressed={mods.includes(k)} className={'chip ' + (mods.includes(k) ? 'chip-on' : '')}>
                {MODIFIERS[k].label}{MODIFIERS[k].price ? <span className="opacity-70 tabular-nums">+{fmt(MODIFIERS[k].price)}</span> : null}
              </button>
            ))}
          </div>
          <div className="mt-5 flex items-center gap-3">
            <div className="flex items-center border border-line rounded-full">
              <button className="w-10 h-10 text-lg" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Decrease quantity">{'−'}</button>
              <span className="w-6 text-center tabular-nums font-medium">{qty}</span>
              <button className="w-10 h-10 text-lg" onClick={() => setQty((q) => Math.min(10, q + 1))} aria-label="Increase quantity">+</button>
            </div>
            <button className="btn-gold flex-1 justify-between" onClick={() => onAdd(qty, mods)}><span>{t.addToOrder}</span><span className="tabular-nums">{fmt(line.total)}</span></button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Read-back before anything reaches the kitchen, with the owner's suggested pairing offered once.
function ConfirmOrder({ menu, cart, note, upsell, onSend, onClose, onAddUpsell, onSkipUpsell }) {
  const { prefs } = usePrefs();
  const t = ui(prefs.lang);
  const [sending, setSending] = useState(false);
  const lines = cart.filter((l) => (menu.find((m) => m.id === l.itemId) || {}).available);
  const tot = totals(menu, lines);
  return (
    <div className="fixed inset-0 z-[58] bg-ink/45 flex items-end sm:items-center justify-center sm:gutter" onClick={onClose}>
      <div className="glass-strong w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="confirm-title"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }}>
        <h2 id="confirm-title" className="font-serif text-3xl">{t.checkOrder}</h2>
        <p className="text-sm text-muted mt-1">{t.checkHint}</p>
        <ul className="mt-4 flex flex-col divide-y divide-line text-[15px]">
          {lines.map((l) => {
            const item = menu.find((m) => m.id === l.itemId);
            return (
              <li key={l.id} className="py-2.5 flex justify-between gap-3">
                <span className="min-w-0"><span className="font-semibold tabular-nums">{l.qty} ×</span> {dishName(item, prefs.lang)}{l.mods.length > 0 && <span className="block text-[13px] text-muted">{modsText(l.mods)}</span>}</span>
                <span className="tabular-nums shrink-0">{fmt(priceLine(menu, l).total)}</span>
              </li>
            );
          })}
        </ul>
        {note && <p className="mt-3 text-[13px] bg-[#FFF4E5] text-[#7A4B06] rounded-lg px-3 py-2"><strong>{t.specialInstructions}:</strong> {note}</p>}
        {upsell && (
          <div className="mt-4 rounded-2xl border border-gold/60 bg-gold-wash p-3 flex items-center gap-3">
            <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0 bg-sand"><DishImage item={upsell.item} /></div>
            <div className="min-w-0 flex-1">
              <p className="label">{t.goesWell}</p>
              <p className="font-medium">{dishName(upsell.item, prefs.lang)}</p>
            </div>
            <div className="flex flex-col gap-1 items-end">
              <button className="btn-gold py-1.5 px-3 text-sm" onClick={() => onAddUpsell(upsell.item)}>{t.addFor(fmt(upsell.item.price))}</button>
              <button className="text-[12px] text-muted hover:text-ink" onClick={onSkipUpsell} aria-label="No thanks"><Icon name="x" className="w-3.5 h-3.5 inline" /></button>
            </div>
          </div>
        )}
        <div className="mt-4 text-sm tabular-nums">
          <div className="flex justify-between text-muted"><span>{t.subtotal}</span><span>{fmt(tot.subtotal)}</span></div>
          <div className="flex justify-between text-muted"><span>{t.tax}</span><span>{fmt(tot.tax)}</span></div>
          <div className="flex justify-between font-serif text-2xl mt-1"><span>{t.total}</span><span>{fmt(tot.total)}</span></div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button className="btn-outline justify-center" onClick={onClose}>{t.keepEditing}</button>
          <button className="btn-gold justify-center disabled:bg-[#CFC6B8]" disabled={!lines.length || sending} onClick={async () => { setSending(true); await onSend(); setSending(false); }}>{t.sendToKitchen}</button>
        </div>
      </div>
    </div>
  );
}

// A clear "it worked" moment after sending, with a one-minute undo.
function OrderSent({ sent, now, onUndo, onClose }) {
  const t = useT();
  const left = Math.max(0, sent.undoUntil - now);
  useEffect(() => { const id = setTimeout(onClose, 8000); return () => clearTimeout(id); }, [sent.id]);
  return (
    <div className="fixed inset-0 z-[58] bg-ink/45 flex items-center justify-center gutter" onClick={onClose}>
      <div className="glass-strong rounded-3xl shadow-2xl max-w-sm w-full p-7 text-center" role="alertdialog" aria-labelledby="sent-title" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto w-20 h-20 rounded-full bg-veg text-white flex items-center justify-center sent-pop"><Icon name="check" className="w-10 h-10" /></div>
        <h2 id="sent-title" className="font-serif text-2xl mt-4">{t.orderSent(sent.id)}</h2>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button className="btn-outline justify-center disabled:opacity-40" disabled={!left} onClick={onUndo}><Icon name="undo" className="w-4 h-4" />{left ? t.undoFor(mmss(left)) : t.undo}</button>
          <button className="btn-gold justify-center" onClick={onClose}>{t.done}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Voice assistant ----------------
const VoiceAssistant = React.forwardRef(function VoiceAssistant({ table, usage, voice, onResult, onCaption, setVoiceState, bump, toast, autoListen }, ref) {
  const { restaurant } = useContext(RestaurantContext);
  const { prefs } = usePrefs();
  const t = ui(prefs.lang);
  const [vstate, setV] = useState('idle');
  const [interim, setInterim] = useState('');
  const turnMs = prefs.patient ? LONG_TURN_MS : MAX_TURN_MS;
  const [turnLeft, setTurnLeft] = useState(turnMs);
  const [log, setLog] = useState(() => [{ id: 0, role: 'assistant', text: t.greeting(restaurant) }]);
  const [typed, setTyped] = useState('');
  const [sound, setSound] = useState(true);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [micNote, setMicNote] = useState('');
  const [tick, setTick] = useState(0);
  const stRef = useRef('idle'); const interimRef = useRef(''); const turnRef = useRef(0);
  const recRef = useRef(null); const timersRef = useRef([]);
  const vadRef = useRef(null); const vadKey = useRef(''); const vadEvents = useRef(VAD_IDLE);
  const emptyRef = useRef(0); const logEnd = useRef(null); const holdRef = useRef(false); const pressRef = useRef(null);
  const ctx = useRef({}); ctx.current = { sound, onResult, onCaption, prefs, t, voice, turnMs };
  // 'whisper' when the restaurant's Whisper service is up, otherwise the browser's recognizer.
  const [engine, setEngine] = useState(voice.engine); const engineRef = useRef(voice.engine);
  useEffect(() => { engineRef.current = voice.engine; setEngine(voice.engine); }, [voice.engine]);
  // 'piper' when the voice service has Alice's Amy voice loaded, otherwise the browser's own voice.
  const audioRef = useRef(null); const speechSeq = useRef(0); const captionTimer = useRef(null);
  const voiceReady = useRef(voicesLoaded);
  const [phase, setPhase] = useState('');

  const setState = (s) => { stRef.current = s; setV(s); setVoiceState(s); };
  const later = (fn, ms) => { const id = setTimeout(fn, ms); timersRef.current.push(id); return id; };
  const clearTimers = () => { timersRef.current.forEach(clearTimeout); timersRef.current = []; };
  const addLog = (m) => setLog((l) => [...l, { id: Math.random(), ...m }].slice(-30));
  useEffect(() => { logEnd.current && logEnd.current.scrollIntoView({ block: 'nearest' }); }, [log, interim]);
  useEffect(() => () => {
    clearTimers(); stopRec(); stopSpeech(); clearTimeout(captionTimer.current);
    if (vadRef.current) vadRef.current.then((v) => v && v.destroy());
  }, []);

  // cooldown ticker
  useEffect(() => {
    if (!cooldownUntil) return;
    const id = setInterval(() => {
      setTick((n) => n + 1);
      if (Date.now() >= cooldownUntil) { setCooldownUntil(0); if (stRef.current === 'cooldown') setState('idle'); }
    }, 500);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  function stopRec() { try { recRef.current && recRef.current.abort(); } catch (e) {} recRef.current = null; }

  // Stops whatever is being said, by either voice, and keeps any Amy audio still loading quiet.
  function stopSpeech() {
    speechSeq.current++;
    try { speechSynthesis.cancel(); } catch (e) {}
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
  }

  function browserSpeak(text, finish) {
    try {
      const { prefs: p, voice: v } = ctx.current;
      const chosen = preferredVoice(p.lang, v.offlineOnly);
      if (!chosen && (p.lang !== 'en' || v.offlineOnly)) return; // no suitable voice: the caption carries it
      // Chrome's Google voices can stop partway through a long utterance, so queue one sentence at a time.
      const parts = text.split(/(?<=[.!?।])\s+/).filter((s) => s.trim());
      parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part);
        if (chosen) { u.voice = chosen; u.lang = chosen.lang; }
        u.rate = p.slow ? VOICE_RATE.slow : VOICE_RATE.normal; u.pitch = 1;
        if (i === parts.length - 1) u.onend = finish;
        u.onerror = finish;
        speechSynthesis.speak(u);
      });
    } catch (e) { /* no TTS available; say() has a timing fallback */ }
  }

  // Alice's "Amy" voice (Piper), synthesized by the restaurant's voice service. Any failure falls
  // back to the browser's voice so the guest still hears the reply.
  async function piperSpeak(text, finish, seq) {
    try {
      const res = await fetch(`/api/tables/${table}/speak`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, rate: ctx.current.prefs.slow ? 'slow' : 'normal', lang: ctx.current.prefs.lang }) });
      if (!res.ok) throw new Error('speak ' + res.status);
      const url = URL.createObjectURL(await res.blob());
      if (seq !== speechSeq.current) { URL.revokeObjectURL(url); return; }
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = a.onerror = () => { URL.revokeObjectURL(url); if (audioRef.current === a) audioRef.current = null; finish(); };
      await a.play();
    } catch (e) {
      if (seq === speechSeq.current) browserSpeak(text, finish);
    }
  }

  // Resolves when the line has been spoken (or the timing fallback fires). Every line is also captioned.
  function say(text, force) {
    const { prefs: p, voice: v } = ctx.current;
    // The British browser voice wins when present; Amy (Piper) is the next choice, in English.
    const piper = p.lang === 'en' && !preferredVoice('en', v.offlineOnly) && v.tts === 'piper';
    const rate = p.slow ? VOICE_RATE.slow : VOICE_RATE.normal;
    // Fallback in case no end event arrives: generous, so listening never starts over the reply.
    const est = piper ? Math.max(1400, text.length * (p.slow ? 95 : 75)) + 3000 : Math.max(1400, (text.length * 70) / rate) + 2000;
    const turn = turnRef.current;
    if (!force) setState('speaking');
    clearTimeout(captionTimer.current);
    ctx.current.onCaption(text);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        captionTimer.current = setTimeout(() => ctx.current.onCaption(null), 3500);
        if (!force && turnRef.current === turn && stRef.current === 'speaking') setState('idle');
        resolve();
      };
      stopSpeech();
      if (ctx.current.sound) (piper ? piperSpeak(text, finish, speechSeq.current) : browserSpeak(text, finish));
      later(finish, ctx.current.sound ? est : Math.min(7000, Math.max(1400, text.length * 52)));
    });
  }

  // Greet the guest (once we know which voice is available), then start listening when it's done.
  useEffect(() => {
    const turn = turnRef.current;
    Promise.resolve(voiceReady.current).then(() => say(t.greeting(restaurant), true))
      .then(() => { if (autoListen && turnRef.current === turn && stRef.current === 'idle') listen(); });
  }, []);
  // Switching language mid-session greets the guest again in the new language.
  const firstLang = useRef(prefs.lang);
  useEffect(() => {
    if (prefs.lang === firstLang.current) return;
    firstLang.current = prefs.lang;
    stopRec(); clearTimers(); turnRef.current++;
    if (stRef.current === 'listening') setState('idle');
    addLog({ role: 'assistant', text: t.greeting(restaurant) });
    say(t.greeting(restaurant), true);
  }, [prefs.lang]);

  function startCooldown(retryAfter) {
    setCooldownUntil(Date.now() + retryAfter * 1000);
    setState('cooldown');
  }
  function voiceBusy(secs) {
    addLog({ role: 'system', tone: 'warn', text: ctx.current.t.voiceBusy(secs) });
    startCooldown(secs);
  }

  // The browser only captures and trims speech. Guardrails, rate limiting, parsing,
  // schema validation and pricing all run on the server.
  async function submit(rawText, source) {
    bump();
    clearTimers(); stopRec();
    const turn = ++turnRef.current;
    setInterim(''); interimRef.current = '';
    const { text, truncated } = sanitizeTranscript(rawText);
    if (!text) { setState('idle'); return; }
    addLog({ role: 'user', text, source, truncated });
    setState('thinking');
    try {
      const res = await api(`/api/tables/${table}/assistant`, 'POST', { text, source, lang: ctx.current.prefs.lang });
      if (turnRef.current !== turn) return;
      addLog({ role: 'assistant', text: res.text, tone: res.tone, guard: res.guard, inspected: res.inspected });
      ctx.current.onResult(res);
      say(res.text);
    } catch (e) {
      if (turnRef.current !== turn) return;
      if (e.status === 429 && e.body.error === 'voice_busy') voiceBusy(e.body.retryAfter);
      else if (e.status === 429) {
        const secs = e.body.retryAfter;
        addLog({ role: 'system', tone: 'warn', text: `Rate limit reached: ${RATE_LIMIT} voice commands per minute per table. Try again in ${secs}s.` });
        toast(`Too many requests. Please wait ${secs} seconds.`, 'warn');
        startCooldown(secs);
      } else {
        addLog({ role: 'system', tone: 'warn', text: "I couldn't reach the restaurant just now. Please try again, or tap Call Server." });
        setState('idle');
      }
    }
  }

  function beginTurn() {
    clearTimers(); stopRec(); stopSpeech();
    turnRef.current++;
    interimRef.current = ''; setInterim('');
    setState('listening'); bump();
    const start = Date.now();
    const turn = turnRef.current;
    const limit = ctx.current.turnMs;
    setTurnLeft(limit);
    const iv = setInterval(() => {
      if (turnRef.current !== turn || stRef.current !== 'listening') { clearInterval(iv); return; }
      const left = limit - (Date.now() - start);
      setTurnLeft(Math.max(0, left));
      if (left <= 0) {
        clearInterval(iv);
        if (recRef.current && recRef.current.finish) recRef.current.finish();
        else if (interimRef.current.trim()) { addLog({ role: 'system', text: 'Turn time limit reached. Processing what was heard.' }); submit(interimRef.current, 'voice'); }
        else heardNothing();
      }
    }, 100);
    timersRef.current.push(iv);
    return turn;
  }

  function micUnavailable(reason) {
    setMicNote(reason);
    toast(reason, 'warn');
    clearTimers(); stopRec(); setState('idle');
  }

  // The recognizer heard sound but returned no words, or stopped without hearing anything.
  function heardNothing() {
    clearTimers(); stopRec(); setState('idle');
    emptyRef.current += 1;
    addLog({ role: 'assistant', text: emptyRef.current >= 2
      ? "I still couldn't make that out. Try speaking a little closer to the microphone, or hold the mic button while you speak."
      : "I didn't catch that. Tap the mic and try again, or type below." });
  }

  // Silero VAD (the neural voice-activity detector from Alice's voice pipeline) decides when the guest
  // starts and stops talking. It is loaded on first use and rebuilt only when the room setting or the
  // guest's "take your time" choice changes; if it can't load, listenLoudness() below takes over.
  function loadVad() {
    const { voice: v, prefs: p } = ctx.current;
    const key = `${v.vad}|${p.patient}`;
    if (vadRef.current && vadKey.current !== key) {
      const old = vadRef.current; vadRef.current = null;
      old.then((x) => x && x.destroy());
    }
    if (!vadRef.current) {
      vadKey.current = key;
      const noisy = v.vad === 'noisy';
      vadRef.current = (window.vad ? window.vad.MicVAD.new({
        model: 'v5', baseAssetPath: '/assets/vendor/vad/', onnxWASMBasePath: '/assets/vendor/ort/',
        ortConfig: (ort) => { ort.env.logLevel = 'error'; ort.env.wasm.numThreads = 1; },
        startOnLoad: false, submitUserSpeechOnPause: true,
        // Stricter than the library defaults so restaurant chatter doesn't open a turn; stricter still
        // in a noisy room. A guest who takes their time gets longer pauses before the turn ends.
        positiveSpeechThreshold: noisy ? 0.65 : 0.5, negativeSpeechThreshold: noisy ? 0.5 : 0.35,
        redemptionMs: p.patient ? 1800 : 1000, preSpeechPadMs: 500, minSpeechMs: noisy ? 450 : 300,
        onSpeechStart: () => vadEvents.current.start(),
        onVADMisfire: () => vadEvents.current.misfire(),
        onSpeechEnd: (audio) => vadEvents.current.end(audio),
      }) : Promise.reject(new Error('VAD script not loaded'))).catch((e) => { console.warn('[vad] falling back to loudness detection:', e); return null; });
    }
    return vadRef.current;
  }

  // Whisper path: Silero VAD captures one utterance (16 kHz), which goes to the restaurant's own
  // Whisper service. The turn cap or a second mic tap submits whatever speech was heard so far.
  async function listenWhisper() {
    const mic = await primeMic();
    if (mic !== true) {
      micUnavailable(mic === 'NotFoundError' ? 'No microphone was found on this device.' : 'Microphone access is blocked. Click the lock icon in the address bar, allow the microphone, then tap the mic again.');
      return;
    }
    const vad = await loadVad();
    if (!vad) return listenLoudness();
    const turn = beginTurn();
    let heard = false; let submitted = false;
    vadEvents.current = {
      start: () => { heard = true; interimRef.current = ''; setInterim('…'); },
      misfire: () => { heard = false; setInterim(''); },
      end: (audio) => {
        if (turnRef.current !== turn || submitted) return;
        submitted = true;
        if (recRef.current === handle) recRef.current = null;
        clearTimers(); setInterim(''); vad.pause();
        transcribe(turn, toPcm16([audio], 16000));
      },
    };
    const handle = {
      abort: () => { vadEvents.current = VAD_IDLE; vad.pause(); },
      finish: async () => {
        await vad.pause(); // with submitUserSpeechOnPause, speech in progress arrives via end() above
        if (!submitted && turnRef.current === turn) { vadEvents.current = VAD_IDLE; heardNothing(); }
      },
    };
    recRef.current = handle;
    try { await vad.start(); } catch (e) { recRef.current = null; vadEvents.current = VAD_IDLE; return listenLoudness(); }
    setMicNote('');
  }

  // Records raw audio for Whisper. Used when the VAD can't load (stops after ~1 s of quiet following
  // speech), and for hold-to-talk (records until the button is released).
  async function listenLoudness(hold = false) {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (e) {
      micUnavailable(e.name === 'NotFoundError' ? 'No microphone was found on this device.' : 'Microphone access is blocked. Click the lock icon in the address bar, allow the microphone, then tap the mic again.');
      return;
    }
    micGranted = true;
    const turn = beginTurn();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const parts = []; let heard = false; let quiet = 0; let closed = false;
    const finish = (send) => {
      if (closed) return;
      closed = true;
      proc.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); ac.close();
      if (recRef.current === handle) recRef.current = null;
      if (!send || turnRef.current !== turn) return;
      clearTimers();
      if (heard) transcribe(turn, toPcm16(parts, ac.sampleRate)); else heardNothing();
    };
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      parts.push(new Float32Array(d));
      let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      if (Math.sqrt(sum / d.length) > 0.015) { heard = true; quiet = 0; if (hold) setInterim('…'); }
      else if (!hold && heard && (quiet += d.length / ac.sampleRate) > (ctx.current.prefs.patient ? 1.8 : 1.1)) finish(true);
    };
    src.connect(proc); proc.connect(ac.destination);
    const handle = { abort: () => finish(false), finish: () => finish(true) };
    recRef.current = handle;
    setMicNote('');
    if (hold && !holdRef.current) finish(true); // released while the microphone was starting
  }

  async function transcribe(turn, pcm) {
    setState('thinking'); setPhase('Transcribing with Whisper');
    try {
      const res = await fetch(`/api/tables/${table}/transcribe?lang=${ctx.current.prefs.lang}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm });
      const data = await res.json().catch(() => ({}));
      if (turnRef.current !== turn) return;
      setPhase('');
      if (res.status === 403 && data.error === 'service_suspended') { setState('idle'); serviceChanged(); return; }
      if (res.status === 409 && data.error === 'language_unavailable') { micUnavailable(ctx.current.t.languageNeedsWhisper); return; }
      if (res.status === 429 && data.error === 'voice_busy') { voiceBusy(data.retryAfter); return; }
      if (res.status === 429) {
        addLog({ role: 'system', tone: 'warn', text: `Voice limit reached for this table. Try again in ${data.retryAfter}s, or type below.` });
        startCooldown(data.retryAfter);
        return;
      }
      if (!res.ok) throw new Error(data.error);
      if (data.text && data.text.trim()) { emptyRef.current = 0; submit(data.text, 'voice'); } else heardNothing();
    } catch (e) {
      if (turnRef.current !== turn) return;
      setPhase(''); setState('idle');
      engineRef.current = 'browser'; setEngine('browser');
      addLog({ role: 'system', tone: 'warn', text: "Whisper isn't responding, so I've switched to the browser's speech recognition. Tap the mic and say that again." });
    }
  }

  // Which way this tablet can listen right now, or why it can't.
  function micBlocker() {
    const { prefs: p, voice: v, t: tt } = ctx.current;
    const whisper = engineRef.current === 'whisper' && navigator.mediaDevices && window.AudioContext;
    if (p.lang !== 'en' && !(whisper && (v.languages || []).includes(p.lang))) return tt.languageNeedsWhisper;
    if (!whisper && v.offlineOnly) return tt.offlineNoMic; // the browser recognizer sends audio to Google
    return '';
  }

  async function listen() {
    if (stRef.current === 'cooldown') return;
    if (stRef.current === 'listening') {
      if (recRef.current && recRef.current.finish) { clearTimers(); recRef.current.finish(); return; }
      interimRef.current.trim() ? submit(interimRef.current, 'voice') : (clearTimers(), stopRec(), setState('idle'));
      return;
    }
    const blocked = micBlocker();
    if (blocked) { micUnavailable(blocked); return; }
    if (engineRef.current === 'whisper' && navigator.mediaDevices && window.AudioContext) return listenWhisper();
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { micUnavailable('Voice input is not supported in this browser. Try Chrome or Edge, or type / tap a phrase instead.'); return; }
    const mic = await primeMic();
    if (mic !== true) {
      micUnavailable(mic === 'NotFoundError' ? 'No microphone was found on this device.' : 'Microphone access is blocked. Click the lock icon in the address bar, allow the microphone, then tap the mic again.');
      return;
    }
    const turn = beginTurn();
    try {
      const rec = new SR();
      rec.lang = /^en\b/i.test(navigator.language) ? navigator.language : 'en-US';
      rec.interimResults = true; rec.continuous = holdRef.current;
      rec.onresult = (e) => {
        if (turnRef.current !== turn) return;
        let s = ''; let final = false;
        for (let i = 0; i < e.results.length; i++) { s += e.results[i][0].transcript; if (e.results[i].isFinal) final = true; }
        interimRef.current = s; setInterim(s);
        if (!final || holdRef.current) return;
        if (s.trim()) { emptyRef.current = 0; submit(s, 'voice'); } else heardNothing();
      };
      rec.onerror = (e) => {
        if (turnRef.current !== turn) return;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { micGranted = false; micUnavailable('Microphone access is blocked. Click the lock icon in the address bar, allow the microphone, then tap the mic again.'); }
        else if (e.error === 'audio-capture') micUnavailable('No microphone was found on this device.');
        else if (e.error === 'network') micUnavailable('The browser’s speech service could not be reached. Check your internet connection and try again.');
        else if (e.error === 'no-speech') heardNothing();
        else if (e.error !== 'aborted') { clearTimers(); stopRec(); setState('idle'); }
      };
      // The browser can stop listening on its own (silence, end of a phrase); never leave the UI stuck on "listening".
      rec.onend = () => {
        if (turnRef.current !== turn || stRef.current !== 'listening') return;
        if (interimRef.current.trim()) submit(interimRef.current, 'voice'); else heardNothing();
      };
      recRef.current = rec; rec.start();
      setMicNote('');
    } catch (e) { micUnavailable('Could not start the microphone. Please type instead.'); }
  }

  // Hold-to-talk for a loud room: record while the button is held, send on release.
  function holdStart() {
    holdRef.current = true;
    if (stRef.current === 'listening') { clearTimers(); stopRec(); setState('idle'); }
    const blocked = micBlocker();
    if (blocked) { micUnavailable(blocked); return; }
    if (engineRef.current === 'whisper' && navigator.mediaDevices && window.AudioContext) return listenLoudness(true);
    return listen(); // the browser recognizer runs continuously while held; release stops it
  }
  function holdEnd() {
    holdRef.current = false;
    const rec = recRef.current;
    if (!rec || stRef.current !== 'listening') return;
    if (rec.finish) { clearTimers(); rec.finish(); } else { try { rec.stop(); } catch (e) {} }
  }
  const onMicDown = (e) => {
    if (e.button > 0) return;
    pressRef.current = { held: false, timer: setTimeout(() => { if (pressRef.current) { pressRef.current.held = true; holdStart(); } }, 350) };
  };
  const onMicUp = () => {
    const p = pressRef.current; pressRef.current = null;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.held) holdEnd(); else listen();
  };
  const onMicCancel = () => {
    const p = pressRef.current; pressRef.current = null;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.held) holdEnd();
  };

  // Simulated speech: "transcribes" a phrase character by character inside the turn window.
  function simulate(phrase) {
    if (stRef.current === 'cooldown') { toast('Voice is cooling down. Please wait a moment.', 'warn'); return; }
    stopRec();
    const turn = beginTurn();
    let i = 0;
    const step = () => {
      if (turnRef.current !== turn || stRef.current !== 'listening') return;
      i += 1 + Math.floor(Math.random() * 2);
      interimRef.current = phrase.slice(0, i); setInterim(interimRef.current);
      if (i < phrase.length) later(step, 38);
      else later(() => turnRef.current === turn && submit(phrase, 'voice'), 450);
    };
    later(step, 350);
  }

  React.useImperativeHandle(ref, () => ({
    listen, simulate, say: (text, force) => say(text, force), state: () => stRef.current,
    reset: () => { clearTimers(); stopRec(); stopSpeech(); turnRef.current++; setInterim(''); setState('idle'); clearTimeout(captionTimer.current); ctx.current.onCaption(null); },
  }));

  const cooling = vstate === 'cooldown' && cooldownUntil;
  const coolSecs = cooling ? Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)) : 0;
  const used = usage && usage.resetsAt && usage.resetsAt > Date.now() ? usage.used : 0;
  const busy = vstate === 'thinking' || vstate === 'speaking';
  const noisy = voice.vad === 'noisy';
  // What the guest is told about where their voice goes.
  const heardBy = engine === 'whisper' ? t.privacyLocal : voice.offlineOnly ? t.offlineNoMic : t.privacyBrowser;
  const ttsVoice = preferredVoice(prefs.lang, voice.offlineOnly);
  const spokenBy = ttsVoice && !ttsVoice.localService ? t.voiceGoogle : t.voiceLocal;

  return (
    <div className="glass rounded-3xl shadow-[0_18px_50px_-30px_rgba(60,40,10,0.45)] overflow-hidden">
      <div className="px-5 pt-5 pb-4 glass-dark text-cream relative">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10.5px] tracking-[0.3em] uppercase text-gold">{restaurant} · {t.assistant}</p>
            <p className="font-serif text-xl mt-0.5">{{ idle: t.howHelp, listening: t.listening, thinking: t.oneMoment, speaking: t.hereIs, cooldown: t.pause }[vstate]}</p>
          </div>
          <button onClick={() => { setSound((s) => !s); stopSpeech(); }} className="w-9 h-9 rounded-full border border-white/20 flex items-center justify-center text-cream/80 hover:text-cream" aria-label={sound ? 'Mute assistant voice' : 'Unmute assistant voice'} title={sound ? 'Voice replies on' : 'Voice replies off'}>
            <Icon name={sound ? 'volume' : 'mute'} className="w-4 h-4" />
          </button>
        </div>
        <div className="mt-4 flex items-center gap-4">
          <button onPointerDown={onMicDown} onPointerUp={onMicUp} onPointerLeave={onMicCancel} onPointerCancel={onMicCancel}
            onClick={(e) => { if (e.detail === 0) listen(); }} onContextMenu={(e) => e.preventDefault()}
            disabled={cooling || busy} aria-label={vstate === 'listening' ? 'Stop listening' : 'Start speaking. Hold while you speak in a noisy room.'}
            className={'mic-btn relative shrink-0 w-16 h-16 rounded-full flex items-center justify-center transition touch-none select-none disabled:opacity-50 ' + (vstate === 'listening' ? 'bg-[#B5462E] mic-live' : 'bg-gold hover:bg-gold-dark')}>
            <Icon name={vstate === 'listening' && !holdRef.current ? 'pause' : 'mic'} className="w-7 h-7 text-white" />
          </button>
          <div className="flex-1 min-w-0">
            <Waveform state={vstate} />
            <div className="mt-1.5 text-xs text-cream/70 flex items-center gap-2 tabular-nums">
              {vstate === 'listening' ? (
                <>
                  <span className="flex-1 h-1 rounded-full bg-white/15 overflow-hidden"><span className="block h-full bg-gold" style={{ width: `${(turnLeft / turnMs) * 100}%` }} /></span>
                  <span>{(turnLeft / 1000).toFixed(1)}s</span>
                </>
              ) : cooling ? <span className="text-[#F3C27A]">Cooldown {coolSecs}s · limit {RATE_LIMIT}/min</span>
                : <span>{VOICE_LABEL[vstate]} · {used}/{RATE_LIMIT} commands this minute · {turnMs / 1000}s turns{engine === 'whisper' ? ' · Whisper' : ''}</span>}
            </div>
          </div>
        </div>
        <p className={'mt-3 text-[12px] ' + (noisy ? 'text-[#F3D9A8] font-medium' : 'text-cream/60')}>{noisy ? t.noisyHint : t.holdToTalk}</p>
        {micNote && <p className="mt-2 text-[12px] text-[#F3D9A8]">{micNote}</p>}
      </div>

      <div className="max-h-[300px] lg:max-h-[min(34vh,320px)] overflow-y-auto px-4 py-3 flex flex-col gap-2.5 bg-white/25" aria-live="polite">
        {log.map((m) => <LogItem key={m.id} m={m} />)}
        {interim && <div className="self-end max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm bg-gold-wash text-ink/70 italic border border-dashed border-gold/50">{interim}…</div>}
        {vstate === 'thinking' && <div className="self-start text-xs text-muted flex items-center gap-2"><Waveform state="thinking" size="sm" /> {phase || 'Parsing request and validating tool calls'}</div>}
        <div ref={logEnd} />
      </div>

      <form className="flex items-center gap-2 px-3 py-3 border-t border-line" onSubmit={(e) => { e.preventDefault(); if (typed.trim() && !cooling && !busy) { submit(typed, 'typed'); setTyped(''); } }}>
        <label htmlFor={`assistant-input-${table}`} className="sr-only">Type a request</label>
        <input id={`assistant-input-${table}`} value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={240} disabled={cooling}
          placeholder={cooling ? `Please wait ${coolSecs}s…` : t.typeHere} className="flex-1 min-w-0 bg-white/70 rounded-full px-4 py-2.5 text-sm placeholder:text-muted/80 focus:outline-none focus:ring-2 focus:ring-gold/50" />
        <button type="submit" disabled={!typed.trim() || cooling || busy} className="w-10 h-10 rounded-full bg-ink text-cream flex items-center justify-center disabled:opacity-40" aria-label="Send"><Icon name="send" className="w-4 h-4" /></button>
      </form>

      <div className="px-4 pb-3">
        <p className="label mb-2">{t.trySaying}</p>
        <div className="flex flex-wrap gap-1.5">
          {prefs.lang === 'en'
            ? SAMPLE_PHRASES.map((p) => <button key={p} onClick={() => simulate(p)} disabled={cooling || busy} className="phrase">{p}</button>)
            : (EXAMPLES[prefs.lang] || []).map((p) => <span key={p} className="phrase cursor-default">{p}</span>)}
        </div>
      </div>
      <p className="px-4 pb-4 text-[11.5px] text-muted flex gap-1.5"><Icon name="info" className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{heardBy} {spokenBy}</span></p>
    </div>
  );
});

function LogItem({ m }) {
  if (m.role === 'system') return <div className={'text-[12px] px-3 py-2 rounded-xl border ' + (m.tone === 'warn' ? 'bg-[#FFF4E5] border-[#EBC88F] text-[#7A4B06]' : 'bg-white border-line text-muted')}>{m.text}</div>;
  if (m.role === 'user') return (
    <div className="self-end max-w-[85%] flex flex-col items-end">
      <div className="rounded-2xl rounded-br-md px-3.5 py-2 text-sm bg-ink text-cream">{m.text}</div>
      <span className="text-[10.5px] text-muted mt-0.5">{m.source === 'voice' ? 'Heard' : 'Typed'}{m.truncated ? ' · trimmed to the turn limit' : ''}</span>
    </div>
  );
  return (
    <div className="self-start max-w-[92%]">
      <div className={'rounded-2xl rounded-bl-md px-3.5 py-2 text-sm border ' + (m.tone === 'guard' ? 'bg-[#FBEAE6] border-[#E6B4A8] text-[#5E2014]' : 'bg-white border-line text-ink')}>
        {m.tone === 'guard' && <span className="flex items-center gap-1 text-[10.5px] uppercase tracking-wider text-[#8A2E1C] mb-1"><Icon name="shield" className="w-3.5 h-3.5" /> Guardrail · {m.guard}</span>}
        {m.text}
      </div>
      {m.inspected && m.inspected.length > 0 && (
        <details className="mt-1 text-[11px] text-muted">
          <summary className="cursor-pointer select-none hover:text-ink">Tool calls ({m.inspected.length}) · {m.inspected.every((x) => x.ok && !x.stripped.length) ? 'schema valid' : 'sanitized by schema'}</summary>
          <div className="mt-1 overflow-x-auto">
            {m.inspected.map((x, i) => (
              <pre key={i} className="font-mono text-[10.5px] bg-ink text-cream/90 rounded-lg p-2.5 mb-1 whitespace-pre">
                {JSON.stringify({ tool: x.tool, args: x.args }, null, 1)}
                {x.stripped.map((s) => `\n✖ stripped ${s.key}${s.money ? ' (price fields are computed server-side)' : ' (not allowed for this item)'}`).join('')}
                {x.errors.map((e) => `\n✖ ${e}`).join('')}
                {x.ok && !x.stripped.length ? '\n✔ passed schema validation' : ''}
              </pre>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ---------------- Cart drawer ----------------
function CartDrawer({ open, onClose, table, menu, cart, note, saveNote, call, now, liveFeed, orders, onSend, requestBill, requests, undoOrder, callServer }) {
  const { prefs } = usePrefs();
  const t = ui(prefs.lang);
  const [split, setSplit] = useState(1);
  // The note is edited locally and saved after a pause, so live updates never fight the typing.
  const [draft, setDraft] = useState(note);
  const editing = useRef(false);
  const saveTimer = useRef(null);
  useEffect(() => { if (!editing.current) setDraft(note); }, [note]);
  const onNote = (v) => { setDraft(v); clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => saveNote(v), 500); };
  const tot = totals(menu, cart);
  const billTotal = orders.reduce((s, o) => s + o.total, 0);
  const billReq = requests.find((r) => r.type === 'bill');
  return (
    <>
      <div className={'fixed inset-0 z-[52] bg-ink/30 transition-opacity ' + (open ? 'opacity-100' : 'opacity-0 pointer-events-none')} onClick={onClose} />
      <aside className={'drawer fixed z-[53] top-0 right-0 h-full w-full sm:w-[420px] glass-strong shadow-2xl flex flex-col ' + (open ? 'drawer-open' : '')}
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)' }} aria-hidden={!open} aria-label={t.yourOrder}>
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-b border-line bg-white/50">
          <div>
            <p className="label">{tableName(table)}</p>
            <h2 className="font-serif text-2xl">{t.yourOrder}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={callServer} className="flex items-center gap-1.5 rounded-full border border-gold px-3 py-2 text-[13px] font-medium hover:bg-gold-wash"><Icon name="bell" className="w-4 h-4 text-gold-dark" />{t.callServer}</button>
            <button onClick={onClose} className="w-10 h-10 rounded-full border border-line flex items-center justify-center" aria-label="Close order"><Icon name="x" className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {liveFeed.length > 0 && (
            <section>
              <p className="label mb-2 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-[#B5462E] animate-pulse" /> Live updates</p>
              <ul className="flex flex-col gap-1">
                {liveFeed.slice(0, 4).map((f, i) => <li key={f.id} className={'text-[12.5px] ' + (i === 0 ? 'text-ink feed-in' : 'text-muted')}>{f.text}</li>)}
              </ul>
            </section>
          )}
          <section>
            {cart.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">{t.nothingYet}</div>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {cart.map((l) => {
                  const item = menu.find((m) => m.id === l.itemId);
                  const p = priceLine(menu, l);
                  return (
                    <li key={l.id} className={'py-3 flex gap-3 ' + (item.available ? '' : 'opacity-60')}>
                      <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0 bg-sand"><DishImage item={item} /></div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between gap-2">
                          <p className="font-medium text-[14px] leading-snug">{dishName(item, prefs.lang)}</p>
                          <p className="tabular-nums text-[14px]">{item.available ? fmt(p.total) : '—'}</p>
                        </div>
                        {l.mods.length > 0 && <p className="text-[12px] text-muted mt-0.5">{l.mods.map((k) => MODIFIERS[k].label + (MODIFIERS[k].price ? ` +${fmt(MODIFIERS[k].price)}` : '')).join(' · ')}</p>}
                        {!item.available && <p className="text-[12px] text-[#B5462E] mt-0.5">Unavailable tonight. It won't be sent to the kitchen.</p>}
                        <div className="flex items-center gap-2 mt-2">
                          <div className="flex items-center border border-line rounded-full bg-white">
                            <button className="w-8 h-8" onClick={() => call(`/cart/${l.id}`, 'PATCH', { delta: -1 })} aria-label="Decrease">{'−'}</button>
                            <span className="w-5 text-center text-sm tabular-nums">{l.qty}</span>
                            <button className="w-8 h-8" onClick={() => call(`/cart/${l.id}`, 'PATCH', { delta: 1 })} aria-label="Increase">+</button>
                          </div>
                          <span className="text-[11.5px] text-muted tabular-nums">{fmt(p.unit)} each</span>
                          <button className="ml-auto text-[12px] text-muted hover:text-[#B5462E]" onClick={() => call(`/cart/${l.id}`, 'DELETE')}>Remove</button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section>
            <label htmlFor={`note-${table}`} className="label mb-1.5 block">{t.specialInstructions}</label>
            <textarea id={`note-${table}`} value={draft} onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; }} onChange={(e) => onNote(e.target.value.slice(0, 200))} rows={2} placeholder={t.notePlaceholder}
              className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold/50 resize-none" />
          </section>
          <section className="rounded-2xl bg-white/70 border border-white/80 p-4 text-sm tabular-nums">
            <div className="flex justify-between text-muted"><span>{t.subtotal}</span><span>{fmt(tot.subtotal)}</span></div>
            <div className="flex justify-between text-muted mt-1"><span>{t.tax} ({(TAX_RATE * 100).toFixed(3)}%)</span><span>{fmt(tot.tax)}</span></div>
            <div className="flex justify-between font-serif text-xl mt-2 pt-2 border-t border-line"><span>{t.total}</span><span>{fmt(tot.total)}</span></div>
            <p className="text-[11px] text-muted mt-2">Prices are calculated by the restaurant's pricing engine.</p>
            <button onClick={onSend} disabled={!cart.length} className="btn-gold w-full justify-center mt-3 disabled:bg-[#CFC6B8] disabled:cursor-not-allowed">{t.sendToKitchen}</button>
          </section>
          {orders.length > 0 && (
            <section>
              <p className="label mb-2">{t.sentToKitchen}</p>
              <ul className="flex flex-col gap-2">
                {orders.map((o) => {
                  const left = o.status === 'received' ? o.createdAt + UNDO_MS - now : 0;
                  return (
                    <li key={o.id} className="rounded-xl bg-white/70 border border-white/80 px-3 py-2.5 text-sm flex items-center justify-between gap-2">
                      <div className="min-w-0"><span className="font-medium">{o.id}</span><span className="text-muted"> · {o.lines.reduce((s, l) => s + l.qty, 0)} items · {fmt(o.total)}</span></div>
                      {left > 0
                        ? <button onClick={() => undoOrder(o.id)} className="shrink-0 flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[12px] font-medium hover:border-[#B5462E] hover:text-[#B5462E]"><Icon name="undo" className="w-3.5 h-3.5" />{t.undoFor(mmss(left))}</button>
                        : <StatusPill status={o.status} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <section className="rounded-2xl bg-white/70 border border-white/80 p-4">
            <p className="font-serif text-lg flex items-center gap-2"><Icon name="split" className="w-4 h-4 text-gold-dark" /> {t.billSplit}</p>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="text-muted">{t.splitBetween}</span>
              <div className="flex items-center border border-line rounded-full">
                <button className="w-8 h-8" onClick={() => setSplit((s) => Math.max(1, s - 1))} aria-label="Fewer guests">{'−'}</button>
                <span className="w-16 text-center tabular-nums">{t.guests(split)}</span>
                <button className="w-8 h-8" onClick={() => setSplit((s) => Math.min(12, s + 1))} aria-label="More guests">+</button>
              </div>
            </div>
            <div className="mt-3 text-sm tabular-nums flex justify-between"><span className="text-muted">{t.billTotal}</span><span>{fmt(billTotal)}</span></div>
            {split > 1 && <div className="text-sm tabular-nums flex justify-between mt-1"><span className="text-muted">{t.eachPays}</span><span className="font-semibold">{fmt(billTotal / split)}</span></div>}
            <button onClick={() => requestBill(split)} disabled={!billTotal} className="btn-outline w-full justify-center mt-3 disabled:opacity-40 disabled:cursor-not-allowed">
              {billReq ? (billReq.status === 'open' ? t.billRequested : t.billOnWay) : t.requestBill}
            </button>
            {!billTotal && <p className="text-[11.5px] text-muted mt-2">{t.billAvailable}</p>}
          </section>
        </div>
      </aside>
    </>
  );
}


ReactDOM.createRoot(document.getElementById('root')).render(<TableApp />);
