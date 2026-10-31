// Server-side assistant pipeline: rate limit -> speech safety parse -> guardrail -> intent parse
// -> strict schema validation -> execution against the database. The browser only captures speech.
import {
  RATE_LIMIT, RATE_WINDOW, EMPTY_FILTERS, MODIFIERS, fmt, totals, priceLine, matchesFilters, describeFilters,
  guardrail, REFUSALS, sanitizeTranscript, parseIntent, validateCall,
} from '../shared/engine.js';

const joinWords = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);

export function createAssistant(store) {
  const stamps = new Map(); // table -> command timestamps (per table session)

  function usage(table) {
    const t = Date.now();
    const list = (stamps.get(table) || []).filter((s) => t - s < RATE_WINDOW);
    stamps.set(table, list);
    return { used: list.length, limit: RATE_LIMIT, resetsAt: list.length ? list[0] + RATE_WINDOW : null };
  }
  const resetUsage = (table) => stamps.delete(table);

  function handle(table, rawText) {
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
      return { status: 200, body: { text: REFUSALS[g.kind], tone: 'guard', guard: g.kind, heard: text, truncated, usage: usage(table), effects: {} } };
    }

    const menu = store.menu();
    const effects = {};
    const inspected = [];
    const out = [];
    for (const call of parseIntent(text, menu)) {
      const v = validateCall(call, menu);
      inspected.push({ tool: call.tool, args: v.args, ok: v.ok, errors: v.errors, stripped: v.stripped });
      if (v.stripped.some((s) => s.money)) {
        store.logSecurity({ table, type: 'schema', kind: 'price-field-stripped', input: text, detail: `Stripped ${v.stripped.filter((s) => s.money).map((s) => `${s.key}=${s.value}`).join(', ')} from ${call.tool}` });
      }
      if (!v.ok) { out.push("I couldn't process part of that request safely, so I've skipped it."); continue; }
      const a = v.args;
      switch (call.tool) {
        case 'apply_filters': {
          const f = { ...EMPTY_FILTERS, ...a };
          effects.filters = f;
          const list = menu.filter((m) => m.available && matchesFilters(m, f)).sort((x, y) => (y.rating || 0) - (x.rating || 0));
          const desc = describeFilters(f);
          out.push(list.length
            ? `Here ${list.length === 1 ? 'is 1' : 'are ' + list.length} ${desc}. I'd start with the ${list[0].name}${list[0].spicy === 3 ? ', our hottest dish' : ''}.`
            : `I couldn't find any ${desc} tonight. Try removing a filter.`);
          break;
        }
        case 'clear_filters': effects.filters = EMPTY_FILTERS; out.push("Here's the full menu."); break;
        case 'add_to_cart': {
          const item = menu.find((m) => m.id === a.item_id);
          if (!item.available) {
            const alt = menu.find((m) => m.available && m.category === item.category && m.id !== item.id);
            out.push(`I'm sorry, the ${item.name} is unavailable tonight.${alt ? ` May I suggest the ${alt.name}?` : ''}`);
            break;
          }
          store.addToCart(table, item.id, a.qty, a.modifiers);
          effects.openCart = true;
          const lineTotal = priceLine(menu, { itemId: item.id, qty: a.qty, mods: a.modifiers }).total;
          const skipped = v.stripped.filter((s) => s.notAllowed).map((s) => s.value.toLowerCase());
          out.push(`Added ${a.qty > 1 ? a.qty + ' × ' : ''}${item.name}${a.modifiers.length ? ' with ' + joinWords(a.modifiers.map((k) => MODIFIERS[k].label.toLowerCase())) : ''} (${fmt(lineTotal)}).${skipped.length ? ` ${joinWords(skipped)} isn't available for this dish.` : ''}`);
          if (v.stripped.some((s) => s.money)) out.push(`It's charged at the menu price of ${fmt(item.price)}; prices can't be changed by request.`);
          break;
        }
        case 'remove_from_cart': {
          const item = menu.find((m) => m.id === a.item_id);
          out.push(store.removeItem(table, item.id) ? `Removed the ${item.name} from your order.` : `There's no ${item.name} in your order.`);
          break;
        }
        case 'describe_item': {
          const i = menu.find((m) => m.id === a.item_id);
          out.push(`The ${i.name}: ${i.desc}. It's ${fmt(i.price)}${i.spicy ? `, spice level ${i.spicy} of 3` : ', not spicy'}${i.allergens.length ? `, and contains ${joinWords(i.allergens)}` : ''}.${i.available ? '' : ' It is unavailable tonight.'}`);
          break;
        }
        case 'call_server':
          store.addRequest(table, 'server', 'Requested by voice');
          effects.serverCalled = true;
          out.push('Of course. A server is on the way to your table.');
          break;
        case 'request_bill': {
          const total = store.tableOrders(table).reduce((s, o) => s + o.total, 0);
          if (!total) { out.push("Let's send your order to the kitchen first. Then I can request the bill."); break; }
          const n = a.split_ways;
          store.addRequest(table, 'bill', `Bill ${fmt(total)}${n > 1 ? ` · split ${n} ways (${fmt(total / n)} each)` : ''}`, n);
          out.push(`I've asked for your bill of ${fmt(total)}${n > 1 ? `, split ${n} ways at ${fmt(total / n)} each` : ''}.`);
          break;
        }
        case 'place_order': {
          const orderId = store.placeOrder(table);
          out.push(orderId ? `Your order ${orderId} is with the kitchen. I'll keep you posted.` : 'Your order is empty. What would you like?');
          break;
        }
        case 'open_cart': {
          effects.openCart = true;
          const cart = store.cart(table);
          const t = totals(menu, cart);
          out.push(cart.length ? `You have ${cart.reduce((s, l) => s + l.qty, 0)} items, ${fmt(t.total)} including tax.` : 'Your order is empty so far.');
          break;
        }
        case 'set_instructions': {
          const current = store.note(table);
          store.setNote(table, (current ? current + '; ' : '') + a.text);
          out.push(`I've noted "${a.text}" for the kitchen.`);
          break;
        }
        default:
          out.push('I can help with the menu, your order and table service. Try "show me vegan desserts" or "add a tiramisu".');
      }
    }
    return { status: 200, body: { text: out.join(' '), heard: text, truncated, inspected: inspected[0] && inspected[0].tool === 'fallback' ? [] : inspected, effects, usage: usage(table) } };
  }

  return { handle, usage, resetUsage };
}
