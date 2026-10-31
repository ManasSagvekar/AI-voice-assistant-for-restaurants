import { MODIFIERS } from '../shared/engine.js';

export const { useState, useEffect, useRef, useMemo, useCallback } = React;

export const uid = (p) => p + Math.random().toString(36).slice(2, 8).toUpperCase();
export const tableName = (t) => 'Table ' + t.slice(1);
export const mmss = (ms) => {
  const s = Math.max(0, Math.round(Math.abs(ms) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const ago = (ms) => (ms < 60000 ? 'just now' : `${Math.floor(ms / 60000)} min ago`);
export const modsText = (mods) => mods.map((k) => MODIFIERS[k].label.toLowerCase()).join(', ');
export const joinWords = (arr) => (arr.length < 2 ? arr.join('') : arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1]);

export const Icon = ({ name, className = 'w-5 h-5' }) => {
  const p = {
    all: <><circle cx="7" cy="7" r="2.6" /><circle cx="17" cy="7" r="2.6" /><circle cx="7" cy="17" r="2.6" /><circle cx="17" cy="17" r="2.6" /></>,
    starters: <><path d="M3 12h18a9 9 0 0 1-18 0Z" /><path d="M8 8c0-1.5 1-2 1-3.5M12 8c0-1.5 1-2 1-3.5M16 8c0-1.5 1-2 1-3.5" /></>,
    mains: <><path d="M4 17h16" /><path d="M5.5 17a6.5 6.5 0 0 1 13 0" /><path d="M12 8.5V7" /><circle cx="12" cy="6" r="1" /><path d="M3 20h18" /></>,
    pizza: <><path d="M12 21 3.5 5.5a14 14 0 0 1 17 0Z" /><path d="M4.8 7.8a12 12 0 0 1 14.4 0" /><circle cx="10.5" cy="11" r="1" /><circle cx="13.5" cy="14.5" r="1" /></>,
    desserts: <><path d="M4 20h16v-8H4Z" /><path d="M4 14c2 1.5 3.5-1 5.3 0s3.4 1.5 5.4 0 3.3-1 5.3 0" /><path d="M12 12V9" /><path d="M12 9c-1-1.2-.2-3 0-4 .2 1 1 2.8 0 4Z" /></>,
    beverages: <><path d="M6 3h12l-1.6 17.2a1 1 0 0 1-1 .8H8.6a1 1 0 0 1-1-.8Z" /><path d="M6.6 9h10.8" /><path d="M14 3l2-2" /></>,
    specials: <><path d="M7 14h10v6H7Z" /><path d="M7 14a4 4 0 0 1-1.5-7.7A4 4 0 0 1 12 4a4 4 0 0 1 6.5 2.3A4 4 0 0 1 17 14" /><path d="M7 17h10" /></>,
    mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
    bell: <><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
    bag: <><path d="M5 8h14l-1 12H6Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></>,
    x: <path d="M6 6l12 12M18 6 6 18" />,
    send: <path d="M4 12 20 4l-6 16-3-7Z" />,
    star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" />,
    shield: <><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6Z" /><path d="m9 12 2 2 4-4" /></>,
    upload: <><path d="M12 15V4M7 9l5-5 5 5" /><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
    pause: <path d="M9 5v14M15 5v14" />,
    play: <path d="M7 5v14l12-7Z" />,
    volume: <><path d="M4 9h4l5-4v14l-5-4H4Z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></>,
    mute: <><path d="M4 9h4l5-4v14l-5-4H4Z" /><path d="m17 10 4 4m0-4-4 4" /></>,
    check: <path d="m5 12 5 5L20 7" />,
    logout: <><path d="M15 4h4v16h-4" /><path d="M10 8l-4 4 4 4M6 12h10" /></>,
    split: <><path d="M12 3v18" /><path d="M5 8h4M15 8h4M5 16h4M15 16h4" /></>,
  }[name];
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{p}</svg>;
};

export const Chili = ({ on }) => (
  <svg viewBox="0 0 24 24" className={'w-3.5 h-3.5 ' + (on ? 'text-[#B5462E]' : 'text-line')} fill="currentColor" aria-hidden="true">
    <path d="M14.5 3c.6.8.8 1.7.5 2.6 2.6.6 4.2 3 3.8 5.9-.7 5.2-6.3 9.6-12.7 9.5-1.1 0-1.4-1.3-.4-1.8 4.4-2 6.8-5.4 7.3-9.3.2-1.7 1-2.9 2.4-3.6.1-1-.3-1.9-1.1-2.6Z" />
  </svg>
);

export const DietMark = ({ diet }) => (
  <span title={diet === 'veg' ? 'Vegetarian' : 'Non-vegetarian'} className={'inline-flex items-center justify-center w-3.5 h-3.5 border-[1.5px] rounded-[3px] ' + (diet === 'veg' ? 'border-veg' : 'border-nonveg')}>
    <span className={'w-1.5 h-1.5 rounded-full ' + (diet === 'veg' ? 'bg-veg' : 'bg-nonveg')} />
  </span>
);

export const PLATE_TONES = { starters: '#C9925A', mains: '#8E5A3C', pizza: '#B4553A', desserts: '#7E5A72', beverages: '#C98A3E' };
export function DishImage({ item, className = '' }) {
  const [failed, setFailed] = useState(false);
  if (item.img && !failed) {
    return <img src={item.img} alt={item.name} loading="lazy" onError={() => setFailed(true)} className={'w-full h-full object-cover ' + className} />;
  }
  const tone = PLATE_TONES[item.category] || '#C89547';
  const initials = item.name.replace(/[^A-Za-z ]/g, '').split(' ').filter((w) => w.length > 2).slice(0, 2).map((w) => w[0]).join('');
  return (
    <div className={'plate-bg w-full h-full flex items-center justify-center ' + className} style={{ '--tone': tone }} role="img" aria-label={item.name}>
      <div className="plate"><div className="plate-food"><span className="font-serif italic text-white/95 text-2xl tracking-wide">{initials}</span></div></div>
    </div>
  );
}

export const Switch = ({ on, onChange, label, id }) => (
  <button id={id} type="button" role="switch" aria-checked={on} aria-label={label} onClick={onChange}
    className={'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold ' + (on ? 'bg-veg' : 'bg-[#CFC6B8]')}>
    <span className={'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ' + (on ? 'translate-x-[22px]' : 'translate-x-0.5')} />
  </button>
);

export function Waveform({ state, size = 'md' }) {
  const bars = size === 'sm' ? 5 : 9;
  return (
    <span className={'wave wave-' + state + ' wave-' + size} aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => <i key={i} style={{ animationDelay: `${(i % 5) * 0.11}s` }} />)}
    </span>
  );
}
export const VOICE_LABEL = { idle: 'Assistant ready', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', cooldown: 'Cooling down', standby: 'Standby' };

export function Toasts({ toasts }) {
  return (
    <div className="fixed z-[70] left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 84px)' }} aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'toast-in pointer-events-auto rounded-full px-4 py-2 text-sm shadow-lg border ' + (t.tone === 'warn' ? 'bg-[#FFF4E5] border-[#EBC88F] text-[#7A4B06]' : t.tone === 'danger' ? 'bg-[#FBEAE6] border-[#E6B4A8] text-[#8A2E1C]' : 'bg-ink text-cream border-ink')}>
          {t.text}
        </div>
      ))}
    </div>
  );
}


