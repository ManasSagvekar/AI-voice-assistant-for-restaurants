// Server-side assistant pipeline: rate limit -> speech safety parse -> guardrail -> intent parse
// -> strict schema validation -> execution against the database. The browser only captures speech.
//
// Sending an order is a two-step conversation: "send my order" reads the order back (after offering
// the owner's chosen pairing once), and only a "yes" sends it. Allergy questions are answered only
// from allergen lists the kitchen has confirmed; anything else fetches a member of staff.
import {
  RATE_LIMIT, RATE_WINDOW, EMPTY_FILTERS, MODIFIERS, UNDO_MS, fmt, totals, priceLine, matchesFilters, describeFilters,
  guardrail, sanitizeTranscript, parseIntent, validateCall, confirmWord, findItems, norm, upsellFor, allergenLabel, hasSizes, sizeIn, withSize, cheapestSize,
} from '../shared/engine.js';
import { reply, dishName, allergenName } from '../shared/i18n.js';

const joinWords = (a, and = 'and') => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ` ${and} ` + a[a.length - 1]);
const AND = { en: 'and', hi: 'और', mr: 'आणि' };
const OR = { en: 'or', hi: 'या', mr: 'किंवा' };
const PENDING_MS = 2 * 60e3;

export function createAssistant(store) {
  const stamps = new Map(); // table -> command timestamps (per table session)
  const pending = new Map(); // table -> { type: 'confirm' | 'upsell' | 'size', itemId?, queue?, cartKey, at }
  const offered = new Set(); // tables already offered a pairing for the current order

  function usage(table) {
    const t = Date.now();
    const list = (stamps.get(table) || []).filter((s) => t - s < RATE_WINDOW);
    stamps.set(table, list);
    return { used: list.length, limit: RATE_LIMIT, resetsAt: list.length ? list[0] + RATE_WINDOW : null };
  }
  // Called whenever an order is sent or the table is reset, by any route.
  const forget = (table) => { pending.delete(table); offered.delete(table); };
  // Called when this computer switches restaurant.
  const reset = () => { stamps.clear(); pending.clear(); offered.clear(); };

  const cartKey = (table) => JSON.stringify(store.cart(table).map((l) => [l.itemId, l.qty, l.mods, l.size]));

  // A dish that comes in sizes waits for the guest to pick one; several wait their turn.
  function askSize(table, menu, lang, queue) {
    const next = queue[0];
    const item = menu.find((m) => m.id === next.itemId);
    pending.set(table, { type: 'size', queue, cartKey: cartKey(table), at: Date.now() });
    return reply(lang, 'askSize', { name: dishName(item, lang), options: joinWords(item.sizes.map((s) => `${s.label} (${fmt(s.price)})`), OR[lang]) });
  }
  function addSized(table, menu, lang, line, size, effects) {
    const item = menu.find((m) => m.id === line.itemId);
    store.addToCart(table, item.id, line.qty, line.mods, size.id);
    effects.openCart = true;
    const price = priceLine(menu, { itemId: item.id, qty: line.qty, mods: line.mods, size: size.id }).total;
    return reply(lang, 'added', { qty: line.qty, name: withSize(dishName(item, lang), item, size.id), mods: line.mods.length ? joinWords(line.mods.map((k) => MODIFIERS[k].label.toLowerCase())) : '', price: fmt(price) });
  }

  function readBack(table, menu, lang) {
    const cart = store.cart(table).filter((l) => (menu.find((m) => m.id === l.itemId) || {}).available);
    const list = joinWords(cart.map((l) => {
      const item = menu.find((m) => m.id === l.itemId);
      return `${l.qty} × ${withSize(dishName(item, lang), item, l.size)}${l.mods.length ? ` (${l.mods.map((k) => MODIFIERS[k].label.toLowerCase()).join(', ')})` : ''}`;
    }), AND[lang]);
    pending.set(table, { type: 'confirm', cartKey: cartKey(table), at: Date.now() });
    return reply(lang, 'readBack', { list, total: fmt(totals(menu, cart).total) });
  }

  // "Send my order": empty → say so; first time with a pairing available → offer it; else read back.
  function startSend(table, menu, lang, effects) {
    if (!store.cart(table).some((l) => (menu.find((m) => m.id === l.itemId) || {}).available)) return reply(lang, 'emptyOrder');
    effects.openConfirm = true;
    const up = !offered.has(table) && upsellFor(menu, store.cart(table));
    if (up) {
      offered.add(table);
      pending.set(table, { type: 'upsell', itemId: up.item.id, cartKey: cartKey(table), at: Date.now() });
      // A suggested dish that comes in sizes is offered in its smallest.
      const small = cheapestSize(up.item);
      return reply(lang, 'upsell', { name: withSize(dishName(up.item, lang), up.item, small && small.id), price: fmt(up.item.price), base: dishName(up.base, lang) });
    }
    return readBack(table, menu, lang);
  }

  function send(table, lang, effects) {
    const orderId = store.placeOrder(table);
    forget(table);
    if (!orderId) return reply(lang, 'emptyOrder');
    effects.orderPlaced = { id: orderId, undoUntil: Date.now() + UNDO_MS };
    return reply(lang, 'orderSent', { id: orderId });
  }

  // A yes/no answer to the question the assistant just asked, if there is one still current.
  function answerPending(table, text, menu, lang, effects) {
    const p = pending.get(table);
    if (!p || Date.now() - p.at > PENDING_MS || p.cartKey !== cartKey(table)) { pending.delete(table); return null; }
    const word = confirmWord(text);
    if (p.type === 'size') {
      const [line, ...rest] = p.queue;
      const item = menu.find((m) => m.id === line.itemId);
      const size = item && sizeIn(item, text);
      if (!size) {
        pending.delete(table);
        return word === 'no' ? reply(lang, 'notAdded', { name: item ? dishName(item, lang) : '' }) : null; // anything else is a new request
      }
      const added = addSized(table, menu, lang, line, size, effects);
      if (!rest.length) { pending.delete(table); return added; }
      return added + ' ' + askSize(table, menu, lang, rest);
    }
    if (!word || findItems(norm(text), menu).length) return null;
    if (p.type === 'upsell') {
      effects.openConfirm = true;
      if (word === 'no') return readBack(table, menu, lang);
      const item = menu.find((m) => m.id === p.itemId);
      if (!item || !item.available) return readBack(table, menu, lang);
      const small = cheapestSize(item);
      store.addToCart(table, item.id, 1, [], small ? small.id : null);
      effects.upsellAdded = item.id;
      return reply(lang, 'upsellAdded', { name: withSize(dishName(item, lang), item, small && small.id) }) + ' ' + readBack(table, menu, lang);
    }
    pending.delete(table);
    if (word === 'no') { effects.closeConfirm = true; return reply(lang, 'notSent'); }
    return send(table, lang, effects);
  }

  function handle(table, rawText, lang = 'en') {
    const u = usage(table);
    const { text, truncated } = sanitizeTranscript(rawText);
    if (!text) return { status: 400, body: { error: 'Say or type a request first.' } };
    if (u.used >= RATE_LIMIT) {
      const retryAfter = Math.ceil((u.resetsAt - Date.now()) / 1000);
      store.logSecurity({ table, type: 'ratelimit', kind: 'rate-limit', input: text, detail: `Throttled for ${retryAfter}s (${RATE_LIMIT}/min limit)` });
      return { status: 429, body: { error: 'rate_limited', retryAfter, usage: u } };
    }
    stamps.get(table).push(Date.now());

    const g = guardrail(text.toLowerCase());
    if (g.blocked) {
      store.logSecurity({ table, type: 'guardrail', kind: g.kind, input: text, detail: 'Blocked at input guardrail' });
      return { status: 200, body: { text: reply(lang, g.kind), tone: 'guard', guard: g.kind, heard: text, truncated, usage: usage(table), effects: {} } };
    }

    const menu = store.menu();
    const effects = {};
    const answered = answerPending(table, text, menu, lang, effects);
    if (answered) return { status: 200, body: { text: answered, heard: text, truncated, inspected: [], effects, usage: usage(table) } };

    const inspected = [];
    const out = [];
    const needSize = []; // dishes in this request that still need a size
    const calls = parseIntent(text, menu);
    const allergyNote = calls.find((c) => c.tool === 'set_instructions' && /^Allergy:/.test(c.args.text));
    for (const call of calls) {
      const v = validateCall(call, menu);
      inspected.push({ tool: call.tool, args: v.args, ok: v.ok, errors: v.errors, stripped: v.stripped });
      if (v.stripped.some((s) => s.money)) {
        store.logSecurity({ table, type: 'schema', kind: 'price-field-stripped', input: text, detail: `Stripped ${v.stripped.filter((s) => s.money).map((s) => `${s.key}=${s.value}`).join(', ')} from ${call.tool}` });
      }
      if (!v.ok) { out.push(reply(lang, 'skipped')); continue; }
      const a = v.args;
      switch (call.tool) {
        case 'apply_filters': {
          const f = { ...EMPTY_FILTERS, ...a };
          effects.filters = f;
          const list = menu.filter((m) => m.available && matchesFilters(m, f)).sort((x, y) => (y.rating || 0) - (x.rating || 0));
          if (allergyNote && f.avoid.length) {
            out.push(reply(lang, 'allergyNoted', { allergen: joinWords(f.avoid.map((k) => allergenName(lang, k, allergenLabel(k))), AND[lang]) }));
            break;
          }
          if (lang === 'en') {
            const desc = describeFilters(f);
            out.push(list.length
              ? `Here ${list.length === 1 ? 'is 1' : 'are ' + list.length} ${desc}. I'd start with the ${list[0].name}${list[0].spicy === 3 ? ', our hottest dish' : ''}.`
              : `I couldn't find any ${desc} tonight. Try removing a filter.`);
          } else out.push(list.length ? reply(lang, 'found', { n: list.length, first: dishName(list[0], lang) }) : reply(lang, 'none'));
          break;
        }
        case 'clear_filters': effects.filters = EMPTY_FILTERS; out.push(reply(lang, 'fullMenu')); break;
        case 'add_to_cart': {
          const item = menu.find((m) => m.id === a.item_id);
          if (!item.available) {
            const alt = menu.find((m) => m.available && m.category === item.category && m.id !== item.id);
            out.push(reply(lang, 'unavailable', { name: dishName(item, lang), alt: alt && dishName(alt, lang) }));
            break;
          }
          if (hasSizes(item) && !a.size) { needSize.push({ itemId: item.id, qty: a.qty, mods: a.modifiers }); break; }
          store.addToCart(table, item.id, a.qty, a.modifiers, a.size || null);
          effects.openCart = true;
          const lineTotal = priceLine(menu, { itemId: item.id, qty: a.qty, mods: a.modifiers, size: a.size }).total;
          const skipped = v.stripped.filter((s) => s.notAllowed).map((s) => s.value.toLowerCase());
          out.push(reply(lang, 'added', { qty: a.qty, name: withSize(dishName(item, lang), item, a.size), mods: a.modifiers.length ? joinWords(a.modifiers.map((k) => MODIFIERS[k].label.toLowerCase())) : '', price: fmt(lineTotal) }));
          if (skipped.length) out.push(reply(lang, 'notForDish', { what: joinWords(skipped) }));
          if (v.stripped.some((s) => s.money)) out.push(reply(lang, 'menuPrice', { price: fmt(item.price) }));
          break;
        }
        case 'remove_from_cart': {
          const item = menu.find((m) => m.id === a.item_id);
          out.push(reply(lang, store.removeItem(table, item.id) ? 'removed' : 'notInOrder', { name: dishName(item, lang) }));
          break;
        }
        case 'describe_item': {
          const i = menu.find((m) => m.id === a.item_id);
          out.push(reply(lang, 'describe', {
            name: dishName(i, lang), desc: i.desc, price: hasSizes(i) ? joinWords(i.sizes.map((s) => `${s.label} ${fmt(s.price)}`), AND[lang]) : fmt(i.price), spicy: i.spicy, available: i.available, checked: !!i.allergensChecked,
            allergens: joinWords(i.allergens.map((k) => allergenName(lang, k, allergenLabel(k))), AND[lang]),
          }));
          break;
        }
        case 'allergen_check': {
          const i = menu.find((m) => m.id === a.item_id);
          const name = dishName(i, lang);
          const allergen = allergenName(lang, a.allergen, allergenLabel(a.allergen));
          if (i.allergensChecked) {
            const has = i.allergens.includes(a.allergen);
            store.logAllergen(table, i.name, a.allergen, has ? 'contains' : 'free');
            out.push(reply(lang, has ? 'contains' : 'freeOf', { name, allergen }));
          } else {
            store.logAllergen(table, i.name, a.allergen, 'unknown');
            store.addRequest(table, 'server', `Allergy question: does the ${i.name} contain ${allergenLabel(a.allergen).toLowerCase()}?`);
            effects.serverCalled = true;
            out.push(reply(lang, 'unknownAllergen', { name }));
          }
          break;
        }
        case 'call_server':
          store.addRequest(table, 'server', 'Requested by voice');
          effects.serverCalled = true;
          out.push(reply(lang, 'serverComing'));
          break;
        case 'request_bill': {
          const total = store.tableOrders(table).reduce((s, o) => s + o.total, 0);
          if (!total) { out.push(reply(lang, 'billFirst')); break; }
          const n = a.split_ways;
          store.addRequest(table, 'bill', `Bill ${fmt(total)}${n > 1 ? ` · split ${n} ways (${fmt(total / n)} each)` : ''}`, n);
          out.push(reply(lang, 'billAsked', { total: fmt(total), n, each: fmt(total / n) }));
          break;
        }
        case 'place_order': out.push(startSend(table, menu, lang, effects)); break;
        case 'cancel_order': {
          const last = store.latestOrder(table);
          if (!last) { out.push(reply(lang, 'nothingToCancel')); break; }
          const r = store.cancelOrder(table, last.id, UNDO_MS);
          if (r.ok) { effects.orderCancelled = last.id; effects.openCart = true; out.push(reply(lang, 'cancelled', { id: last.id })); }
          else {
            store.addRequest(table, 'server', `Guest asked to cancel order ${last.id}`);
            effects.serverCalled = true;
            out.push(reply(lang, 'tooLate'));
          }
          break;
        }
        case 'open_cart': {
          effects.openCart = true;
          const cart = store.cart(table);
          const t = totals(menu, cart);
          out.push(cart.length ? reply(lang, 'cartSummary', { n: cart.reduce((s, l) => s + l.qty, 0), total: fmt(t.total) }) : reply(lang, 'cartEmpty'));
          break;
        }
        case 'set_instructions': {
          const current = store.note(table);
          store.setNote(table, (current ? current + '; ' : '') + a.text);
          // "I'm allergic to …" is answered by the filter it also applies.
          if (!(allergyNote === call && calls.some((c) => c.tool === 'apply_filters'))) out.push(reply(lang, 'noted', { text: a.text }));
          break;
        }
        default:
          out.push(reply(lang, 'fallback'));
      }
    }
    if (needSize.length) out.push(askSize(table, menu, lang, needSize));
    return { status: 200, body: { text: out.join(' '), heard: text, truncated, inspected: inspected[0] && inspected[0].tool === 'fallback' ? [] : inspected, effects, usage: usage(table) } };
  }

  return { handle, usage, forget, reset };
}
