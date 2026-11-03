// Menu import: turns the text of a menu (a PDF's text layer, or a .txt/.csv price list) into dishes
// grouped by the menu's own sections, with the menu's currency. Runs in the staff browser; the same
// code is unit-tested in Node.
//
// A line with a price at its end is a dish. A short line without a price that is followed by dishes
// and stands out (capitals, a larger font, or a trailing colon) is a section heading. A plain line
// right after a dish is that dish's description. Anything else (the restaurant's name, its address,
// "prices subject to change") is skipped.
import { CATEGORIES, inferTags, norm } from './engine.js';

const CUR = String.raw`(?:AED|Dhs?\.?|DH|USD|US\$|\$|€|EUR|£|GBP|₹|Rs\.?|INR|SAR|QAR|KWD|OMR|BHD|SGD|S\$|MYR|RM|PKR)`;
const NUM = String.raw`\d{1,6}(?:[.,]\d{1,2})?`;
// A price at the end of a line: "AED 31.00 – 38.00", "$12", "250/-", "12.50 AED".
const PRICE = new RegExp(String.raw`(^|\t|\s{2,}|[.·…_]{2,}\s*|\s[-–—|:]\s*|\s)(${CUR}\s?)?(${NUM})(?:\s*\/-)?(?:\s*(?:–|—|-|to)\s*(?:${CUR}\s?)?(${NUM}))?(\s?${CUR})?\s*$`, 'i');
const CURRENCY_CODE = [
  [/^(aed|dhs?\.?|dh)$/i, 'AED'], [/^(\$|usd|us\$)$/i, 'USD'], [/^(€|eur)$/i, 'EUR'], [/^(£|gbp)$/i, 'GBP'],
  [/^(₹|rs\.?|inr)$/i, 'INR'], [/^(s\$|sgd)$/i, 'SGD'], [/^(rm|myr)$/i, 'MYR'],
];
const codeOf = (token) => {
  const t = token.trim();
  for (const [re, code] of CURRENCY_CODE) if (re.test(t)) return code;
  return t.toUpperCase();
};
const toNum = (s) => parseFloat(s.replace(',', '.'));

function readPrice(text) {
  const m = text.match(PRICE);
  if (!m) return null;
  const name = text.slice(0, m.index).replace(/[\s.·…_\-–—|:,]+$/, '').trim();
  const cur = m[2] || m[5] || '';
  // A bare number counts only when something separates it from the name ("Chicken 65" is a name).
  const separated = cur || /\./.test(m[3]) || m[1] === '\t' || /\S/.test(m[1]) || m[1].length > 1 || !name;
  if (!separated) return null;
  const low = toNum(m[3]);
  const high = m[4] ? toNum(m[4]) : null;
  if (!(low > 0)) return null;
  return { name, low, high, currency: cur ? codeOf(cur) : null, raw: text.slice(m.index).trim() };
}

