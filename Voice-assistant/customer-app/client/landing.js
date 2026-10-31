// Landing page: the account switcher (top right) and one link per configured table.

const ACCOUNTS = {
  guest: { initial: 'G', name: 'Guest', hi: 'Hi, Guest!', sub: 'Ordering from a table tablet', action: 'Choose your table', href: '#tables', avatar: 'bg-gold text-white' },
  restaurant: { initial: 'R', name: 'Restaurant', hi: 'Restaurant staff', sub: 'Dashboard access needs the staff PIN', action: 'Open staff dashboard', href: '/admin', avatar: 'bg-ink text-gold' },
};
const KEY = 'tazte.account';
const read = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
const save = (v) => { try { localStorage.setItem(KEY, v); } catch (e) { /* storage unavailable */ } };

const btn = document.getElementById('acct-btn');
const pop = document.getElementById('acct-pop');
const rows = [...pop.querySelectorAll('[data-acct]')];

function paintAvatar(el, a) {
  el.textContent = a.initial;
  el.classList.remove('bg-gold', 'text-white', 'bg-ink', 'text-gold');
  el.classList.add(...a.avatar.split(' '));
}

function select(id) {
  const a = ACCOUNTS[id] || ACCOUNTS.guest;
  if (!ACCOUNTS[id]) id = 'guest';
  paintAvatar(btn.querySelector('[data-avatar]'), a);
  paintAvatar(pop.querySelector('[data-avatar-lg]'), a);
  btn.querySelector('[data-name]').textContent = a.name;
  pop.querySelector('[data-hi]').textContent = a.hi;
  pop.querySelector('[data-sub]').textContent = a.sub;
  const action = pop.querySelector('[data-action]');
  action.textContent = a.action; action.href = a.href;
  rows.forEach((r) => r.setAttribute('aria-checked', String(r.dataset.acct === id)));
  document.querySelectorAll('[data-for]').forEach((s) => { s.hidden = s.dataset.for !== id; });
  save(id);
}

function open() {
  pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
  (rows.find((r) => r.getAttribute('aria-checked') === 'true') || rows[0]).focus();
}
function close(refocus) {
  if (pop.hidden) return;
  pop.hidden = true; btn.setAttribute('aria-expanded', 'false');
  if (refocus) btn.focus();
}

btn.addEventListener('click', () => (pop.hidden ? open() : close(false)));
rows.forEach((r) => r.addEventListener('click', () => { select(r.dataset.acct); close(true); }));
pop.querySelector('[data-action]').addEventListener('click', () => close(false));
document.addEventListener('click', (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) close(false); });
document.addEventListener('keydown', (e) => {
  if (pop.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const i = rows.indexOf(document.activeElement);
    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
  }
});

select(read() || 'guest');

fetch('/api/config').then((r) => r.json()).then(({ tables }) => {
  const box = document.getElementById('tables');
  for (const t of tables) {
    const a = document.createElement('a');
    a.href = '/table/' + t.slice(1);
    a.className = 'chip glass-chip';
    a.textContent = 'Table ' + t.slice(1);
    box.appendChild(a);
  }
});
