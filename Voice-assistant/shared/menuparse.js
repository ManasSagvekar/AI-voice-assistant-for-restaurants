// Menu import: turns the text of a menu (a PDF's text layer, or a .txt/.csv price list) into dishes
// grouped by the menu's own sections, with the menu's currency. Runs in the staff browser; the same
// code is unit-tested in Node.
//
// A line with a price at its end is a dish. A short line without a price that is followed by dishes
// and stands out (capitals, a larger font, or a trailing colon) is a section heading. A plain line
// right after a dish is that dish's description. Anything else (the restaurant's name, its address,
// "prices subject to change") is skipped.
//
// Sizes: "Biryani  Half 120 / Full 220" names them on the line. "Biryani  120  220" under a heading
// that lists "Half  Full" takes the names from the heading. A plain range ("AED 31.00 – 38.00") doesn't
// say what the prices are for, so it is left for staff to decide on the review screen.
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
const CURRENCY_WORD = new RegExp(String.raw`^${CUR}$`, 'i');
const toNum = (s) => parseFloat(s.replace(',', '.'));

function readPrice(text) {
  const m = text.match(PRICE);
  if (!m) return null;
  let name = text.slice(0, m.index).replace(/[\s.·…_\-–—|:,]+$/, '').trim();
  let cur = m[2] || m[5] || '';
  // A bare number counts only when something separates it from the name ("Chicken 65" is a name).
  const separated = cur || /\./.test(m[3]) || m[1] === '\t' || /\S/.test(m[1]) || m[1].length > 1 || !name;
  if (!separated) return null;
  let low = toNum(m[3]);
  let high = m[4] ? toNum(m[4]) : null;
  // "Curries AED 15.00 35.00": a price right before the price is a range whose dash got lost.
  const before = !high && name.match(new RegExp(String.raw`\s(${CUR}\s?)(${NUM})$`, 'i'));
  if (before && toNum(before[2]) < low) {
    high = low; low = toNum(before[2]); cur = cur || before[1];
    name = name.slice(0, before.index).replace(/[\s.·…_\-–—|:,]+$/, '').trim();
  }
  if (!(low > 0)) return null;
  return { name, low, high, currency: cur ? codeOf(cur) : null, raw: text.slice(m.index).trim() };
}