const isHeadingText = (t) => t.length <= 48 && t.split(/\s+/).length <= 7 && !/[.!?]$/.test(t) && !/\d{3,}/.test(t);
const titleCase = (t) => (t === t.toUpperCase() ? t.toLowerCase().replace(/(^|[\s/(&-])([a-z])/g, (_, a, b) => a + b.toUpperCase()) : t);
const BUILT_IN = [
  ['starters', /^(starters?|appeti[sz]ers?|small plates)$/], ['mains', /^(mains?|main courses?|entrees?)$/], ['pizza', /^pizzas?$/],
  ['desserts', /^(desserts?|sweets)$/], ['beverages', /^(beverages?|drinks?)$/],
];
const sectionId = (label) => {
  const n = norm(label);
  for (const [id, re] of BUILT_IN) if (re.test(n)) return id;
  return 'sec-' + n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
};

// Other names guests may say for a dish: without "(Full)", each side of "Roti / Chapati".
function aliasesFor(name) {
  const base = name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const out = new Set([base]);
  const parts = base.split(/\s*\/\s*/);
  if (parts.length > 1) {
    const words = parts[0].split(' ');
    out.add(parts[0]);
    // "Tandoori Roti / Chapati" → also "Chapati" and "Tandoori Chapati".
    for (const p of parts.slice(1)) { out.add(p); if (!p.includes(' ') && words.length > 1) out.add([...words.slice(0, -1), p].join(' ')); }
  }
  if (/&/.test(base)) out.add(base.replace(/\s*&\s*/g, ' and '));
  return [...out].map(norm).filter((a) => a && a !== norm(name));
}

// lines: [{ text, size? }] in reading order. Returns { title, currency, sections, rows }.
export function parseMenu(lines) {
  const clean = lines
    .map((l) => ({ ...l, text: l.text.replace(/ /g, ' ').replace(/[ ]{2,}(?=\S)/g, (m) => (m.length > 3 ? '\t' : ' ')).trim() }))
    .filter((l) => l.text && !/^(page\s*)?\d{1,3}(\s*(of|\/)\s*\d{1,3})?$/i.test(l.text));
  const parsed = clean.map((l) => ({ ...l, price: readPrice(l.text) }));
  // A price alone on its line belongs to the name just above it.
  for (let i = 1; i < parsed.length; i++) {
    const l = parsed[i];
    if (l.price && !l.price.name && !parsed[i - 1].price && isHeadingText(parsed[i - 1].text)) {
      parsed[i - 1].price = { ...l.price, name: parsed[i - 1].text };
      l.skip = true;
    }
  }
  const dishes = parsed.filter((l) => l.price && l.price.name && !l.skip);
  const sizes = dishes.map((l) => l.size).filter(Boolean).sort((a, b) => a - b);
  const dishSize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : null;

  const counts = {};
  for (const d of dishes) if (d.price.currency) counts[d.price.currency] = (counts[d.price.currency] || 0) + 1;
  const currency = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;

  const rows = [];
  const sections = [];
  let section = null;
  let title = null;
  let last = null; // the dish a following plain line may describe
  const isDishAt = (j) => { const n = parsed.slice(j).find((x) => !x.skip); return !!(n && n.price && n.price.name); };
  for (let i = 0; i < parsed.length; i++) {
    const l = parsed[i];
    if (l.skip) continue;
    if (l.price && l.price.name) {
      const p = l.price;
      const name = p.name.replace(/\s+/g, ' ').replace(/^[•*\-–\d.)\s]+(?=[A-Za-z])/, '').trim();
      if (name.length < 2 || name.length > 80) { last = null; continue; }
      const sym = p.currency || currency;
      last = {
        name, desc: '', price: p.low, section: section && section.id,
        priceNote: p.high && p.high !== p.low ? `The menu shows ${sym ? sym + ' ' : ''}${p.low.toFixed(2)} – ${p.high.toFixed(2)}. Check the price, or add each size as its own dish.` : '',
        aliases: aliasesFor(name),
      };
      rows.push(last);
      continue;
    }
    const t = l.text.replace(/:$/, '').trim();
    const bigger = dishSize && l.size && l.size > dishSize * 1.15;
    const caps = /[A-Z]/.test(t) && t === t.toUpperCase();
    const stands = bigger || caps || /:$/.test(l.text) || (!dishSize && t.split(/\s+/).length <= 3);
    if (isHeadingText(t) && stands && isDishAt(i + 1) && !(last && !bigger && !caps && !/:$/.test(l.text) && t.split(/\s+/).length > 3)) {
      const label = titleCase(t);
      section = sections.find((s) => s.label === label) || { id: sectionId(label), label };
      if (!sections.includes(section)) sections.push(section);
      last = null;
      continue;
    }
    if (last && !caps && !bigger && t.length <= 200 && !/subject to change|inclusive of|exclusive of|vat|service charge|www\.|https?:/i.test(t)) {
      last.desc = (last.desc ? last.desc + ' ' : '') + t;
      continue;
    }
    if (!rows.length && !title && (bigger || caps || !dishSize)) title = titleCase(t);
    last = null;
  }

  const builtIn = new Set(CATEGORIES.map((c) => c.id));
  return {
    title,
    currency,
    sections: sections.filter((s) => !builtIn.has(s.id)),
    rows: rows.map((r) => {
      const tags = inferTags(r.name, r.desc);
      return { ...r, ...tags, category: r.section || tags.category, desc: r.desc.slice(0, 200), conf: r.priceNote ? 0.7 : r.section ? 0.95 : 0.85 };
    }),
  };
}

export const parseMenuText = (text) => parseMenu(text.split(/\r?\n/).map((t) => ({ text: t.replace(/\t+/g, '\t') })));

// pages: [{ width, items: [{ str, x, y, h, w }] }] from PDF.js (y grows upwards). Builds text lines in
// reading order, keeping a tab where a wide gap separates a name from its price, and reading a
// two-column page left column first.
export function linesFromPdf(pages) {
  const out = [];
  for (const page of pages) {
    const items = page.items.filter((it) => it.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of items) {
      const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, Math.min(r.h, it.h) * 0.5));
      if (row) { row.items.push(it); row.h = Math.max(row.h, it.h); } else rows.push({ y: it.y, h: it.h, items: [it] });
    }
    const chunks = [];
    for (const row of rows) {
      const its = row.items.sort((a, b) => a.x - b.x);
      let cur = null;
      for (const it of its) {
        const gap = cur ? it.x - cur.end : 0;
        // A wide gap after a price, or a very wide one before something that isn't a price, starts a
        // new chunk: the next column of a two-column menu.
        if (cur && gap > it.h * 2 && (readPrice(cur.text) || (gap > it.h * 6 && !readPrice(it.str)))) { chunks.push(cur); cur = null; }
        if (!cur) cur = { text: it.str.trim(), x: it.x, y: row.y, end: it.x + it.w, sizes: [it.h] };
        else { cur.text += (gap > it.h * 1.5 ? '\t' : gap > it.h * 0.15 || /\s$/.test(cur.text) ? ' ' : '') + it.str.trim(); cur.end = it.x + it.w; cur.sizes.push(it.h); }
      }
      if (cur) chunks.push(cur);
    }
    // Text size of a line: its name's, not its price's.
    for (const c of chunks) c.size = Math.round(Math.min(...c.sizes) * 10) / 10;
    const mid = page.width / 2;
    const priced = chunks.filter((c) => readPrice(c.text));
    const twoColumns = priced.filter((c) => c.x > mid * 0.9).length >= 3 && priced.filter((c) => c.x < mid * 0.5).length >= 3;
    const ordered = twoColumns
      ? [...chunks.filter((c) => c.x < mid * 0.9), ...chunks.filter((c) => c.x >= mid * 0.9)]
      : chunks;
    for (const c of ordered) out.push({ text: c.text, size: c.size });
  }
  return out;
}