export const StatusPill = ({ status }) => {
  const s = { received: ['Received', 'bg-[#EEF1F6] text-[#3A4A66]'], kitchen: ['In the kitchen', 'bg-[#FFF4E5] text-[#7A4B06]'], served: ['Served', 'bg-[#E8F3EC] text-veg'] }[status];
  return <span className={'shrink-0 text-[11.5px] font-medium px-2.5 py-1 rounded-full ' + s[1]}>{s[0]}</span>;
};

// ---------- server access ----------
export class ApiError extends Error { constructor(status, body) { super((body && body.error) || 'Request failed'); this.status = status; this.body = body; } }
export async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Live snapshot over Server-Sent Events; EventSource reconnects on its own.
export function useLive(url) {
  const [snap, setSnap] = useState(null);
  const [online, setOnline] = useState(true);
  const [now, setNow] = useState(Date.now());
  const skew = useRef(0);
  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse(e.data);
      skew.current = d.now - Date.now();
      setSnap(d); setOnline(true);
    });
    es.onerror = () => setOnline(false);
    return () => es.close();
  }, [url]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now() + skew.current), 1000); return () => clearInterval(id); }, []);
  return { snap, online, now };
}

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((text, tone) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);
  return [toasts, toast];
}

export const Brand = ({ sub = 'FINE DINING' }) => (
  <div className="flex items-center gap-3">
    <img src="/assets/tazte-logo.png?v=2" alt="Tazte logo" className="h-11 w-auto shrink-0" />
    <div className="text-[9.5px] tracking-[0.24em] text-gold-dark">{sub}</div>
  </div>
);

export const LiveBadge = ({ online }) => (
  <span className={'flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-1.5 border ' + (online ? 'border-line bg-cream text-ink' : 'border-[#EBC88F] bg-[#FFF4E5] text-[#7A4B06]')} aria-live="polite">
    <span className={'w-2 h-2 rounded-full ' + (online ? 'bg-veg' : 'bg-[#E8A84C] animate-pulse')} />
    {online ? 'Live' : 'Reconnecting'}
  </span>
);

export const Loading = ({ label }) => (
  <div className="min-h-[60vh] flex items-center justify-center text-muted text-sm gap-3"><Waveform state="thinking" size="sm" /> {label}</div>
);