// Words that name a size on a menu.
const SIZE_WORD = String.raw`half|full|quarter|qtr|small|medium|large|regular|reg|single|double|mini|family|glass|bottle|pint|jug`;
const sizeName = (w) => { const t = w.replace(/\.$/, '').toLowerCase(); return { qtr: 'Quarter', reg: 'Regular' }[t] || t[0].toUpperCase() + t.slice(1); };
const LABELLED = new RegExp(String.raw`\b(${SIZE_WORD})\b\.?\s*[:\-–]?\s*(${CUR}\s?)?(${NUM})(?:\s*\/-)?`, 'gi');
// "Half 120 / Full 220" at the end of a dish line.
function readLabelledSizes(text) {
  const found = [...text.matchAll(LABELLED)];
  if (found.length < 2) return null;
  const end = found[found.length - 1];
  if (text.slice(end.index + end[0].length).replace(/[\s,;|/.]+/g, '')) return null;
  const name = text.slice(0, found[0].index).replace(/[\s.·…_\-–—|:,(]+$/, '').trim();
  if (!name) return null;
  const sizes = found.map((m) => ({ label: sizeName(m[1]), price: toNum(m[3]) }));
  const cur = found.find((m) => m[2]);
  return { name, sizes, low: Math.min(...sizes.map((x) => x.price)), high: null, currency: cur ? codeOf(cur[2]) : null };
}
// A heading's size columns: "BIRYANI   Half   Full", or just "Half   Full" on its own line.
const COLUMN_WORDS = new RegExp(String.raw`(?:^|\s{2,}|\t|\s)((?:(?:${SIZE_WORD})\.?(?:\s+|\t|\s*/\s*)){1,5}(?:${SIZE_WORD})\.?)\s*$`, 'i');
function readColumns(text) {
  const m = text.match(COLUMN_WORDS);
  if (!m) return null;
  return { heading: text.slice(0, m.index).trim(), labels: m[1].split(/[\s/]+/).filter(Boolean).map(sizeName) };
}
// "Biryani   120   220": as many prices as there are columns, or two clearly separated ones.
function readColumnPrices(text, labels) {
  const tokens = String.raw`((?:${CUR}\s?)?${NUM}(?:\s*\/-)?)`;
  const count = labels ? labels.length : 2;
  const gap = labels ? String.raw`(?:\s+|\t|\s*/\s*)` : String.raw`(?:\s{2,}|\t|\s*/\s*)`;
  const m = text.match(new RegExp(String.raw`^(.*?\S)${labels ? String.raw`\s+` : String.raw`(?:\s{2,}|\t)`}${Array(count).fill(tokens).join(gap)}\s*$`, 'i'));
  if (!m || !/[a-z]{2}/i.test(m[1])) return null;
  const parts = m.slice(2, 2 + count);
  const prices = parts.map((v) => toNum(v.replace(new RegExp(CUR, 'i'), '').replace(/\/-/, '').trim()));
  if (prices.some((n) => !(n > 0))) return null;
  const names = labels || (count === 2 ? ['Half', 'Full'] : []);
  const cur = parts.map((v) => v.match(new RegExp(CUR, 'i'))).find(Boolean);
  return {
    name: m[1].replace(/[\s.·…_\-–—|:,]+$/, '').trim(), sizes: prices.map((price, i) => ({ label: names[i], price })), guessed: !labels,
    low: Math.min(...prices), high: null, currency: cur ? codeOf(cur[0]) : null,
  };
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
  // Size columns apply from the heading that lists them until the next section.
  let columns = null;
  const parsed = clean.map((l) => {
    const c = readColumns(l.text);
    if (c && !readPrice(l.text)) {
      columns = c.labels;
      if (!c.heading) return { ...l, skip: true };
      return { ...l, text: c.heading, price: null, columnsStart: true };
    }
    const sized = readLabelledSizes(l.text) || readColumnPrices(l.text, columns);
    const price = sized || readPrice(l.text);
    if (!price && !l.size && !/\d/.test(l.text) && /^[A-Z\s&]+$/.test(l.text)) columns = null;
    return { ...l, price };
  });
  // A price alone on its line belongs to the name just above it.
  for (let i = 1; i < parsed.length; i++) {
    const l = parsed[i];
    if (l.price && !l.price.name && !parsed[i - 1].skip && !parsed[i - 1].price && isHeadingText(parsed[i - 1].text)) {
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
      // "AED 31.00" isn't a dish: a misread price can look like a name followed by a price.
      if (name.length < 2 || name.length > 80 || !/[a-z]{2}/i.test(name.replace(new RegExp(CUR, 'gi'), ''))) { last = null; continue; }
      const sym = p.currency || currency;
      last = {
        name, desc: '', price: p.low, section: section && section.id,
        priceNote: p.high && p.high !== p.low ? `The menu shows ${sym ? sym + ' ' : ''}${p.low.toFixed(2)} – ${p.high.toFixed(2)}. Are these sizes, or one price?`
          : p.guessed ? 'The menu lists two prices without naming them, so these size names are a guess. Please check them.' : '',
        ...(p.high && p.high !== p.low ? { priceRange: [p.low, p.high] } : {}),
        ...(p.sizes ? { sizes: p.sizes } : {}),
        aliases: aliasesFor(name),
        ...(l.conf !== undefined ? { read: l.conf, plain: !/[.,]\d{1,2}\b/.test(p.raw || '') } : {}),
      };
      rows.push(last);
      continue;
    }
    const t = l.text.replace(/:$/, '').replace(/\s+/g, ' ').trim();
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

  // From a picture: when the menu writes prices like 32.00, a "4000" is 40.00 with its dot lost.
  const fromPicture = rows.filter((r) => r.read !== undefined);
  if (fromPicture.length >= 3 && fromPicture.filter((r) => !r.plain).length >= fromPicture.length / 2) {
    for (const r of fromPicture) {
      if (r.plain && !r.sizes && r.price >= 100) { r.price /= 100; r.read = Math.min(r.read, 50); r.fixedDot = true; }
    }
  }
  // Correct readings of a picture scored 85 or more in testing; most wrong ones scored less.
  const hard = fromPicture.filter((r) => r.read < 85).length;
  const builtIn = new Set(CATEGORIES.map((c) => c.id));
  return {
    title,
    currency,
    hardToRead: fromPicture.length > 0 && hard / fromPicture.length >= 0.4,
    sections: sections.filter((s) => !builtIn.has(s.id)),
    rows: rows.map((r) => {
      const tags = inferTags(r.name, r.desc);
      const conf = r.priceNote ? 0.7 : r.section ? 0.95 : 0.85;
      // How sure the reader of a picture was of this line's weakest word.
      const blurry = r.read !== undefined && r.read < 85;
      return { ...r, ...tags, category: r.section || tags.category, desc: r.desc.slice(0, 200), conf: r.read === undefined ? conf : Math.min(conf, r.read / 100),
        priceNote: r.priceNote || (r.fixedDot ? `Read as ${r.price * 100}, taken to be ${r.price.toFixed(2)}. Please check the price.` : blurry ? 'Hard to read on the picture. Please check the name and price.' : '') };
    }),
  };
}

export const parseMenuText = (text) => parseMenu(text.split(/\r?\n/).map((t) => ({ text: t.replace(/\t+/g, '\t') })));

// Words read from a picture, as the page format linesFromPdf takes. lines: Tesseract's text lines
// ([{ bbox, words: [{ text, confidence, bbox }] }], y grows downwards). Leader dots and specks are
// dropped, and letters misread inside a number are corrected ("2O.00" is 20.00).
const NOISE = /^[^a-z0-9$€£₹&/+]+$/i;
const DASH = /^[-–—]$/;
const fixNumber = (t) => (/\d/.test(t) && /^[$€£₹]?[\dOoIlSs.,/\-–]+$/.test(t) ? t.replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(/[Ss]/g, '5') : t);
export function pageFromOcr(lines, width, height) {
  const items = [];
  for (const line of lines) {
    const h = line.bbox.y1 - line.bbox.y0;
    const words = line.words || [];
    words.forEach((w, i) => {
      const str = fixNumber((w.text || '').trim());
      if (!str) return;
      // A dash only means something between two prices: "31.00 – 38.00".
      const between = DASH.test(str) && /\d/.test((words[i - 1] || {}).text || '') && /\d/.test((words[i + 1] || {}).text || '');
      if (NOISE.test(str) && !between) return;
      if (w.confidence < 25 && str.length <= 2 && !/\d/.test(str) && !between && !/^[&/+]$/.test(str)) return; // specks read as letters
      items.push({ str, x: w.bbox.x0, y: height - line.bbox.y1, h, w: w.bbox.x1 - w.bbox.x0, conf: between ? 100 : w.confidence, word: true });
    });
  }
  return { width, items };
}

// pages: [{ width, items: [{ str, x, y, h, w, conf? }] }] from PDF.js (y grows upwards). Builds text lines in
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
        if (cur && gap > it.h * 2 && (readPrice(cur.text) || (gap > it.h * 6 && !readPrice(it.str) && !CURRENCY_WORD.test(it.str)))) { chunks.push(cur); cur = null; }
        if (!cur) cur = { text: it.str.trim(), x: it.x, y: row.y, end: it.x + it.w, sizes: [it.h], conf: it.conf ?? 100 };
        else { cur.conf = Math.min(cur.conf, it.conf ?? 100); cur.text += (gap > it.h * 1.5 ? '\t' : it.word || gap > it.h * 0.15 || /\s$/.test(cur.text) ? ' ' : '') + it.str.trim(); cur.end = it.x + it.w; cur.sizes.push(it.h); }
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
    for (const c of ordered) out.push({ text: c.text, size: c.size, ...(c.conf < 100 ? { conf: c.conf } : {}) });
  }
  return out;
}
