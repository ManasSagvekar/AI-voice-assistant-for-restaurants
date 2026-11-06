import { fmt, CATEGORIES, CURRENCIES, currency, hasSizes, menuCategories, catLabel, RATE_LIMIT, MAX_TURN_MS, ALLERGENS, ALLERGEN_KEYS, SAMPLE_EXTRACTION } from '../../shared/engine.js';
import { parseMenu, parseMenuText, linesFromPdf, pageFromOcr } from '../../shared/menuparse.js';
import {
  useState, useEffect, useRef, useCallback, tableName, mmss, ago, modsText, Icon, DietMark, DishImage, Switch, chime,
  Toasts, api, useLive, useToasts, Brand, LiveBadge, Loading, useContext, RestaurantContext, useRestaurant, ServicePaused, serviceChanged,
} from '../../client/ui.jsx';

// The same staff app serves three views: /restaurant (dashboard), /kitchen and /floor.
const VIEW = /^\/kitchen/.test(location.pathname) ? 'kitchen' : /^\/floor/.test(location.pathname) ? 'floor' : 'dashboard';
const readPref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const savePref = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } };

function AdminApp() {
  const cfg = useRestaurant();
  const [auth, setAuth] = useState('checking'); // checking | out | in
  const [toasts, toast] = useToasts();
  useEffect(() => { api('/api/admin/me').then(() => setAuth('in'), () => setAuth('out')); }, []);
  // A suspension closes every staff session on the server, so sign in again once service resumes.
  const active = cfg ? cfg.service.active : true;
  useEffect(() => { if (!active) setAuth('out'); }, [active]);
  const logout = async () => { try { await api('/api/admin/logout', 'POST', {}); } catch (e) {} setAuth('out'); };
  return (
    <RestaurantContext.Provider value={cfg || { restaurant: '', service: { state: 'active', active: true, linked: true } }}>
      <div className="min-h-full glass-bg">
        {!cfg ? <Loading label="Checking your staff session…" />
          : cfg.service.state === 'unlinked' ? <Connect />
          : !cfg.service.active ? <ServicePaused state={cfg.service.state} staff><LeaveRestaurant restaurant={cfg.restaurant} /></ServicePaused>
          : auth === 'in' ? <Dashboard toast={toast} onLogout={logout} onExpired={() => setAuth('out')} service={cfg.service} />
          : auth === 'out' ? <Login onIn={() => setAuth('in')} licensed={cfg.service.state !== 'standalone'} /> : <Loading label="Checking your staff session…" />}
        <Toasts toasts={toasts} />
      </div>
    </RestaurantContext.Provider>
  );
}

// First run: link this system to its restaurant account with the details from the welcome email.
function Connect() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await api('/api/admin/connect', 'POST', { username: username.trim(), password }); serviceChanged(); } catch (x) { setErr(x.message); setPassword(''); }
    setBusy(false);
  };
  const field = 'w-full bg-sand rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gold/50';
  return (
    <main className="gutter min-h-[100vh] flex items-center justify-center">
      <form onSubmit={submit} className="w-full max-w-sm glass rounded-3xl p-8">
        <h1 className="font-serif text-3xl">Connect your restaurant</h1>
        <p className="text-sm text-muted mt-1">Enter the restaurant username and password from your welcome email. You only need to do this once on this computer.</p>
        <label htmlFor="connect-user" className="label block mt-6 mb-2">Restaurant username</label>
        <input id="connect-user" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value.slice(0, 64))} className={field} />
        <label htmlFor="connect-pass" className="label block mt-4 mb-2">Password</label>
        <input id="connect-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value.slice(0, 200))} className={field} />
        {err && <p className="text-sm text-[#B5462E] mt-2" role="alert">{err}</p>}
        <button disabled={!username.trim() || !password || busy} className="btn-gold w-full justify-center mt-5 disabled:bg-[#CFC6B8]">{busy ? 'Connecting…' : 'Connect'}</button>
      </form>
    </main>
  );
}

function Login({ onIn, licensed }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await api('/api/admin/login', 'POST', { pin }); onIn(); } catch (x) { setErr(x.message); setPin(''); }
    setBusy(false);
  };
  const { restaurant } = useContext(RestaurantContext);
  return (
    <main className="gutter min-h-[100vh] flex flex-col items-center justify-center">
      <form onSubmit={submit} className="w-full max-w-sm glass rounded-3xl p-8">
        <Brand sub="RESTAURANT STAFF" />
        <h1 className="font-serif text-3xl mt-8">Staff sign in</h1>
        <p className="text-sm text-muted mt-1">Enter the {licensed ? '6-digit ' : ''}staff PIN to open the operations dashboard.</p>
        <label htmlFor="staff-pin" className="label block mt-6 mb-2">Staff PIN</label>
        <input id="staff-pin" type="password" inputMode="numeric" autoComplete="current-password" autoFocus value={pin} onChange={(e) => setPin(licensed ? e.target.value.replace(/\D/g, '').slice(0, 6) : e.target.value.slice(0, 32))}
          className="w-full bg-sand rounded-xl px-4 py-3 text-lg tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-gold/50" />
        {err && <p className="text-sm text-[#B5462E] mt-2" role="alert">{err}</p>}
        <button disabled={!pin || (licensed && pin.length !== 6) || busy} className="btn-gold w-full justify-center mt-5 disabled:bg-[#CFC6B8]">{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-[12px] text-muted mt-5">Guests use the table tablets at /table/1, /table/2 and so on. They can't open this page.</p>
      </form>
      {licensed && <div className="w-full max-w-sm text-center"><LeaveRestaurant restaurant={restaurant} /></div>}
    </main>
  );
}

// Signs this computer out of its restaurant so another restaurant can connect. Without a staff session
// it asks for the restaurant's username and password; its menu and orders stay saved on this computer.
function LeaveRestaurant({ restaurant }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="text-[13px] text-gold-dark hover:underline mt-4">Not {restaurant}? Sign out of this restaurant</button>;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await api('/api/admin/disconnect', 'POST', { username: username.trim(), password }); serviceChanged(); } catch (x) { setErr(x.message); setPassword(''); setBusy(false); }
  };
  const field = 'w-full bg-sand rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-gold/50';
  return (
    <form onSubmit={submit} className="glass rounded-3xl p-6 mt-4 text-left">
      <h2 className="font-serif text-xl">Sign out of {restaurant}</h2>
      <p className="text-[13px] text-muted mt-1">Enter {restaurant}'s username and password. Afterwards you can connect another restaurant; {restaurant}'s menu and orders stay saved on this computer.</p>
      <label htmlFor="leave-user" className="label block mt-4 mb-1.5">Restaurant username</label>
      <input id="leave-user" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value.slice(0, 64))} className={field} />
      <label htmlFor="leave-pass" className="label block mt-3 mb-1.5">Password</label>
      <input id="leave-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value.slice(0, 200))} className={field} />
      {err && <p className="text-sm text-[#B5462E] mt-2" role="alert">{err}</p>}
      <div className="flex gap-2 mt-4">
        <button type="button" onClick={() => { setOpen(false); setErr(''); }} className="flex-1 rounded-full px-4 py-2.5 text-sm bg-sand">Cancel</button>
        <button disabled={!username.trim() || !password || busy} className="btn-gold flex-1 justify-center disabled:bg-[#CFC6B8]">{busy ? 'Signing out…' : 'Sign out'}</button>
      </div>
    </form>
  );
}

// Plays a tone (and buzzes a phone) when a new table request, or on the kitchen screen a new order, arrives.
function useAlerts(snap, { requests = true, orders = false } = {}) {
  const [sound, setSound] = useState(() => readPref('flv.sound', true));
  const seen = useRef(null);
  useEffect(() => { savePref('flv.sound', sound); }, [sound]);
  useEffect(() => {
    if (!snap) return;
    const ids = new Set([...snap.requests.filter((r) => r.status === 'open').map((r) => r.id), ...snap.orders.map((o) => o.id)]);
    if (seen.current) {
      const newReq = requests && snap.requests.some((r) => r.status === 'open' && !seen.current.has(r.id));
      const newOrder = orders && snap.orders.some((o) => o.status === 'received' && !seen.current.has(o.id));
      if ((newReq || newOrder) && sound) {
        chime(newOrder ? 'order' : 'request');
        try { navigator.vibrate && navigator.vibrate([180, 80, 180]); } catch (e) { /* not a phone */ }
      }
    }
    seen.current = ids;
  }, [snap, sound, requests, orders]);
  return [sound, setSound];
}
const SoundToggle = ({ sound, setSound }) => (
  <button onClick={() => { setSound((s) => !s); if (!sound) chime('request'); }} className="flex items-center gap-1.5 text-sm text-muted hover:text-ink" aria-pressed={sound} title="Alert sounds for new requests">
    <Icon name={sound ? 'volume' : 'mute'} className="w-4 h-4" />{sound ? 'Sound on' : 'Sound off'}
  </button>
);

// Service notices that matter to staff during service: running offline, and voice usage limits.
function ServiceNotice({ service }) {
  if (!service) return null;
  const notes = [];
  if (service.offline) notes.push(['warn', "This computer can't reach the licence server. Service continues as normal until your plan's end date; check the internet connection when you can."]);
  if (service.usage === 'throttled') notes.push(['danger', 'Voice usage has reached your plan limit for now. Voice replies are slowed down until the limit resets; ordering by touch and this dashboard work as normal. Ask your provider about a higher limit.']);
  else if (service.usage === 'warn') notes.push(['warn', "Voice usage is over 80% of your plan's limit for this period."]);
  if (!notes.length) return null;
  return (
    <div className="max-w-[1400px] mx-auto mt-2 flex flex-col gap-2">
      {notes.map(([tone, text]) => <p key={text} role="status" className={'rounded-xl px-4 py-2.5 text-sm border ' + (tone === 'danger' ? 'bg-[#FBEAE6] border-[#E6B4A8] text-[#8A2E1C]' : 'bg-[#FFF4E5] border-[#EBC88F] text-[#7A4B06]')}>{text}</p>)}
    </div>
  );
}

function Dashboard({ toast, onLogout, onExpired, service }) {
  const { snap, online, now } = useLive('/api/admin/events');
  const [sound, setSound] = useAlerts(snap, { requests: VIEW !== 'kitchen', orders: VIEW === 'kitchen' });
  // Same action names as before; each one is now a request to the shared database.
  const dispatch = useCallback(async (a) => {
    try {
      switch (a.type) {
        case 'TOGGLE_86': return await api(`/api/admin/menu/${a.id}`, 'PATCH', { available: !a.available });
        case 'UPDATE_ITEM': return await api(`/api/admin/menu/${a.id}`, 'PATCH', a.patch);
        case 'PUBLISH_ITEMS': return await api('/api/admin/menu', 'POST', a.body);
        case 'DISH_PHOTO': return await api(`/api/admin/menu/${a.id}/photo`, 'POST', { action: a.action });
        case 'ADVANCE_ORDER': return await api(`/api/admin/orders/${a.id}/advance`, 'POST', {});
        case 'REQUEST_STATUS': return await api(`/api/admin/requests/${a.id}`, 'POST', { status: a.status });
        case 'SET_TABLE_OCCUPIED': return await api(`/api/admin/tables/${a.table}/occupancy`, 'PATCH', { occupied: a.occupied });
        case 'SET_TABLE_COUNT': return await api('/api/admin/settings/table-count', 'PATCH', { count: a.count });
        case 'TABLET_SETTINGS': return await api('/api/admin/settings/tablets', 'PATCH', a.patch);
        case 'RELEASE_TABLE': return await api(`/api/admin/tables/${a.table}/release`, 'POST', {});
        case 'CREATE_BILL': return await api(`/api/admin/tables/${a.table}/bill`, 'POST', {});
        case 'SET_BILLING': return await api('/api/admin/settings/billing', 'PATCH', a.body);
        case 'HEALTH': return await api('/api/admin/health');
      }
    } catch (e) {
      if (e.status === 401) { toast('Your staff session ended. Please sign in again.', 'warn'); onExpired(); }
      else toast(e.message, 'danger');
      return null;
    }
  }, [toast, onExpired]);
  const { restaurant } = useContext(RestaurantContext);
  useEffect(() => { document.title = `${restaurant} · ${{ kitchen: 'Kitchen', floor: 'Floor' }[VIEW] || 'Dashboard'}`; }, [restaurant]);
  const openRequests = snap ? snap.requests.filter((r) => r.status === 'open').length : 0;
  const leaveRestaurant = async () => {
    if (!window.confirm(`Sign this computer out of ${restaurant}? Tablets and staff screens stop until a restaurant connects again. ${restaurant}'s menu and orders stay saved here.`)) return;
    try { await api('/api/admin/disconnect', 'POST', {}); serviceChanged(); } catch (x) { toast(x.message, 'warn'); }
  };
  if (VIEW === 'kitchen') return snap ? <KitchenScreen state={snap} dispatch={dispatch} now={now} online={online} sound={sound} setSound={setSound} /> : <Loading label="Loading tonight's tickets…" />;
  if (VIEW === 'floor') return snap ? <FloorView state={snap} dispatch={dispatch} now={now} online={online} sound={sound} setSound={setSound} onLogout={onLogout} service={service} /> : <Loading label="Loading tables…" />;
  return (
    <>
      <header className="sticky z-50 pt-3 pb-2 gutter" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
        <nav className="max-w-[1400px] mx-auto glass-nav rounded-2xl px-3 sm:px-5 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="mr-auto"><Brand sub="RESTAURANT STAFF" /></div>
          {openRequests > 0 && <span className="flex items-center gap-1.5 text-xs font-semibold text-[#8A2E1C] bg-[#FBEAE6] rounded-full px-2.5 py-1.5"><Icon name="bell" className="w-3.5 h-3.5" />{openRequests} waiting</span>}
          <a href="/kitchen" target="_blank" rel="noopener" className="flex items-center gap-1.5 text-sm text-muted hover:text-ink"><Icon name="kitchen" className="w-4 h-4" />Kitchen screen</a>
          <a href="/floor" target="_blank" rel="noopener" className="flex items-center gap-1.5 text-sm text-muted hover:text-ink"><Icon name="phone" className="w-4 h-4" />Floor view</a>
          <SoundToggle sound={sound} setSound={setSound} />
          <LiveBadge online={online} />
          {service.state !== 'standalone' && <button onClick={leaveRestaurant} className="flex items-center gap-1.5 text-sm text-muted hover:text-ink" title={`Sign this computer out of ${restaurant}`}><Icon name="link" className="w-4 h-4" />Switch restaurant</button>}
          <button onClick={onLogout} className="flex items-center gap-1.5 text-sm text-muted hover:text-ink"><Icon name="logout" className="w-4 h-4" />Sign out</button>
        </nav>
        <ServiceNotice service={service} />
      </header>
      {snap ? <Admin state={snap} dispatch={dispatch} now={now} toast={toast} activeOrders={snap.orders.filter((o) => o.status !== 'served').length} openRequests={openRequests} /> : <Loading label="Loading tonight's service…" />}
    </>
  );
}

// How long a table has been seated (since its first unpaid order) and its longest open request.
function tableTimes(state, t, now) {
  const unpaid = state.orders.filter((o) => o.table === t && !o.paid);
  const reqs = state.requests.filter((r) => r.table === t && r.status === 'open');
  return {
    seatedFor: unpaid.length ? now - Math.min(...unpaid.map((o) => o.createdAt)) : null,
    waitingFor: reqs.length ? now - Math.min(...reqs.map((r) => r.at)) : null,
    reqs,
  };
}

function TablesView({ state, now, dispatch, toast, printBill }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <TableCountControl count={state.tables.length} dispatch={dispatch} toast={toast} />
        <TabletSettings settings={state.settings} dispatch={dispatch} toast={toast} />
        <div className="lg:col-span-2"><BillingCard meta={state.meta} dispatch={dispatch} toast={toast} /></div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {state.tables.map((t) => {
        const occupied = state.occupancy?.[t] === true;
        const orders = state.orders.filter((o) => o.table === t && !o.paid && o.status !== 'served');
        const { seatedFor, waitingFor, reqs } = tableTimes(state, t, now);
        const inCart = state.carts[t] || 0;
        return (
          <article key={t} className={'glass rounded-2xl p-4 flex flex-col gap-1.5 ' + (reqs.length ? 'shadow-[0_0_0_3px_rgba(200,149,71,0.35)]' : '')}>
            <div className="flex items-center justify-between">
              <span className="font-serif text-xl">{tableName(t)}</span>
              <span className={'text-xs font-semibold rounded-full px-2.5 py-1 ' + (occupied ? 'bg-[#FBEAE6] text-[#8A2E1C]' : 'bg-[#E8F3EC] text-veg')}>
                {occupied ? 'Occupied' : 'Available'}
              </span>
            </div>
            {seatedFor !== null && <p className="text-[13px] text-ink flex items-center gap-1"><Icon name="clock" className="w-3.5 h-3.5 text-gold-dark" />Seated {Math.floor(seatedFor / 60000)} min</p>}
            <p className="text-[13px] text-muted">{inCart ? `${inCart} item${inCart === 1 ? '' : 's'} being chosen` : 'Nothing in the cart'}</p>
            <p className="text-[13px] text-muted">{orders.length ? `${orders.length} order${orders.length === 1 ? '' : 's'} in progress` : 'No open orders'}</p>
            {reqs.length > 0 && <p className="text-[13px] font-medium text-[#8A2E1C]">{reqs.map((r) => (r.type === 'bill' ? 'Bill requested' : 'Server called')).join(' · ')} · waiting {mmss(waitingFor)}</p>}
            <div className="flex items-center justify-between mt-2">
              <span className="text-[13px] text-muted">Table status</span>
              <Switch id={`occupancy-${t}`} on={occupied} label={`${tableName(t)} occupied`} onChange={async () => {
                const result = await dispatch({ type: 'SET_TABLE_OCCUPIED', table: t, occupied: !occupied });
                if (result) toast(`${tableName(t)} marked ${occupied ? 'available' : 'occupied'}.`);
              }} />
            </div>
            <div className="flex items-center justify-between gap-2 mt-1 text-[13px]">
              {state.claims && state.claims[t]
                ? <span className="text-muted">Tablet seen {ago(now - state.claims[t].lastSeen)}</span>
                : <span className="text-muted">No tablet yet</span>}
              {state.claims && state.claims[t] && (
                <button className="text-muted hover:text-[#B5462E]" onClick={async () => {
                  if (!window.confirm(`Release ${tableName(t)} from its tablet? The next device to open this table takes it over.`)) return;
                  if (await dispatch({ type: 'RELEASE_TABLE', table: t })) toast(`${tableName(t)} released.`);
                }}>Release</button>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 text-[13px]">
              <a href={`/table/${t.slice(1)}`} target="_blank" rel="noopener" className="text-gold-dark hover:underline">Open this table's screen</a>
              <button className="text-gold-dark hover:underline flex items-center gap-1" onClick={() => printBill(t)}><Icon name="printer" className="w-3.5 h-3.5" />Bill</button>
            </div>
          </article>
        );
        })}
      </div>
    </div>
  );
}


// Tax, service charge and what the printed bill says. Each order keeps the rates it was sent with.
function BillingCard({ meta, dispatch, toast }) {
  const saved = meta.billing;
  const [form, setForm] = useState(saved);
  useEffect(() => setForm(saved), [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps
  const up = (patch) => setForm((f) => ({ ...f, ...patch }));
  const field = 'w-full bg-sand rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/50';
  const save = async (e) => {
    e.preventDefault();
    const body = { ...form, taxRate: Number(form.taxRate) || 0, serviceRate: Number(form.serviceRate) || 0 };
    if (await dispatch({ type: 'SET_BILLING', body })) toast('Saved. New orders use these rates; orders already sent keep theirs.');
  };
  return (
    <form onSubmit={save} className="glass rounded-2xl p-4 flex flex-col gap-3">
      <p className="label">Tax and bill</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <label className="block"><span className="text-[12px] text-muted block mb-1">Tax name</span><input value={form.taxLabel} maxLength={16} onChange={(e) => up({ taxLabel: e.target.value })} placeholder="VAT, GST…" className={field} /></label>
        <label className="block"><span className="text-[12px] text-muted block mb-1">Tax rate %</span><input value={form.taxRate} inputMode="decimal" onChange={(e) => up({ taxRate: e.target.value.replace(/[^0-9.]/g, '') })} className={field} /></label>
        <label className="block"><span className="text-[12px] text-muted block mb-1">Service charge %</span><input value={form.serviceRate} inputMode="decimal" onChange={(e) => up({ serviceRate: e.target.value.replace(/[^0-9.]/g, '') })} className={field} /></label>
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" className="w-4 h-4 accent-[#2E7D4F]" checked={form.taxIncluded} onChange={() => up({ taxIncluded: !form.taxIncluded })} />Menu prices already include this tax</label>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block"><span className="text-[12px] text-muted block mb-1">Address on the bill</span><input value={form.address} maxLength={200} onChange={(e) => up({ address: e.target.value })} className={field} /></label>
        <label className="block"><span className="text-[12px] text-muted block mb-1">Tax number (TRN, GSTIN…)</span><input value={form.taxId} maxLength={40} onChange={(e) => up({ taxId: e.target.value })} className={field} /></label>
      </div>
      <label className="block"><span className="text-[12px] text-muted block mb-1">Line at the bottom of the bill</span><input value={form.footer} maxLength={120} onChange={(e) => up({ footer: e.target.value })} placeholder="Thank you for dining with us" className={field} /></label>
      <button className="btn-gold self-start py-2">Save</button>
    </form>
  );
}

// The printable bill, sized like a kitchen ticket for an 80 mm receipt printer.
function BillDialog({ bill, onClose }) {
  const row = (label, value, strong) => <div className={'flex justify-between gap-3 ' + (strong ? 'font-bold text-[16px] border-t border-dashed border-current pt-1.5 mt-1.5' : '')}><span className="min-w-0">{label}</span><span className="tabular-nums shrink-0 whitespace-nowrap">{value}</span></div>;
  const b = bill.billing;
  const rate = (n) => (b ? ` ${n}%` : '');
  const taxLabel = bill.taxLabel || 'Tax';
  return (
    <div className="fixed inset-0 z-[60] bg-ink/40 flex items-center justify-center gutter overflow-y-auto" onClick={onClose}>
      <div className="flex flex-col items-center gap-3 py-6" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Bill ${bill.number}`}>
        <article className="print-ticket bg-white text-[#111] w-[72mm] p-3 text-[13px] leading-snug shadow-2xl">
          <p className="text-center font-bold text-[17px]">{bill.restaurant}</p>
          {bill.address && <p className="text-center text-[12px]">{bill.address}</p>}
          {bill.taxId && <p className="text-center text-[12px]">Tax no. {bill.taxId}</p>}
          <div className="border-t border-dashed border-current mt-2 pt-2 flex justify-between gap-2 text-[12px]">
            <span>Bill {bill.number}{bill.reprint ? ' (copy)' : ''} · {tableName(bill.table)}</span>
            <span className="tabular-nums">{new Date(bill.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
          </div>
          <ul className="border-t border-dashed border-current mt-2 pt-2 flex flex-col gap-1">
            {bill.lines.map((l, i) => (
              <li key={i}>
                <div className="flex justify-between gap-3"><span className="min-w-0">{l.qty} × {l.name}</span><span className="tabular-nums shrink-0 whitespace-nowrap">{fmt(l.total)}</span></div>
                {l.mods.length > 0 && <p className="text-[11px] pl-4">{modsText(l.mods)}</p>}
              </li>
            ))}
          </ul>
          <div className="border-t border-dashed border-current mt-2 pt-2">
            {row('Subtotal', fmt(bill.subtotal))}
            {bill.service > 0 && row(`Service charge${rate(b && b.serviceRate)}`, fmt(bill.service))}
            {bill.tax > 0 && row(b && b.taxIncluded ? `Includes ${taxLabel}${rate(b.taxRate)}` : `${taxLabel}${rate(b && b.taxRate)}`, fmt(bill.tax))}
            {row('Total', fmt(bill.total), true)}
            {bill.split > 1 && row(`Split ${bill.split} ways, each`, fmt(Math.ceil((bill.total / bill.split) * 100) / 100))}
          </div>
          {bill.footer && <p className="text-center text-[12px] mt-3">{bill.footer}</p>}
        </article>
        <div className="flex gap-2 no-print">
          <button className="btn-gold" onClick={() => window.print()}><Icon name="printer" className="w-4 h-4" />Print</button>
          <button className="btn-outline" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function TabletSettings({ settings, dispatch, toast }) {
  const set = async (patch, msg) => { if (await dispatch({ type: 'TABLET_SETTINGS', patch })) toast(msg); };
  const seg = (value, options, onPick) => (
    <div className="inline-flex bg-sand rounded-full p-0.5 text-[13px]">
      {options.map(([v, label]) => <button key={v} onClick={() => v !== value && onPick(v)} aria-pressed={v === value} className={'px-3 py-1 rounded-full ' + (v === value ? 'bg-white shadow text-ink font-semibold' : 'text-muted')}>{label}</button>)}
    </div>
  );
  return (
    <section className="glass rounded-2xl p-4 flex flex-col gap-3">
      <p className="label">Tablet settings</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">Microphone</span>
        {seg(settings.vad, [['normal', 'Normal room'], ['noisy', 'Noisy room']], (v) => set({ vad: v }, v === 'noisy' ? 'Tablets now ignore more background noise and suggest hold-to-talk.' : 'Tablets use normal speech detection.'))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">Voice privacy</span>
        {seg(settings.voicePrivacy, [['standard', 'Standard'], ['offline', 'This computer only']], (v) => set({ voicePrivacy: v }, v === 'offline' ? 'No speech or reply text leaves this computer now.' : 'Tablets may use Google voices again.'))}
      </div>
      <p className="text-[12px] text-muted">"This computer only" turns off Google's online voices and the browser's speech recognition. Tablets then use the voice service on this computer, or touch and typing if it isn't running.</p>
    </section>
  );
}

function TableCountControl({ count, dispatch, toast }) {
  const [value, setValue] = useState(String(count));
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(String(count)), [count]);

  const save = async (e) => {
    e.preventDefault();
    const next = Number(value);
    if (!Number.isInteger(next) || next < 1 || next > 99) {
      toast('Enter a whole number from 1 to 99.', 'danger');
      return;
    }
    if (next === count) return;
    setSaving(true);
    const result = await dispatch({ type: 'SET_TABLE_COUNT', count: next });
    setSaving(false);
    if (result) toast(`Table count updated to ${next}.`);
  };

  return (
    <form onSubmit={save} className="glass rounded-2xl p-4 flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="table-count" className="label block mb-1.5">Number of tables</label>
        <input id="table-count" type="number" min="1" max="99" step="1" value={value}
          onChange={(e) => setValue(e.target.value)} className="w-24 bg-white border border-line rounded-xl px-3 py-2 tabular-nums focus:outline-none focus:ring-2 focus:ring-gold/50" />
      </div>
      <button type="submit" disabled={saving || Number(value) === count} className="btn-gold py-2 disabled:bg-gold">
        {saving ? 'Saving…' : 'Save table count'}
      </button>
      <p className="basis-full text-xs text-muted">Table numbers can range from 1 to 99. Data for removed tables is retained and becomes available again if you increase the count.</p>
    </form>
  );
}

function Admin({ state, dispatch, now, toast, activeOrders, openRequests }) {
  const { restaurant } = useContext(RestaurantContext);
  const [tab, setTab] = useState('orders');
  const [bill, setBill] = useState(null);
  const [health, setHealth] = useState(null);
  const checkHealth = useCallback(async () => { const h = await dispatch({ type: 'HEALTH' }); if (h) setHealth(h); }, [dispatch]);
  useEffect(() => { checkHealth(); const id = setInterval(checkHealth, 30000); return () => clearInterval(id); }, [checkHealth]);
  const problems = health ? health.checks.filter((c) => c.status !== 'ok').length : null;
  const printBill = async (table) => { const b = await dispatch({ type: 'CREATE_BILL', table }); if (b) setBill(b); };
  const offCount = state.menu.filter((m) => !m.available).length;
  const blocks = state.security.length;
  const busyTables = state.tables.filter((t) => state.occupancy?.[t]).length;
  const tabs = [['orders', 'Live Orders', activeOrders], ['tables', 'Tables', null], ['menu', 'Menu Control', null], ['ingest', 'Import Menu', null], ['requests', 'Service Requests', openRequests], ['security', 'Security Log', blocks], ['health', 'Health', problems]];
  const kpis = [
    ['Active orders', activeOrders, `${state.orders.filter((o) => o.status === 'kitchen').length} in the kitchen`],
    ['Open requests', openRequests, 'Server calls and bills'],
    ['Tables in use', `${busyTables} / ${state.tables.length}`, `${state.tables.length - busyTables} free · see the Tables tab`],
    ['86’d items', offCount, `${state.menu.length} dishes on the menu`],
    ['Blocked or throttled', blocks, 'Guardrail, schema, rate limit'],
  ];
  return (
    <main className="gutter pb-16">
      {state.meta && state.meta.billingSet === false && (
        <div className="max-w-[1400px] mx-auto mb-3 rounded-xl bg-[#FFF4E5] border border-[#EBC88F] px-4 py-2.5 text-sm text-[#7A4B06] flex flex-wrap items-center justify-between gap-2">
          <span>Bills show no tax until you set your rate.</span>
          <button className="font-semibold underline" onClick={() => setTab('tables')}>Set it in Tables, Tax and bill</button>
        </div>
      )}
      {bill && <BillDialog bill={bill} onClose={() => setBill(null)} />}
      <div className="max-w-[1400px] mx-auto">
        <section className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] tracking-[0.3em] text-gold-dark uppercase">Operations · Dinner service</p>
            <h1 className="font-serif text-3xl sm:text-[40px] leading-tight mt-1">{restaurant}</h1>
          </div>
        </section>
        <section className="mt-5 grid grid-cols-2 lg:grid-cols-5 gap-3">
          {kpis.map(([l, v, s]) => (
            <div key={l} className="glass rounded-2xl px-4 py-3">
              <p className="label">{l}</p>
              <p className="font-serif text-3xl tabular-nums mt-1">{v}</p>
              <p className="text-[12px] text-muted">{s}</p>
            </div>
          ))}
        </section>
        <div className="mt-6 overflow-x-auto no-scrollbar border-b border-line">
          <div className="flex gap-6 min-w-max" role="tablist">
            {tabs.map(([id, label, n]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={'pb-3 text-sm flex items-center gap-2 border-b-2 -mb-px transition ' + (tab === id ? 'border-gold text-ink font-semibold' : 'border-transparent text-muted hover:text-ink')}>
                {label}{n ? <span className={'text-[11px] px-1.5 rounded-full tabular-nums ' + (tab === id ? 'bg-gold text-white' : 'bg-sand text-muted')}>{n}</span> : null}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-5">
          {tab === 'orders' && <OrderQueue orders={state.orders} dispatch={dispatch} now={now} undoMs={state.undoMs} />}
          {tab === 'tables' && <TablesView state={state} now={now} dispatch={dispatch} toast={toast} printBill={printBill} />}
          {tab === 'menu' && <MenuControl menu={state.menu} photosPending={state.photosPending} dispatch={dispatch} toast={toast} />}
          {tab === 'ingest' && <Ingestor dispatch={dispatch} toast={toast} menu={state.menu} onDone={() => setTab('menu')} />}
          {tab === 'health' && <HealthView health={health} now={now} onCheck={checkHealth} />}
          {tab === 'requests' && <Requests requests={state.requests} allergenLog={state.allergenLog || []} dispatch={dispatch} now={now} printBill={printBill} />}
          {tab === 'security' && <SecurityLog entries={state.security} now={now} />}
        </div>
      </div>
    </main>
  );
}

function OrderQueue({ orders, dispatch, now, undoMs = 60000 }) {
  const cols = [['received', 'Received', 'Send to kitchen'], ['kitchen', 'Kitchen', 'Mark served'], ['served', 'Served', null]];
  return (
    <div className="grid md:grid-cols-3 gap-4 items-start">
      {cols.map(([status, label, action]) => {
        const list = orders.filter((o) => o.status === status);
        return (
          <section key={status} className="glass-soft rounded-2xl p-3 min-w-0">
            <div className="flex items-center justify-between px-1 mb-3">
              <h3 className="font-serif text-lg">{label}</h3>
              <span className="text-xs text-muted tabular-nums">{list.length}</span>
            </div>
            <div className="flex flex-col gap-3">
              {list.length === 0 && <p className="text-sm text-muted px-1 py-6 text-center">No orders</p>}
              {list.map((o) => (
                <article key={o.id} className="glass rounded-xl p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{tableName(o.table)}</span>
                    <span className="text-[11.5px] text-muted">{o.id} · {ago(now - o.createdAt)}</span>
                  </div>
                  <ul className="mt-2 text-[13px] flex flex-col gap-0.5">
                    {o.lines.map((l) => <li key={l.name + l.mods.join()} className="flex justify-between gap-2"><span className="min-w-0">{l.qty} × {l.name}{l.mods.length ? <strong className="text-[#8A2E1C]"> · {modsText(l.mods)}</strong> : null}</span></li>)}
                  </ul>
                  {o.note && <p className="mt-2 text-[12px] font-semibold bg-[#FFF4E5] text-[#7A4B06] rounded-lg px-2 py-1">{o.note}</p>}
                  {status === 'received' && now - o.createdAt < undoMs && <p className="mt-2 text-[11.5px] text-muted">The guest can still take this back for {mmss(undoMs - (now - o.createdAt))}</p>}
                  {status === 'served' && <div className="mt-3 text-[12px] tabular-nums"><span className="text-muted">Served {ago(now - o.servedAt)}</span></div>}
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="font-serif tabular-nums">{fmt(o.total)}</span>
                    {action && <button onClick={() => dispatch({ type: 'ADVANCE_ORDER', id: o.id })} className={status === 'received' ? 'btn-gold py-1.5 px-3 text-[13px]' : 'btn-outline py-1.5 px-3 text-[13px]'}>{action}</button>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function PriceInput({ item, dispatch, toast }) {
  const [v, setV] = useState(item.price.toFixed(2));
  useEffect(() => setV(item.price.toFixed(2)), [item.price]);
  if (hasSizes(item)) return <span className="text-[13px] text-muted whitespace-nowrap" title="Change these in Details">{item.sizes.length} sizes, from {fmt(item.price)}</span>;
  const commit = () => {
    const n = Math.round(parseFloat(v) * 100) / 100;
    if (!isFinite(n) || n < 0.5 || n > 100000) { toast(`Enter a price between ${fmt(0.5)} and ${fmt(100000)}.`, 'danger'); setV(item.price.toFixed(2)); return; }
    if (n !== item.price) dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { price: n } }).then((ok) => ok ? toast(`${item.name} now ${fmt(n)} on all tablets.`) : setV(item.price.toFixed(2)));
  };
  return (
    <div className="flex items-center bg-sand rounded-lg pl-2 w-[92px]">
      <span className="text-muted text-[12px]">{CURRENCIES[currency()].trim()}</span>
      <input id={`price-${item.id}`} aria-label={`Price of ${item.name}`} value={v} onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ''))} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className="w-full bg-transparent px-1 py-1.5 text-sm tabular-nums focus:outline-none" inputMode="decimal" />
    </div>
  );
}

function TagEditor({ item, dispatch }) {
  const set = (patch) => dispatch({ type: 'UPDATE_ITEM', id: item.id, patch });
  const tg = (on, label, fn) => <button onClick={fn} aria-pressed={on} className={'mini-chip ' + (on ? 'mini-chip-on' : '')}>{label}</button>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tg(item.diet === 'veg', 'Veg', () => set({ diet: 'veg' }))}
      {tg(item.diet === 'nonveg', 'Non-Veg', () => set({ diet: 'nonveg', vegan: false }))}
      {tg(item.vegan, 'Vegan', () => set({ vegan: !item.vegan, diet: 'veg' }))}
      {tg(!!item.jain, 'Jain', () => set({ jain: !item.jain }))}
      {tg(!!item.halal, 'Halal', () => set({ halal: !item.halal }))}
      {tg(item.gf, 'GF', () => set({ gf: !item.gf }))}
      {tg(!!item.chefSpecial, 'Chef Special', () => set({ chefSpecial: !item.chefSpecial }))}
      <label className="sr-only" htmlFor={`spice-${item.id}`}>Spice level</label>
      <select id={`spice-${item.id}`} value={item.spicy} onChange={(e) => set({ spicy: +e.target.value })} className="mini-chip pr-1 bg-white">
        {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n ? `Spicy ${n}` : 'Not spicy'}</option>)}
      </select>
    </div>
  );
}

// Allergens (and the kitchen's confirmation), the dish to suggest alongside, and Hindi/Marathi names.
function DishDetails({ item, menu, dispatch, toast }) {
  const set = (patch, msg) => dispatch({ type: 'UPDATE_ITEM', id: item.id, patch }).then((ok) => ok && msg && toast(msg));
  const [names, setNames] = useState({ nameHi: item.nameHi || '', nameMr: item.nameMr || '' });
  useEffect(() => setNames({ nameHi: item.nameHi || '', nameMr: item.nameMr || '' }), [item.nameHi, item.nameMr]);
  const toggle = (a) => set({ allergens: item.allergens.includes(a) ? item.allergens.filter((x) => x !== a) : [...item.allergens, a], allergensChecked: false });
  return (
    <div className="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-5 py-3">
      <div>
        <p className="label mb-2">Allergens in {item.name}</p>
        <div className="flex flex-wrap gap-1.5">
          {ALLERGEN_KEYS.map((a) => <button key={a} onClick={() => toggle(a)} aria-pressed={item.allergens.includes(a)} className={'mini-chip ' + (item.allergens.includes(a) ? 'mini-chip-on' : '')}>{ALLERGENS[a].label}</button>)}
        </div>
        <label className="mt-3 flex items-start gap-2.5 text-sm cursor-pointer">
          <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[#2E7D4F]" checked={!!item.allergensChecked}
            onChange={() => set({ allergensChecked: !item.allergensChecked }, item.allergensChecked ? `${item.name}: allergy questions now go to staff.` : `${item.name}: the assistant can now answer allergy questions from this list.`)} />
          <span><strong>The kitchen has checked this list.</strong> <span className="text-muted">Until it's ticked, the assistant won't answer allergy questions about this dish and calls a server instead. Changing the list clears the tick.</span></span>
        </label>
      </div>
      <div className="flex flex-col gap-3">
        <DishPhoto item={item} dispatch={dispatch} toast={toast} />
        <DishSizes item={item} dispatch={dispatch} toast={toast} />
        <label className="block">
          <span className="label block mb-1">Suggest with this dish</span>
          <select value={item.pairWith || ''} onChange={(e) => set({ pairWith: e.target.value || null }, e.target.value ? 'The assistant will suggest it once per order.' : 'No pairing suggested.')} className="w-full bg-sand rounded-lg px-2 py-1.5 text-sm">
            <option value="">No suggestion</option>
            {menu.filter((m) => m.id !== item.id).map((m) => <option key={m.id} value={m.id}>{m.name} · {fmt(m.price)}</option>)}
          </select>
        </label>
        {[['nameHi', 'Name in Hindi'], ['nameMr', 'Name in Marathi']].map(([k, label]) => (
          <label key={k} className="block">
            <span className="label block mb-1">{label}</span>
            <input value={names[k]} onChange={(e) => setNames((n) => ({ ...n, [k]: e.target.value.slice(0, 80) }))} onBlur={() => names[k] !== (item[k] || '') && set({ [k]: names[k] }, 'Saved.')}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} placeholder={item.name} lang={k === 'nameHi' ? 'hi' : 'mr'} className="w-full bg-sand rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/50" />
          </label>
        ))}
      </div>
    </div>
  );
}

// Rows of size name and price, for the menu editor and the menu import.
function SizeRows({ sizes, onChange }) {
  const sym = CURRENCIES[currency()].trim();
  const set = (i, patch) => onChange(sizes.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="flex flex-col gap-1.5">
      {sizes.map((s, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input aria-label="Size name" value={s.label} maxLength={24} placeholder="Half" onChange={(e) => set(i, { label: e.target.value })} className="cell w-[110px] bg-sand rounded-lg px-2 py-1 text-sm" />
          <span className="text-[12px] text-muted">{sym}</span>
          <input aria-label={`Price of ${s.label || 'this size'}`} value={s.price} inputMode="decimal" onChange={(e) => set(i, { price: e.target.value.replace(/[^0-9.]/g, '') })} className="cell w-[72px] bg-sand rounded-lg px-2 py-1 text-sm tabular-nums" />
          <button type="button" aria-label={`Remove ${s.label || 'this size'}`} onClick={() => onChange(sizes.filter((_, j) => j !== i))} className="text-muted hover:text-[#B5462E]"><Icon name="x" className="w-3.5 h-3.5" /></button>
        </div>
      ))}
      {sizes.length < 6 && <button type="button" onClick={() => onChange([...sizes, { label: '', price: '' }])} className="text-[13px] text-gold-dark hover:underline self-start">Add a size</button>}
    </div>
  );
}
const sizesReady = (sizes) => sizes.length >= 2 && sizes.every((s) => s.label.trim() && Number(s.price) >= 0.5 && Number(s.price) <= 100000)
  && new Set(sizes.map((s) => s.label.trim().toLowerCase())).size === sizes.length;
const cleanSizes = (sizes) => sizes.map((s) => ({ label: s.label.trim(), price: Number(s.price) }));

// Half and Full, Small and Large: a dish with sizes asks the guest which one.
function DishSizes({ item, dispatch, toast }) {
  const saved = item.sizes || [];
  const [sizes, setSizes] = useState(saved);
  useEffect(() => setSizes(item.sizes || []), [JSON.stringify(item.sizes || [])]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(cleanSizes(sizes)) !== JSON.stringify(cleanSizes(saved));
  const save = async () => {
    const body = sizes.length ? cleanSizes(sizes) : null;
    if (await dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { sizes: body } })) toast(body ? `${item.name} now comes in ${body.length} sizes.` : `${item.name} now has one price.`);
  };
  return (
    <div>
      <span className="label block mb-1">Sizes</span>
      {!sizes.length && <p className="text-[12px] text-muted mb-1">One price. Add sizes if this dish comes as Half and Full, Small and Large, and so on.</p>}
      <SizeRows sizes={sizes.length ? sizes : []} onChange={setSizes} />
      {dirty && (
        <div className="flex items-center gap-2 mt-1.5">
          <button type="button" disabled={sizes.length > 0 && !sizesReady(sizes)} onClick={save} className="btn-gold py-1 px-3 text-[13px] disabled:bg-[#CFC6B8]">Save sizes</button>
          {sizes.length > 0 && !sizesReady(sizes) && <span className="text-[12px] text-muted">Needs at least 2, each with its own name and price.</span>}
        </div>
      )}
    </div>
  );
}

// The dish's photo: find one on Wikipedia (or a different one), or remove it.
function DishPhoto({ item, dispatch, toast }) {
  const [busy, setBusy] = useState(false);
  const act = async (action) => {
    setBusy(true);
    const ok = await dispatch({ type: 'DISH_PHOTO', id: item.id, action });
    setBusy(false);
    if (ok) toast(action === 'remove' ? `${item.name} now shows without a photo.` : `New photo for ${item.name}.`);
  };
  return (
    <div>
      <span className="label block mb-1">Photo</span>
      <div className="flex items-center gap-3">
        <div className="w-16 h-12 rounded-lg overflow-hidden shrink-0"><DishImage item={item} /></div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
          <button disabled={busy} onClick={() => act('find')} className="text-gold-dark hover:underline disabled:opacity-50">{busy ? 'Searching…' : item.img ? 'Find another photo' : 'Find a photo'}</button>
          {item.img && <button disabled={busy} onClick={() => act('remove')} className="text-muted hover:text-[#B5462E]">Remove photo</button>}
          {item.imgCredit && <a href={item.imgCredit} target="_blank" rel="noopener noreferrer" className="text-muted hover:underline">Photo credit and licence</a>}
        </div>
      </div>
    </div>
  );
}

function MenuControl({ menu, photosPending, dispatch, toast }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [open, setOpen] = useState(null);
  const list = menu.filter((m) => (cat === 'all' || m.category === cat) && m.name.toLowerCase().includes(q.toLowerCase()));
  const unchecked = menu.filter((m) => !m.allergensChecked).length;
  return (
    <div className="glass rounded-2xl">
      <div className="p-3 sm:p-4 flex flex-wrap gap-2 items-center border-b border-line">
        <input id="menu-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dishes" aria-label="Search dishes" className="bg-sand rounded-full px-4 py-2 text-sm flex-1 min-w-[160px] focus:outline-none focus:ring-2 focus:ring-gold/50" />
        <select id="menu-cat" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category" className="bg-sand rounded-full px-3 py-2 text-sm">
          {menuCategories(menu).filter((c) => c.id !== 'specials').map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        {photosPending > 0 && <p className="text-[12.5px] text-muted flex items-center gap-2"><span className="w-3.5 h-3.5 rounded-full border-2 border-gold border-t-transparent animate-spin" />Finding dish photos: {photosPending} to go</p>}
        {unchecked > 0 && <p className="basis-full text-[12.5px] text-[#7A4B06]">{unchecked} dish{unchecked === 1 ? '' : 'es'} still need the kitchen to confirm allergens. Open <strong>Details</strong> on each one.</p>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[980px]">
          <thead>
            <tr className="text-left text-muted text-[11.5px] uppercase tracking-wider">
              <th className="font-medium px-4 py-2.5">Dish</th><th className="font-medium px-2 py-2.5">Category</th><th className="font-medium px-2 py-2.5">Price</th><th className="font-medium px-2 py-2.5">Tags</th><th className="font-medium px-2 py-2.5">Allergens</th><th className="font-medium px-4 py-2.5 text-right">In stock</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((m) => (
              <React.Fragment key={m.id}>
              <tr className={m.available ? '' : 'bg-sand/60'}>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <div className={'w-11 h-11 rounded-lg overflow-hidden shrink-0 ' + (m.available ? '' : 'grayscale opacity-60')}><DishImage item={m} /></div>
                    <div className="min-w-0"><p className={'font-medium ' + (m.available ? '' : 'text-muted line-through')}>{m.name}</p><p className="text-[12px] text-muted truncate max-w-[260px]">{m.desc}</p></div>
                  </div>
                </td>
                <td className="px-2 py-2.5 text-muted whitespace-nowrap">{catLabel(m.category)}</td>
                <td className="px-2 py-2.5"><PriceInput item={m} dispatch={dispatch} toast={toast} /></td>
                <td className="px-2 py-2.5"><TagEditor item={m} dispatch={dispatch} /></td>
                <td className="px-2 py-2.5">
                  <button onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id} className={'mini-chip whitespace-nowrap ' + (m.allergensChecked ? '' : 'border-[#EBC88F] text-[#7A4B06]')}>
                    {m.allergensChecked ? <Icon name="shield" className="w-3.5 h-3.5 text-veg" /> : '!'} {m.allergensChecked ? 'Checked' : 'Not checked'} · Details
                  </button>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-2">
                    <span className={'text-[12px] ' + (m.available ? 'text-veg' : 'text-[#B5462E] font-semibold')}>{m.available ? 'Available' : '86’d'}</span>
                    <Switch id={`stock-${m.id}`} on={m.available} label={`${m.name} in stock`} onChange={async () => { if (await dispatch({ type: 'TOGGLE_86', id: m.id, available: m.available })) toast(m.available ? `${m.name} 86’d on all tablets.` : `${m.name} is back on the menu.`, m.available ? 'warn' : undefined); }} />
                  </div>
                </td>
              </tr>
              {open === m.id && <tr className="bg-white/50"><td colSpan={6} className="px-4"><DishDetails item={m} menu={menu} dispatch={dispatch} toast={toast} /></td></tr>}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// PDF.js is large, so it loads only when a PDF is dropped; its worker reads the file off the main thread.
let pdfjs = null;
async function readPdf(file, onProgress) {
  if (!pdfjs) {
    const url = '/assets/vendor/pdfjs/pdf.min.mjs';
    pdfjs = await import(url);
    pdfjs.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdfjs/pdf.worker.min.mjs';
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = [];
  const scans = []; // pages with no text layer: scans, which are read like photos
  for (let n = 1; n <= Math.min(doc.numPages, 30); n++) {
    const page = await doc.getPage(n);
    const text = await page.getTextContent();
    const items = text.items.filter((it) => 'str' in it && it.str.trim()).map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], h: it.height || Math.abs(it.transform[3]), w: it.width }));
    if (items.length >= 4) { pages.push({ width: page.getViewport({ scale: 1 }).width, items }); continue; }
    const viewport = page.getViewport({ scale: Math.min(3, MAX_SIDE / Math.max(page.view[2], page.view[3])) });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    scans.push(canvas);
  }
  if (scans.length) pages.push(...await readPictures(scans, onProgress));
  return { pages, fromPicture: scans.length > 0 };
}

// Photos and scans are read on this computer by Tesseract, from files served by this server: nothing
// is uploaded. English only. It loads only when needed, because it is large.
const MAX_SIDE = 3000;
const MIN_SIDE = 1800;
const loadScript = (src) => new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
  document.head.appendChild(s);
});
// A photo as a grey canvas of a size the reader handles well, the right way up (from its EXIF data).
async function photoCanvas(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.max(bitmap.width, bitmap.height);
  const scale = side > MAX_SIDE ? MAX_SIDE / side : side < MIN_SIDE ? MIN_SIDE / side : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.filter = 'grayscale(1)';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}
async function readPictures(canvases, onProgress) {
  if (!window.Tesseract) await loadScript('/assets/vendor/tesseract/tesseract.min.js');
  let current = 0;
  const say = (pct) => onProgress(`Reading ${canvases.length > 1 ? `page ${current + 1} of ${canvases.length}` : 'the picture'}: ${pct}%`);
  say(0);
  const worker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: '/assets/vendor/tesseract/worker.min.js', corePath: '/assets/vendor/tesseract', langPath: '/assets/vendor/tesseract',
    workerBlobURL: false, cacheMethod: 'none', logger: (m) => { if (m.status === 'recognizing text') say(Math.round(m.progress * 100)); },
  });
  try {
    const pages = [];
    for (; current < canvases.length; current++) {
      const canvas = canvases[current];
      const { data } = await worker.recognize(canvas, { rotateAuto: true }, { blocks: true });
      const lines = (data.blocks || []).flatMap((b) => b.paragraphs).flatMap((p) => p.lines);
      pages.push(pageFromOcr(lines, canvas.width, canvas.height));
    }
    return pages;
  } finally {
    await worker.terminate();
  }
}
const isPicture = (f) => /\.(png|jpe?g|webp|bmp|heic|heif)$/i.test(f.name) || /^image\//.test(f.type);

const NO_DISHES = "No dishes with prices could be found in this file. For a photo: hold the camera straight above the menu in good light, with the whole page in view and in focus. Menus in other languages or very decorative lettering may not be readable. You can also type the menu as a .txt list: one dish per line with its price, and each section's name on its own line.";
const HEIC = "This browser can't open iPhone HEIC photos. Save the photo as JPG (or set the camera to Most Compatible) and try again.";
const symbol = (code) => CURRENCIES[code].trim();
// The built-in sample dishes a new restaurant starts with; an imported menu replaces them by default.
const isSampleMenu = (menu) => menu.length > 0 && menu.every((m) => !m.id.startsWith('dish-'));

function Ingestor({ dispatch, toast, menu, onDone }) {
  const [file, setFile] = useState(null);
  const [reading, setReading] = useState(''); // what is happening while a file is read
  const [found, setFound] = useState(null); // { title, sections }
  const [rows, setRows] = useState(null);
  const [cur, setCur] = useState(currency());
  const [replace, setReplace] = useState(null);
  const [photos, setPhotos] = useState(null); // 'web' | 'none', asked every time
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false); // staff compared a picture's dishes with the menu
  const inputRef = useRef(null);

  const reset = () => { setRows(null); setFound(null); setFile(null); setError(''); setPhotos(null); setReplace(null); };
  const show = (f, result, fromPicture = false) => {
    if (!result.rows.length) { setError(NO_DISHES); setRows(null); return; }
    setFound({ title: result.title, sections: result.sections, fromPicture, hardToRead: result.hardToRead });
    setChecked(false);
    setCur(result.currency && CURRENCIES[result.currency] ? result.currency : currency());
    setReplace(isSampleMenu(menu) ? true : null);
    setPhotos(null);
    setRows(result.rows.map((r) => ({ key: Math.random(), ...r })));
  };
  // One PDF or text file, or several photos of the pages of one menu.
  const handle = async (list) => {
    const files = [...(list || [])];
    const f = files[0];
    if (!f) return;
    const pictures = files.filter(isPicture);
    const isText = /\.(txt|csv|md)$/i.test(f.name) || /^text\//.test(f.type);
    const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    if (!pictures.length && !isText && !isPdf) { toast('Upload a PDF, a photo, or a .txt/.csv menu.', 'danger'); return; }
    if (files.some((x) => x.size > 20 * 1024 * 1024)) { toast('That file is over 20 MB.', 'danger'); return; }
    setFile(pictures.length > 1 ? { name: `${pictures.length} photos` } : f); setRows(null); setError(''); setReading('Reading the menu…');
    try {
      if (pictures.length) {
        if (pictures.some((x) => /\.hei[cf]$/i.test(x.name))) { setError(HEIC); return; }
        if (pictures.length > 10) { setError('Please choose up to 10 photos at a time.'); return; }
        const canvases = [];
        for (const p of pictures) canvases.push(await photoCanvas(p));
        show(f, parseMenu(linesFromPdf(await readPictures(canvases, setReading))), true);
      } else if (isText) {
        show(f, parseMenuText(await f.text()));
      } else {
        const { pages, fromPicture } = await readPdf(f, setReading);
        show(f, parseMenu(linesFromPdf(pages)), fromPicture);
      }
    } catch (e) {
      console.error(e);
      setError(pictures.length ? "This picture couldn't be read. Please try a JPG or PNG." : "This PDF couldn't be read. If it's password-protected, save an unprotected copy and try again.");
    } finally {
      setReading('');
    }
  };
  const upd = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const renameSection = (id, label) => setFound((f) => ({ ...f, sections: f.sections.map((s) => (s.id === id ? { ...s, label } : s)) }));
  const onMenu = (r) => !replace && menu.some((m) => m.name.toLowerCase() === r.name.trim().toLowerCase());
  const invalid = (r) => !r.name.trim() || (r.sizes ? !sizesReady(r.sizes) : !(r.price >= 0.5 && r.price <= 100000)) || onMenu(r);
  const used = found ? found.sections.filter((s) => rows && rows.some((r) => r.category === s.id)) : [];
  const categoryOptions = [...used, ...CATEGORIES.filter((c) => !['all', 'specials'].includes(c.id))];
  const [publishing, setPublishing] = useState(false);
  const undecided = rows ? rows.filter((r) => r.priceRange && !r.rangeDone).length : 0;
  const blocked = publishing || !rows || !rows.length || undecided > 0 || (found && found.fromPicture && !checked) || rows.some(invalid) || rows.some((r) => !r.meals.length) || replace === null || !photos || used.some((s) => !s.label.trim());
  const publish = async () => {
    const items = rows.map((r) => ({
      name: r.name.trim(), desc: r.desc, category: r.category, price: Math.round(r.price * 100) / 100, aliases: r.aliases || [], ...(r.sizes ? { sizes: cleanSizes(r.sizes) } : {}),
      diet: r.diet, vegan: r.vegan, gf: r.gf, spicy: r.spicy, meals: r.meals, allergens: r.allergens,
    }));
    setPublishing(true);
    const res = await dispatch({ type: 'PUBLISH_ITEMS', body: { items, sections: used.map((s) => ({ id: s.id, label: s.label.trim() })), currency: cur, replace, photos } });
    setPublishing(false);
    if (!res) return;
    toast(`Published ${res.added} dishes to every table tablet.${photos === 'web' ? ' Photos are being added; they appear as each one is found.' : ''}`);
    reset();
    onDone();
  };

  return (
    <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] gap-5 items-start">
      <div className="flex flex-col gap-4">
        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files); }}
          onClick={() => inputRef.current && inputRef.current.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && inputRef.current.click()}
          className={'rounded-2xl border-2 border-dashed p-6 text-center cursor-pointer transition ' + (drag ? 'border-gold bg-gold-wash' : 'border-line bg-white hover:border-gold')}>
          <div className="mx-auto w-12 h-12 rounded-full bg-gold-wash text-gold-dark flex items-center justify-center"><Icon name="upload" className="w-6 h-6" /></div>
          <p className="font-serif text-lg mt-3">Drop your menu here</p>
          <p className="text-[12.5px] text-muted mt-1">A PDF, photos of the menu's pages, or a .txt/.csv price list, up to 20 MB each</p>
          <input ref={inputRef} id="menu-file" type="file" multiple accept=".pdf,.txt,.csv,.md,.png,.jpg,.jpeg,.webp,.heic,application/pdf,text/plain,image/*" className="hidden" onChange={(e) => { handle(e.target.files); e.target.value = ''; }} />
        </div>
        <button onClick={() => { setFile({ name: 'Sample menu' }); setError(''); show(null, { title: null, currency: null, sections: [], rows: SAMPLE_EXTRACTION }); }} className="btn-outline justify-center">Try a sample menu</button>
        <p className="text-[11.5px] text-muted leading-relaxed">The menu is read on this computer. Its sections become the tablet's categories, in the menu's order; prices keep the menu's currency. Diet tags, spice and allergens are suggestions to check. Photos and scans are read in English, and need checking against the menu.</p>
        {file && (reading || error) && (
          <div className="glass rounded-2xl p-4" role={error ? 'alert' : 'status'}>
            <p className="label mb-2">{file.name}</p>
            {reading ? <p className="text-sm flex items-center gap-2"><span className="w-4 h-4 rounded-full border-2 border-gold border-t-transparent animate-spin" />{reading}</p>
              : <p className="text-sm text-[#8A2E1C]">{error}</p>}
          </div>
        )}
      </div>

      <div className="min-w-0">
        {!rows ? (
          <div className="glass rounded-2xl p-8 text-center">
            <p className="font-serif text-xl">{reading ? 'Reading your menu…' : 'Dishes from your menu will appear here'}</p>
            {reading && <p className="text-sm text-muted mt-1">A photo can take a minute. This all happens on this computer.</p>}
            <p className="text-sm text-muted mt-1 max-w-md mx-auto">Sections, dish names, descriptions and prices are pulled into an editable table for you to check before publishing.</p>
          </div>
        ) : (
          <div className="glass rounded-2xl">
            <div className="p-4 flex flex-wrap items-start justify-between gap-3 border-b border-line">
              <div>
                <p className="font-serif text-xl">{rows.length} dishes{used.length ? ` in ${used.length} section${used.length === 1 ? '' : 's'}` : ''}{found.title ? ` · ${found.title}` : ''}</p>
                <p className="text-[12.5px] text-muted">Check each row, answer the questions below, then publish. Highlighted rows need a look.</p>
                {found.fromPicture && found.hardToRead && <p className="text-sm font-semibold text-[#8A2E1C] mt-1">This picture was hard to read, so many dishes may be wrong. A sharper photo will save you time: hold the camera straight above the menu, in good light.</p>}
                {found.fromPicture && (
                  <label className="flex items-start gap-2 text-[13px] text-[#7A4B06] mt-1.5 cursor-pointer">
                    <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[#2E7D4F]" checked={checked} onChange={() => setChecked(!checked)} />
                    <span><strong>I've checked every name and price against the menu.</strong> This was read from a picture, and a misread price would be charged to guests.</span>
                  </label>
                )}
                {undecided > 0 && <p className="text-[12.5px] font-semibold text-[#7A4B06] mt-1">{undecided} price {undecided === 1 ? 'range needs' : 'ranges need'} a decision before you can publish.</p>}
              </div>
              <div className="flex gap-2">
                <button onClick={reset} className="btn-outline py-2">Discard</button>
                <button onClick={publish} disabled={blocked} className="btn-gold py-2 disabled:bg-[#CFC6B8] disabled:cursor-not-allowed">{publishing ? 'Publishing…' : 'Approve & Publish to Tablets'}</button>
              </div>
            </div>

            <div className="p-4 grid md:grid-cols-2 gap-4 border-b border-line">
              <fieldset className="flex flex-col gap-1.5">
                <legend className="label mb-1.5">Dish photos</legend>
                <p className="text-[12.5px] text-muted">This menu has no photo for each dish. Do you want photos on the tablets?</p>
                {[['web', 'Yes, add a photo of each dish from the internet', 'Free-licensed photos from Wikipedia, matched to each dish name and saved on this computer. You can change or remove any of them in Menu Control.'],
                  ['none', 'No photos', 'Dishes show their name on a plain plate instead.']].map(([v, label, hint]) => (
                  <label key={v} className="flex items-start gap-2 text-sm cursor-pointer">
                    <input type="radio" name="photos" className="mt-1 accent-[#B07A2A]" checked={photos === v} onChange={() => setPhotos(v)} />
                    <span>{label}<span className="block text-[12px] text-muted">{hint}</span></span>
                  </label>
                ))}
              </fieldset>
              <div className="flex flex-col gap-3">
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="label mb-1.5">Your current menu ({menu.length} dishes)</legend>
                  {[[true, 'Replace it with this menu', isSampleMenu(menu) ? 'Recommended: the current menu is the sample menu.' : 'Every current dish is removed and carts are emptied. Orders already sent are kept.'],
                    [false, 'Add these dishes to it', 'Dishes already on the menu are skipped.']].map(([v, label, hint]) => (
                    <label key={String(v)} className="flex items-start gap-2 text-sm cursor-pointer">
                      <input type="radio" name="replace" className="mt-1 accent-[#B07A2A]" checked={replace === v} onChange={() => setReplace(v)} />
                      <span>{label}<span className="block text-[12px] text-muted">{hint}</span></span>
                    </label>
                  ))}
                </fieldset>
                <label className="flex items-center gap-2 text-sm">
                  <span className="label">Currency</span>
                  <select value={cur} onChange={(e) => setCur(e.target.value)} className="bg-sand rounded-lg px-2 py-1.5">
                    {Object.keys(CURRENCIES).map((c) => <option key={c} value={c}>{c} ({symbol(c)})</option>)}
                  </select>
                  {cur !== currency() && <span className="text-[12px] text-muted">All prices will show in {cur}.</span>}
                </label>
              </div>
              {used.length > 0 && (
                <div className="md:col-span-2">
                  <p className="label mb-1.5">Sections (the tablet's categories, in this order)</p>
                  <div className="flex flex-wrap gap-2">
                    {used.map((s) => <input key={s.id} aria-label="Section name" value={s.label} onChange={(e) => renameSection(s.id, e.target.value.slice(0, 48))} className="bg-sand rounded-lg px-2.5 py-1.5 text-sm w-[220px] focus:outline-none focus:ring-2 focus:ring-gold/50" />)}
                  </div>
                </div>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[980px]">
                <thead><tr className="text-left text-muted text-[11.5px] uppercase tracking-wider">
                  <th className="font-medium px-3 py-2.5">Dish & description</th><th className="font-medium px-2">Price</th><th className="font-medium px-2">Section</th><th className="font-medium px-2">Diet & spice</th><th className="font-medium px-2">Allergens</th><th className="font-medium px-2">Meals</th><th className="font-medium px-2">Conf.</th><th className="px-2" />
                </tr></thead>
                <tbody className="divide-y divide-line align-top">
                  {rows.map((r) => (
                    <tr key={r.key} className={invalid(r) ? 'bg-[#FDF1EE]' : r.conf < 0.8 ? 'bg-[#FFF8EC]' : ''}>
                      <td className="px-3 py-2.5 min-w-[260px]">
                        <input aria-label="Dish name" value={r.name} onChange={(e) => upd(r.key, { name: e.target.value })} className="cell font-medium" />
                        <textarea aria-label="Description" value={r.desc} rows={2} placeholder="No description on the menu" onChange={(e) => upd(r.key, { desc: e.target.value })} className="cell text-[12.5px] text-muted mt-1 resize-none" />
                        {(r.priceNote || r.lowConf) && <p className="text-[11.5px] text-[#7A4B06] mt-1">{r.priceNote || r.lowConf}</p>}
                        {r.priceRange && !r.rangeDone && (
                          <div className="flex gap-2 mt-1.5">
                            <button type="button" className="btn-outline py-1 px-2.5 text-[12px]" onClick={() => upd(r.key, { rangeDone: true, priceNote: '', sizes: [{ label: 'Half', price: r.priceRange[0] }, { label: 'Full', price: r.priceRange[1] }] })}>These are sizes</button>
                            <button type="button" className="btn-outline py-1 px-2.5 text-[12px]" onClick={() => upd(r.key, { rangeDone: true, priceNote: '' })}>One price</button>
                          </div>
                        )}
                        {r.sizes && <div className="mt-1.5"><SizeRows sizes={r.sizes} onChange={(sizes) => upd(r.key, sizes.length ? { sizes, priceNote: '' } : { sizes: null, priceNote: '' })} /></div>}
                        {onMenu(r) && <p className="text-[11.5px] text-[#B5462E] mt-1">Already on the menu</p>}
                      </td>
                      <td className="px-2 py-2.5">{r.sizes ? <span className="text-[12px] text-muted whitespace-nowrap">By size</span> : <div className="flex items-center bg-sand rounded-lg pl-2 w-[104px]"><span className="text-muted text-[12px]">{symbol(cur)}</span><input aria-label="Price" value={r.price} inputMode="decimal" onChange={(e) => upd(r.key, { price: parseFloat(e.target.value.replace(/[^0-9.]/g, '')) || 0, ...(r.priceRange ? {} : { priceNote: '' }) })} className="w-full bg-transparent px-1 py-1.5 tabular-nums focus:outline-none" /></div>}</td>
                      <td className="px-2 py-2.5"><select aria-label="Section" value={r.category} onChange={(e) => upd(r.key, { category: e.target.value })} className="bg-sand rounded-lg px-2 py-1.5 max-w-[190px]">{categoryOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></td>
                      <td className="px-2 py-2.5">
                        <div className="flex flex-wrap gap-1 w-[180px]">
                          <button onClick={() => upd(r.key, { diet: r.diet === 'veg' ? 'nonveg' : 'veg', vegan: false })} className="mini-chip mini-chip-on"><DietMark diet={r.diet} />{r.diet === 'veg' ? 'Veg' : 'Non-Veg'}</button>
                          <button onClick={() => upd(r.key, { vegan: !r.vegan, diet: 'veg' })} aria-pressed={r.vegan} className={'mini-chip ' + (r.vegan ? 'mini-chip-on' : '')}>Vegan</button>
                          <button onClick={() => upd(r.key, { gf: !r.gf })} aria-pressed={r.gf} className={'mini-chip ' + (r.gf ? 'mini-chip-on' : '')}>GF</button>
                          <select aria-label="Spice level" value={r.spicy} onChange={(e) => upd(r.key, { spicy: +e.target.value })} className="mini-chip bg-white">{[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n ? `Spicy ${n}` : 'Not spicy'}</option>)}</select>
                        </div>
                      </td>
                      <td className="px-2 py-2.5"><input aria-label="Allergens" value={r.allergens.join(', ')} onChange={(e) => upd(r.key, { allergens: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="none" className="cell w-[120px]" /></td>
                      <td className="px-2 py-2.5">
                        <div className="flex gap-1">{['breakfast', 'lunch', 'dinner'].map((ml) => <button key={ml} onClick={() => upd(r.key, { meals: r.meals.includes(ml) ? r.meals.filter((x) => x !== ml) : [...r.meals, ml] })} aria-pressed={r.meals.includes(ml)} title={ml} className={'mini-chip capitalize ' + (r.meals.includes(ml) ? 'mini-chip-on' : '')}>{ml[0].toUpperCase()}</button>)}</div>
                      </td>
                      <td className="px-2 py-2.5 tabular-nums"><span className={r.conf < 0.8 ? 'text-[#7A4B06] font-semibold' : 'text-veg'}>{Math.round(r.conf * 100)}%</span></td>
                      <td className="px-2 py-2.5"><button onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="text-muted hover:text-[#B5462E]" aria-label={`Remove ${r.name}`}><Icon name="x" className="w-4 h-4" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const ANSWER = { contains: ['Told: contains it', 'text-ink'], free: ['Told: not in this dish', 'text-veg'], unknown: ['Not confirmed: server called', 'text-[#8A2E1C]'] };
function AllergyLog({ entries, now }) {
  if (!entries.length) return null;
  return (
    <section className="glass rounded-2xl mt-5 overflow-x-auto">
      <p className="label px-4 pt-4">Allergy questions (last 30 days)</p>
      <table className="w-full text-sm min-w-[560px] mt-2">
        <thead><tr className="text-left text-muted text-[11.5px] uppercase tracking-wider"><th className="font-medium px-4 py-2">When</th><th className="font-medium px-2">Table</th><th className="font-medium px-2">Dish</th><th className="font-medium px-2">Asked about</th><th className="font-medium px-4">Answer</th></tr></thead>
        <tbody className="divide-y divide-line">
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="px-4 py-2 text-muted whitespace-nowrap">{ago(now - e.at)}</td>
              <td className="px-2 py-2">{tableName(e.table)}</td>
              <td className="px-2 py-2">{e.item}</td>
              <td className="px-2 py-2">{ALLERGENS[e.allergen] ? ALLERGENS[e.allergen].label : e.allergen}</td>
              <td className={'px-4 py-2 ' + ANSWER[e.answer][1]}>{ANSWER[e.answer][0]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Requests({ requests, allergenLog, dispatch, now, printBill }) {
  if (!requests.length) return <><p className="text-muted text-sm">No service requests yet. Calls from tables appear here instantly.</p><AllergyLog entries={allergenLog} now={now} /></>;
  return (
    <>
    <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {requests.map((r) => (
        <article key={r.id} className={'glass rounded-2xl p-4 flex flex-col gap-2 ' + (r.status === 'open' ? 'shadow-[0_0_0_3px_rgba(200,149,71,0.35)]' : 'opacity-80')}>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 font-semibold"><Icon name={r.type === 'bill' ? 'split' : 'bell'} className="w-4 h-4 text-gold-dark" />{tableName(r.table)}</span>
            <span className="text-[11.5px] text-muted tabular-nums">{r.status === 'open' ? `waiting ${mmss(now - r.at)}` : r.status}</span>
          </div>
          <p className="font-serif text-lg">{r.type === 'bill' ? 'Bill requested' : 'Server called'}</p>
          <p className="text-[13px] text-muted">{r.detail}</p>
          <div className="flex flex-wrap gap-2 mt-1">
            {r.type === 'bill' && <button onClick={() => printBill(r.table)} className="btn-outline py-1.5 px-3 text-[13px]"><Icon name="printer" className="w-3.5 h-3.5" />Print bill</button>}
            {r.status === 'open' && <button onClick={() => dispatch({ type: 'REQUEST_STATUS', id: r.id, status: 'acknowledged' })} className="btn-gold py-1.5 px-3 text-[13px]">Acknowledge</button>}
            {r.status !== 'done' && <button onClick={() => dispatch({ type: 'REQUEST_STATUS', id: r.id, status: 'done' })} className="btn-outline py-1.5 px-3 text-[13px]">{r.type === 'bill' ? 'Mark paid' : 'Mark done'}</button>}
          </div>
        </article>
      ))}
    </div>
    <AllergyLog entries={allergenLog} now={now} />
    </>
  );
}

// Whether the licence is working, with what to do when it isn't.
const HEALTH_LOOK = { ok: ['bg-[#2E7D4F]', 'Working'], warn: ['bg-[#E8A84C]', 'Needs a look'], down: ['bg-[#B5462E]', 'Not working'] };
function HealthView({ health, now, onCheck }) {
  if (!health) return <Loading label="Checking the system…" />;
  const worst = health.checks.filter((c) => c.status === 'down').length;
  const look = health.checks.filter((c) => c.status === 'warn').length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-serif text-xl">{worst ? `${worst} ${worst === 1 ? 'thing isn\u2019t' : 'things aren\u2019t'} working` : look ? `${look} ${look === 1 ? 'thing needs' : 'things need'} a look` : 'Everything is working'}</p>
        <span className="flex items-center gap-3 text-[13px] text-muted">Checked {ago(now - health.at)}<button className="btn-outline py-1.5 px-3 text-[13px]" onClick={onCheck}>Check now</button></span>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {health.checks.map((c) => (
          <article key={c.id} className="glass rounded-2xl p-4 flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{c.label}</span>
              <span className="flex items-center gap-1.5 text-[12px] text-muted"><span className={'w-2.5 h-2.5 rounded-full ' + HEALTH_LOOK[c.status][0]} />{HEALTH_LOOK[c.status][1]}</span>
            </div>
            <p className="text-sm text-ink break-words">{c.detail}</p>
            {c.fix && <p className="text-[13px] text-[#7A4B06] mt-1">{c.fix}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}

function SecurityLog({ entries, now }) {
  const tone = { guardrail: 'bg-[#FBEAE6] text-[#8A2E1C]', schema: 'bg-[#EEF1F6] text-[#3A4A66]', ratelimit: 'bg-[#FFF4E5] text-[#7A4B06]' };
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
      <div className="glass rounded-2xl overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead><tr className="text-left text-muted text-[11.5px] uppercase tracking-wider"><th className="font-medium px-4 py-2.5">When</th><th className="font-medium px-2">Table</th><th className="font-medium px-2">Layer</th><th className="font-medium px-2">Input</th><th className="font-medium px-4">Outcome</th></tr></thead>
          <tbody className="divide-y divide-line">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-2.5 text-muted whitespace-nowrap">{ago(now - e.at)}</td>
                <td className="px-2 py-2.5">{tableName(e.table)}</td>
                <td className="px-2 py-2.5"><span className={'text-[11.5px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ' + tone[e.type]}>{e.kind}</span></td>
                <td className="px-2 py-2.5 font-mono text-[12px] max-w-[260px] truncate" title={e.input}>{e.input}</td>
                <td className="px-4 py-2.5 text-[12.5px] text-muted">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bg-ink text-cream rounded-2xl p-5">
        <p className="text-[10.5px] tracking-[0.3em] uppercase text-gold">Request pipeline</p>
        <ol className="mt-3 flex flex-col gap-3 text-[13px]">
          {[['Rate limiter', `${RATE_LIMIT} commands per minute per table, then a cooldown`], ['Speech safety parse', `${MAX_TURN_MS / 1000}-second turns, control characters stripped, 240-character cap`], ['Input guardrail', 'Prompt injection, price manipulation and off-topic requests are refused'], ['Schema validation', 'Tool calls checked against strict schemas; price fields are stripped'], ['Pricing engine', 'Totals are computed from the menu database only']].map(([h, d], i) => (
            <li key={h} className="flex gap-3"><span className="w-6 h-6 rounded-full border border-gold/60 text-gold flex items-center justify-center text-[11px] shrink-0 tabular-nums">{i + 1}</span><span><span className="font-medium">{h}</span><br /><span className="text-cream/65">{d}</span></span></li>
          ))}
        </ol>
      </div>
    </div>
  );
}


// ---------------- Kitchen screen (/kitchen) ----------------
// Large tickets, oldest first, with a timer against each dish's prep time, a bump button, sound for
// new orders and optional printing. A ticket prints automatically only once the guest's undo
// window has passed.
function KitchenScreen({ state, dispatch, now, online, sound, setSound }) {
  const { restaurant } = useContext(RestaurantContext);
  const [autoPrint, setAutoPrint] = useState(() => readPref('flv.autoPrint', false));
  const [printing, setPrinting] = useState(null);
  const printed = useRef(new Set(state.orders.map((o) => o.id)));
  useEffect(() => savePref('flv.autoPrint', autoPrint), [autoPrint]);
  const undoMs = state.undoMs || 60000;
  const tickets = state.orders.filter((o) => o.status !== 'served').sort((a, b) => a.createdAt - b.createdAt);
  useEffect(() => {
    if (!autoPrint || printing) return;
    const next = tickets.find((o) => !printed.current.has(o.id) && now - o.createdAt >= undoMs);
    if (next) setPrinting(next.id);
  }, [autoPrint, printing, tickets, now, undoMs]);
  useEffect(() => {
    if (!printing) return;
    printed.current.add(printing);
    const id = setTimeout(() => { window.print(); setPrinting(null); }, 50);
    return () => clearTimeout(id);
  }, [printing]);
  return (
    <main className="min-h-[100vh] bg-ink text-cream gutter pb-10">
      <header className="sticky top-0 z-10 bg-ink py-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-white/10">
        <h1 className="font-serif text-2xl mr-auto">{restaurant} · Kitchen</h1>
        <span className="text-sm text-cream/70 tabular-nums">{tickets.length} open ticket{tickets.length === 1 ? '' : 's'}</span>
        <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={autoPrint} onChange={() => setAutoPrint((v) => !v)} className="w-4 h-4" />Print new tickets</label>
        <button onClick={() => { setSound((s) => !s); if (!sound) chime('order'); }} className="flex items-center gap-1.5 text-sm text-cream/80 hover:text-cream" aria-pressed={sound}><Icon name={sound ? 'volume' : 'mute'} className="w-4 h-4" />{sound ? 'Sound on' : 'Sound off'}</button>
        <span className={'flex items-center gap-1.5 text-xs ' + (online ? 'text-[#9FD8B4]' : 'text-[#F3C27A]')}><span className={'w-2 h-2 rounded-full ' + (online ? 'bg-[#5FBF85]' : 'bg-[#E8A84C] animate-pulse')} />{online ? 'Live' : 'Reconnecting'}</span>
      </header>
      {!tickets.length && <p className="text-center text-cream/60 text-xl mt-24">No open tickets. New orders appear here with a sound.</p>}
      <div className="mt-5 grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))] items-start">
        {tickets.map((o) => {
          const age = now - o.createdAt;
          const late = age > o.prepMins * 60e3;
          const soon = age > o.prepMins * 60e3 * 0.75;
          const undoLeft = o.status === 'received' ? undoMs - age : 0;
          return (
            <article key={o.id} className={'rounded-2xl bg-[#FBF7F0] text-ink overflow-hidden ' + (printing === o.id ? 'print-ticket' : '')}>
              <div className={'px-4 py-3 flex items-center justify-between gap-3 ' + (late ? 'bg-[#B5462E] text-white' : soon ? 'bg-[#E8A84C] text-ink' : 'bg-[#2E7D4F] text-white')}>
                <span className="font-serif text-3xl">{tableName(o.table)}</span>
                <span className="text-right leading-tight"><span className="block font-mono text-2xl tabular-nums">{mmss(age)}</span><span className="text-[11px] opacity-85">{o.id} · target {o.prepMins} min</span></span>
              </div>
              <ul className="px-4 py-3 flex flex-col gap-1.5 text-[19px] leading-snug">
                {o.lines.map((l) => (
                  <li key={l.name + l.mods.join()}><span className="font-bold tabular-nums">{l.qty} ×</span> {l.name}{l.mods.length > 0 && <strong className="block text-[16px] text-[#8A2E1C] uppercase tracking-wide">{modsText(l.mods)}</strong>}</li>
                ))}
              </ul>
              {o.note && <p className="mx-4 mb-3 rounded-lg bg-[#FFE7B8] text-[#5A3604] px-3 py-2 text-[16px] font-bold">{o.note}</p>}
              {undoLeft > 0 && <p className="mx-4 mb-2 text-[13px] text-[#7A4B06]">Guest can still take this back for {mmss(undoLeft)}</p>}
              <div className="px-4 pb-4 flex gap-2 no-print">
                <button onClick={() => dispatch({ type: 'ADVANCE_ORDER', id: o.id })} className={'flex-1 justify-center text-base py-3 ' + (o.status === 'received' ? 'btn-gold' : 'btn-outline')}>{o.status === 'received' ? 'Start cooking' : 'Bump · served'}</button>
                <button onClick={() => setPrinting(o.id)} className="btn-outline px-3" aria-label={`Print ticket for ${tableName(o.table)}`}><Icon name="printer" className="w-5 h-5" /></button>
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}

// ---------------- Floor view (/floor), for waiters' phones ----------------
// Open requests, longest wait first, and the tables each waiter has chosen to look after. The choice
// is kept on the phone itself; with none chosen, every table shows.
function FloorView({ state, dispatch, now, online, sound, setSound, onLogout, service }) {
  const { restaurant } = useContext(RestaurantContext);
  const [mine, setMine] = useState(() => readPref('flv.myTables', []));
  const [picking, setPicking] = useState(false);
  useEffect(() => savePref('flv.myTables', mine), [mine]);
  const watch = (t) => !mine.length || mine.includes(t);
  const open = state.requests.filter((r) => r.status !== 'done' && watch(r.table)).sort((a, b) => a.at - b.at);
  const seated = state.tables.filter((t) => watch(t) && state.occupancy?.[t]);
  return (
    <main className="gutter pb-12 max-w-xl mx-auto">
      <header className="sticky z-10 pt-3 pb-2 glass-bg" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
        <div className="glass-nav rounded-2xl px-4 py-2.5 flex items-center gap-3">
          <div className="mr-auto min-w-0"><p className="font-serif text-lg truncate">{restaurant}</p><p className="text-[10px] tracking-[0.24em] text-gold-dark">FLOOR</p></div>
          <SoundToggle sound={sound} setSound={setSound} />
          <LiveBadge online={online} />
          <button onClick={onLogout} aria-label="Sign out" className="text-muted"><Icon name="logout" className="w-5 h-5" /></button>
        </div>
        <ServiceNotice service={service} />
      </header>
      <section className="mt-3 glass rounded-2xl p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm">{mine.length ? `My tables: ${mine.map((t) => t.slice(1)).join(', ')}` : 'Showing every table'}</p>
          <button onClick={() => setPicking((p) => !p)} className="text-sm text-gold-dark font-medium">{picking ? 'Done' : 'Choose tables'}</button>
        </div>
        {picking && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {state.tables.map((t) => <button key={t} onClick={() => setMine((m) => (m.includes(t) ? m.filter((x) => x !== t) : [...m, t].sort((a, b) => a.slice(1) - b.slice(1))))} aria-pressed={mine.includes(t)} className={'chip ' + (mine.includes(t) ? 'chip-on' : '')}>{t.slice(1)}</button>)}
            {mine.length > 0 && <button onClick={() => setMine([])} className="chip">All tables</button>}
          </div>
        )}
      </section>
      <h2 className="font-serif text-xl mt-5 mb-2">Waiting for you {open.length > 0 && <span className="text-[#8A2E1C]">· {open.length}</span>}</h2>
      {!open.length && <p className="text-sm text-muted">Nobody is waiting. New calls play a sound and vibrate this phone.</p>}
      <ul className="flex flex-col gap-2.5">
        {open.map((r) => (
          <li key={r.id} className={'glass rounded-2xl p-4 ' + (r.status === 'open' ? 'shadow-[0_0_0_3px_rgba(200,149,71,0.35)]' : '')}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-serif text-2xl">{tableName(r.table)}</span>
              <span className={'tabular-nums text-sm font-semibold ' + (now - r.at > 180e3 ? 'text-[#B5462E]' : 'text-muted')}>{mmss(now - r.at)}</span>
            </div>
            <p className="font-medium mt-0.5">{r.type === 'bill' ? 'Bill requested' : 'Server called'}{r.status === 'acknowledged' ? ' · on the way' : ''}</p>
            <p className="text-[13px] text-muted">{r.detail}</p>
            <div className="flex gap-2 mt-3">
              {r.status === 'open' && <button onClick={() => dispatch({ type: 'REQUEST_STATUS', id: r.id, status: 'acknowledged' })} className="btn-gold flex-1 justify-center py-2.5">On my way</button>}
              <button onClick={() => dispatch({ type: 'REQUEST_STATUS', id: r.id, status: 'done' })} className="btn-outline flex-1 justify-center py-2.5">{r.type === 'bill' ? 'Mark paid' : 'Done'}</button>
            </div>
          </li>
        ))}
      </ul>
      <h2 className="font-serif text-xl mt-6 mb-2">Seated tables</h2>
      {!seated.length && <p className="text-sm text-muted">No seated tables{mine.length ? ' in your section' : ''}.</p>}
      <ul className="flex flex-col divide-y divide-line glass rounded-2xl px-4">
        {seated.map((t) => {
          const { seatedFor } = tableTimes(state, t, now);
          const cooking = state.orders.filter((o) => o.table === t && !o.paid && o.status !== 'served').length;
          return (
            <li key={t} className="py-3 flex items-center justify-between gap-3">
              <span className="font-medium">{tableName(t)}</span>
              <span className="text-[13px] text-muted text-right">{seatedFor !== null ? `Seated ${Math.floor(seatedFor / 60000)} min` : 'Just seated'}{cooking ? ` · ${cooking} order${cooking === 1 ? '' : 's'} cooking` : ''}</span>
            </li>
          );
        })}
      </ul>
    </main>
  );
}


ReactDOM.createRoot(document.getElementById('root')).render(<AdminApp />);
