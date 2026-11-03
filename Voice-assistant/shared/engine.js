// Flavoria "backend" engine: menu data, pricing, guardrails, intent parser, schema validator.
// Everything here is pure so it can move server-side unchanged.

export const TAX_RATE = 0.08875;
export const IDLE_LIMIT = 90;          // seconds of inactivity before a session resets
export const WARN_AT = 30;             // seconds remaining when the "still there?" alert fires
export const MAX_TURN_MS = 12000;      // max length of a single speech turn
export const LONG_TURN_MS = 18000;     // ...when the guest picks "Take your time"
const MAX_TURN_CHARS = 240;     // ~18s of unhurried speech
export const RATE_LIMIT = 6;           // voice commands...
export const RATE_WINDOW = 60000;      // ...per minute per table session
export const UNDO_MS = 60000;          // a guest can take an order back this long after sending it

// Allergens staff can mark on a dish. The assistant answers allergy questions only for dishes whose
// list the kitchen has confirmed (item.allergensChecked); otherwise it fetches a member of staff.
export const ALLERGENS = {
  gluten: { label: 'Gluten', re: /\b(gluten|wheat|celiac|coeliac)\b/ },
  dairy: { label: 'Dairy', re: /\b(dairy|milk|lactose)\b/ },
  egg: { label: 'Egg', re: /\beggs?\b/ },
  nuts: { label: 'Tree nuts', re: /\b(nuts?|tree nuts?|almonds?|cashews?|walnuts?|pistachios?|hazelnuts?|pecans?)\b/ },
  peanuts: { label: 'Peanuts', re: /\b(peanuts?|groundnuts?)\b/ },
  soy: { label: 'Soy', re: /\b(soy|soya)\b/ },
  sesame: { label: 'Sesame', re: /\bsesame\b/ },
  fish: { label: 'Fish', re: /\bfish\b/ },
  shellfish: { label: 'Shellfish', re: /\b(shellfish|shrimps?|prawns?|crabs?|lobsters?|crustaceans?)\b/ },
  molluscs: { label: 'Molluscs', re: /\b(molluscs?|mollusks?|squid|calamari|mussels?|clams?|oysters?|octopus)\b/ },
  mustard: { label: 'Mustard', re: /\bmustard\b/ },
  celery: { label: 'Celery', re: /\bcelery\b/ },
  sulphites: { label: 'Sulphites', re: /\b(sulphites?|sulfites?)\b/ },
  coconut: { label: 'Coconut', re: /\bcoconuts?\b/ },
};
export const ALLERGEN_KEYS = Object.keys(ALLERGENS);
export const allergenLabel = (k) => (ALLERGENS[k] ? ALLERGENS[k].label : k);
const allergensIn = (t) => ALLERGEN_KEYS.filter((k) => ALLERGENS[k].re.test(t));

// The restaurant's currency and its own menu sections (from an imported menu). The server sets them
// for the restaurant in use; tablets and staff screens from each live snapshot.
export const CURRENCIES = { USD: '$', AED: 'AED ', INR: '₹', EUR: '€', GBP: '£', SAR: 'SAR ', QAR: 'QAR ', KWD: 'KWD ', OMR: 'OMR ', BHD: 'BHD ', SGD: 'S$', MYR: 'RM ', PKR: 'Rs ' };
const menuMeta = { currency: 'USD', sections: [] };
export function setMenuMeta({ currency, sections } = {}) {
  if (CURRENCIES[currency]) menuMeta.currency = currency;
  if (Array.isArray(sections)) menuMeta.sections = sections;
}
export const currency = () => menuMeta.currency;
export const fmt = (n) => CURRENCIES[menuMeta.currency] + (Math.round(n * 100) / 100).toFixed(2);

const U = (id) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=640&q=70`;

export const CATEGORIES = [
  { id: 'all', label: 'All Dishes' },
  { id: 'starters', label: 'Starters' },
  { id: 'mains', label: 'Main Course' },
  { id: 'pizza', label: 'Pizza' },
  { id: 'desserts', label: 'Desserts' },
  { id: 'beverages', label: 'Beverages' },
  { id: 'specials', label: 'Chef Specials' },
];
export const catLabel = (id) => (menuMeta.sections.find((c) => c.id === id) || CATEGORIES.find((c) => c.id === id) || {}).label || id;
const BUILT_IN_CATS = CATEGORIES.map((c) => c.id).filter((c) => c !== 'all' && c !== 'specials');
const isCategory = (id) => BUILT_IN_CATS.includes(id) || menuMeta.sections.some((c) => c.id === id);
// The tablet's category rail: All, chef specials when there are any, then each category the menu
// uses, in menu order (an imported menu keeps its own sections and their order).
export function menuCategories(menu) {
  const used = [];
  for (const m of menu) if (!used.includes(m.category)) used.push(m.category);
  return [
    { id: 'all', label: catLabel('all') },
    ...(menu.some((m) => m.chefSpecial) ? [{ id: 'specials', label: catLabel('specials') }] : []),
    ...used.map((id) => ({ id, label: catLabel(id) })),
  ];
}

// Modifier catalogue. Surcharges live here, server-side, never in user text.
export const MODIFIERS = {
  extra_cheese: { label: 'Extra cheese', price: 2.5, re: /\b(extra|more|double) (cheese|parmesan|parm)\b/ },
  truffle: { label: 'Shaved truffle', price: 6, re: /\b(shaved truffle|truffle shavings?|extra truffle|add truffle)\b/ },
  add_avocado: { label: 'Add avocado', price: 3, re: /\b(add|extra|with) avocado\b/ },
  add_chicken: { label: 'Add grilled chicken', price: 6, re: /\b(add|with|extra) chicken\b/ },
  add_prawns: { label: 'Add prawns', price: 8, re: /\b(add|with|extra) (shrimp|prawns?)\b/ },
  gf_base: { label: 'Gluten-free base', price: 3, re: /\bgluten[- ]?free (base|crust|pasta|bread|bun)\b/ },
  extra_shot: { label: 'Extra shot', price: 1.25, re: /\b(extra|double) shot\b/ },
  oat_milk: { label: 'Oat milk', price: 0.75, re: /\boat milk\b/ },
  no_garlic: { label: 'No garlic', price: 0, re: /\b(no|without|hold the) garlic\b/ },
  no_onion: { label: 'No onion', price: 0, re: /\b(no|without|hold the) onions?\b/ },
  no_nuts: { label: 'No nuts', price: 0, re: /\b(no nuts|nut[- ]free|without nuts)\b/ },
  dairy_free: { label: 'Dairy-free', price: 0, re: /\b(dairy[- ]free|no dairy|without dairy)\b/ },
  extra_spicy: { label: 'Extra spicy', price: 0, re: /\b(extra spicy|spicier|extra hot|make it (hot|spicy))\b/ },
  mild: { label: 'Make it mild', price: 0, re: /\b(mild|less spicy|not (too )?spicy)\b/ },
  sauce_side: { label: 'Sauce on the side', price: 0, re: /\b(sauce|dressing) on (the )?side\b/ },
  medium_rare: { label: 'Medium rare', price: 0, re: /\bmedium[- ]rare\b/ },
  medium: { label: 'Medium', price: 0, re: /\bmedium\b(?![- ]rare)/ },
  well_done: { label: 'Well done', price: 0, re: /\bwell[- ]done\b/ },
  no_ice: { label: 'No ice', price: 0, re: /\b(no|without) ice\b/ },
  less_sugar: { label: 'Less sugar', price: 0, re: /\b(less sugar|less sweet|no sugar)\b/ },
};

// Which modifiers each category accepts (the tool schema's allow-list).
const CATEGORY_MODS = {
  starters: ['no_garlic', 'no_onion', 'dairy_free', 'extra_spicy', 'mild', 'sauce_side', 'add_avocado'],
  mains: ['extra_cheese', 'truffle', 'add_avocado', 'add_chicken', 'add_prawns', 'gf_base', 'no_garlic', 'no_onion', 'dairy_free', 'extra_spicy', 'mild', 'sauce_side'],
  pizza: ['extra_cheese', 'truffle', 'gf_base', 'no_garlic', 'no_onion', 'extra_spicy', 'mild'],
  desserts: ['no_nuts', 'dairy_free'],
  beverages: ['no_ice', 'less_sugar', 'oat_milk', 'extra_shot'],
};
export const allowedMods = (item) =>
  (CATEGORY_MODS[item.category] || []).concat(item.doneness ? ['medium_rare', 'medium', 'well_done'] : []);

const ALL_MEALS = ['breakfast', 'lunch', 'dinner'];
const LD = ['lunch', 'dinner'];

export const SEED_MENU = [
  { id: 'burrata', name: 'Burrata & Heirloom Tomato', desc: 'Pugliese burrata, heirloom tomatoes, basil oil, aged balsamic', category: 'starters', price: 16, rating: 4.8, reviews: 214, diet: 'veg', vegan: false, gf: true, spicy: 0, meals: LD, allergens: ['dairy'], prep: 8, img: U('1608897013039-887f21d8c804'), aliases: ['burrata'] },
  { id: 'bruschetta', name: 'Wild Mushroom Bruschetta', desc: 'Grilled sourdough, roasted chanterelles, thyme, garlic confit', category: 'starters', price: 13, rating: 4.6, reviews: 158, diet: 'veg', vegan: true, gf: false, spicy: 0, meals: LD, allergens: ['gluten'], prep: 7, img: U('1572695157366-5e585ab2b69f'), aliases: ['bruschetta', 'mushroom bruschetta'] },
  { id: 'tartare', name: 'Yellowfin Tuna Tartare', desc: 'Avocado mousse, yuzu ponzu, chili crisp, sesame tuile', category: 'starters', price: 19, rating: 4.9, reviews: 189, diet: 'nonveg', vegan: false, gf: true, spicy: 1, meals: ['dinner'], allergens: ['fish', 'soy', 'sesame'], prep: 10, chefSpecial: true, img: U('1534604973900-c43ab4c2e0ab'), aliases: ['tuna tartare', 'tartare', 'tuna'] },
  { id: 'paneer', name: 'Smoked Paneer Tikka', desc: 'Tandoor-charred paneer, kashmiri chili, mint chutney', category: 'starters', price: 15, rating: 4.7, reviews: 241, diet: 'veg', vegan: false, gf: true, spicy: 2, meals: LD, allergens: ['dairy'], prep: 12, img: U('1567188040759-fb8a883dc6d8'), aliases: ['paneer tikka', 'paneer'] },
  { id: 'calamari', name: 'Crispy Calamari', desc: 'Semolina-dusted squid, Calabrian chili aioli, charred lemon', category: 'starters', price: 15, rating: 4.5, reviews: 132, diet: 'nonveg', vegan: false, gf: false, spicy: 2, meals: LD, allergens: ['molluscs', 'gluten', 'egg'], prep: 9, img: U('1599487488170-d11ec9c172f0'), aliases: ['calamari', 'squid'] },
  { id: 'salmon', name: 'Grilled Atlantic Salmon', desc: 'Lemon beurre blanc, charred asparagus, crushed new potatoes', category: 'mains', price: 32, rating: 4.8, reviews: 302, diet: 'nonveg', vegan: false, gf: true, spicy: 0, meals: LD, allergens: ['fish', 'dairy'], prep: 18, img: U('1467003909585-2f8a72700288'), aliases: ['grilled salmon', 'salmon'] },
  { id: 'risotto', name: 'Truffle Mushroom Risotto', desc: 'Carnaroli rice, porcini, black truffle, 24-month parmigiano', category: 'mains', price: 28, rating: 4.9, reviews: 377, diet: 'veg', vegan: false, gf: true, spicy: 0, meals: LD, allergens: ['dairy'], prep: 20, chefSpecial: true, img: U('1476124369491-e7addf5db371'), aliases: ['truffle mushroom risotto', 'truffle risotto', 'mushroom risotto', 'risotto'] },
  { id: 'ribeye', name: 'Dry-Aged Ribeye Steak', desc: '14 oz, 45-day dry-aged, bone marrow butter, pommes frites', category: 'mains', price: 54, rating: 4.9, reviews: 266, diet: 'nonveg', vegan: false, gf: true, spicy: 0, meals: ['dinner'], allergens: ['dairy'], prep: 25, chefSpecial: true, doneness: true, img: U('1600891964092-4316c288032e'), aliases: ['ribeye steak', 'ribeye', 'rib eye', 'steak'] },
  { id: 'lamb', name: 'Rosemary Lamb Rack', desc: 'Herb crust, smoked aubergine, pomegranate jus', category: 'mains', price: 46, rating: 4.7, reviews: 118, diet: 'nonveg', vegan: false, gf: true, spicy: 1, meals: ['dinner'], allergens: [], prep: 24, doneness: true, img: U('1514516345957-556ca7d90a29'), aliases: ['lamb rack', 'lamb'] },
  { id: 'curry', name: 'Thai Green Vegetable Curry', desc: 'Coconut green curry, Thai aubergine, jasmine rice, bird’s eye chili', category: 'mains', price: 24, rating: 4.6, reviews: 199, diet: 'veg', vegan: true, gf: true, spicy: 3, meals: LD, allergens: ['coconut'], prep: 15, img: U('1455619452474-d2be8b1e70cd'), aliases: ['green curry', 'thai curry', 'curry'] },
  { id: 'arrabbiata', name: 'Penne all’Arrabbiata', desc: 'Bronze-cut penne, San Marzano tomato, garlic, peperoncino', category: 'mains', price: 22, rating: 4.5, reviews: 144, diet: 'veg', vegan: true, gf: false, spicy: 2, meals: LD, allergens: ['gluten'], prep: 14, img: U('1563379926898-05f4575a45d8'), aliases: ['penne arrabbiata', 'arrabbiata', 'arrabiata', 'penne'] },
  { id: 'shakshuka', name: 'Harissa Shakshuka', desc: 'Baked eggs, harissa tomato, labneh, grilled flatbread', category: 'mains', price: 18, rating: 4.6, reviews: 97, diet: 'veg', vegan: false, gf: false, spicy: 2, meals: ['breakfast', 'lunch'], allergens: ['egg', 'dairy', 'gluten'], prep: 14, img: U('1590412200988-a436970781fa'), aliases: ['shakshuka', 'shakshouka'] },
  { id: 'avotoast', name: 'Avocado & Poached Egg Toast', desc: 'Sourdough, smashed avocado, chili flakes, soft poached eggs', category: 'mains', price: 17, rating: 4.4, reviews: 176, diet: 'veg', vegan: false, gf: false, spicy: 1, meals: ['breakfast', 'lunch'], allergens: ['gluten', 'egg'], prep: 10, img: U('1541519227354-08fa5d50c44d'), aliases: ['avocado toast', 'avo toast'] },
  { id: 'pancakes', name: 'Ricotta Buttermilk Pancakes', desc: 'Whipped ricotta, berry compote, maple syrup', category: 'mains', price: 16, rating: 4.7, reviews: 208, diet: 'veg', vegan: false, gf: false, spicy: 0, meals: ['breakfast'], allergens: ['gluten', 'dairy', 'egg'], prep: 12, img: U('1567620905732-2d1ec7ab7445'), aliases: ['pancakes', 'pancake'] },
  { id: 'margherita', name: 'Margherita Napoletana', desc: 'San Marzano tomato, fior di latte, basil, 48-hour dough', category: 'pizza', price: 21, rating: 4.7, reviews: 288, diet: 'veg', vegan: false, gf: false, spicy: 0, meals: LD, allergens: ['gluten', 'dairy'], prep: 12, img: U('1574071318508-1cdbab80d002'), aliases: ['margherita pizza', 'margherita', 'margarita pizza'] },
  { id: 'bianca', name: 'Black Truffle Bianca', desc: 'Truffle cream, fontina, wild mushrooms, rocket', category: 'pizza', price: 29, rating: 4.8, reviews: 121, diet: 'veg', vegan: false, gf: false, spicy: 0, meals: ['dinner'], allergens: ['gluten', 'dairy'], prep: 14, chefSpecial: true, img: U('1513104890138-7c749659a591'), aliases: ['black truffle bianca', 'truffle bianca', 'truffle pizza', 'bianca', 'white pizza'] },
  { id: 'diavola', name: 'Diavola', desc: 'Spicy salami, nduja, chili honey, smoked mozzarella', category: 'pizza', price: 24, rating: 4.6, reviews: 167, diet: 'nonveg', vegan: false, gf: false, spicy: 3, meals: LD, allergens: ['gluten', 'dairy'], prep: 12, img: U('1628840042765-356cda07504e'), aliases: ['diavola pizza', 'diavola', 'pepperoni pizza', 'salami pizza'] },
  { id: 'tiramisu', name: 'Classic Tiramisu', desc: 'Savoiardi, espresso, mascarpone, cocoa', category: 'desserts', price: 12, rating: 4.9, reviews: 412, diet: 'veg', vegan: false, gf: false, spicy: 0, meals: LD, allergens: ['dairy', 'egg', 'gluten'], prep: 5, img: U('1571877227200-a0d98ea607e9'), aliases: ['classic tiramisu', 'tiramisu'] },
  { id: 'fondant', name: 'Valrhona Chocolate Fondant', desc: 'Molten 70% Guanaja, salted caramel, vanilla bean gelato', category: 'desserts', price: 14, rating: 4.8, reviews: 233, diet: 'veg', vegan: false, gf: false, spicy: 0, meals: ['dinner'], allergens: ['dairy', 'egg', 'gluten'], prep: 12, chefSpecial: true, img: U('1606313564200-e75d5e30476c'), aliases: ['chocolate fondant', 'lava cake', 'fondant', 'chocolate cake'] },
  { id: 'brulee', name: 'Vanilla Bean Crème Brûlée', desc: 'Madagascar vanilla custard, burnt sugar crust, shortbread', category: 'desserts', price: 11, rating: 4.7, reviews: 187, diet: 'veg', vegan: false, gf: true, spicy: 0, meals: LD, allergens: ['dairy', 'egg'], prep: 5, img: U('1470124182917-cc6e71b22ecc'), aliases: ['creme brulee', 'crème brûlée', 'brulee'] },
  { id: 'mocktail', name: 'Mango Passion Mocktail', desc: 'Alphonso mango, passion fruit, lime, soda', category: 'beverages', price: 9, rating: 4.8, reviews: 265, diet: 'veg', vegan: true, gf: true, spicy: 0, meals: ALL_MEALS, allergens: [], prep: 4, img: U('1546171753-97d7676e4602'), aliases: ['mango passion mocktail', 'mango mocktail', 'passion mocktail', 'mocktail'] },
  { id: 'lemonade', name: 'Rose & Cardamom Lemonade', desc: 'Pressed lemon, rose water, green cardamom', category: 'beverages', price: 8, rating: 4.5, reviews: 98, diet: 'veg', vegan: true, gf: true, spicy: 0, meals: LD, allergens: [], prep: 3, img: U('1621263764928-df1444c5e859'), aliases: ['rose lemonade', 'cardamom lemonade', 'lemonade'] },
  { id: 'flatwhite', name: 'Single-Origin Flat White', desc: 'Ethiopian Yirgacheffe, silky microfoam', category: 'beverages', price: 6, rating: 4.6, reviews: 143, diet: 'veg', vegan: false, gf: true, spicy: 0, meals: ['breakfast', 'lunch'], allergens: ['dairy'], prep: 4, img: U('1510591509098-f4fdc6d0ff04'), aliases: ['flat white', 'coffee', 'latte'] },
].map((m) => ({ available: true, ...m }));

// ---------- Pricing engine (sole source of truth for money) ----------
export function priceLine(menu, line) {
  const item = menu.find((m) => m.id === line.itemId);
  if (!item) return { unit: 0, modsTotal: 0, total: 0 };
  const modsTotal = (line.mods || []).reduce((s, k) => s + ((MODIFIERS[k] && MODIFIERS[k].price) || 0), 0);
  const unit = item.price + modsTotal;
  return { unit, modsTotal, total: unit * line.qty };
}
export function totals(menu, lines) {
  const subtotal = lines.reduce((s, l) => {
    const item = menu.find((m) => m.id === l.itemId);
    return item && item.available ? s + priceLine(menu, l).total : s;
  }, 0);
  const tax = subtotal * TAX_RATE;
  return { subtotal, tax, total: subtotal + tax };
}

// The dish the owner pairs with something already in the cart, if it isn't there yet.
export function upsellFor(menu, cart) {
  for (const l of cart) {
    const base = menu.find((m) => m.id === l.itemId);
    const pair = base && base.pairWith && menu.find((m) => m.id === base.pairWith);
    if (pair && pair.available && !cart.some((x) => x.itemId === pair.id)) return { item: pair, base };
  }
  return null;
}

// ---------- Filters ----------
export const EMPTY_FILTERS = { diet: null, vegan: false, gf: false, jain: false, halal: false, avoid: [], spice: null, meal: null, category: 'all', maxPrice: null };
export function matchesFilters(item, f) {
  if (f.category === 'specials' && !item.chefSpecial) return false;
  if (f.category !== 'all' && f.category !== 'specials' && item.category !== f.category) return false;
  if (f.diet && item.diet !== f.diet) return false;
  if (f.vegan && !item.vegan) return false;
  if (f.gf && !item.gf) return false;
  if (f.jain && !item.jain) return false;
  if (f.halal && !item.halal) return false;
  // Only dishes whose allergen list the kitchen has confirmed can be shown as free of something.
  if (f.avoid && f.avoid.length && (!item.allergensChecked || f.avoid.some((a) => item.allergens.includes(a)))) return false;
  if (f.spice === 'spicy' && item.spicy < 1) return false;
  if (f.spice === 'mild' && item.spicy > 0) return false;
  if (f.meal && !item.meals.includes(f.meal)) return false;
  if (f.maxPrice && item.price > f.maxPrice) return false;
  return true;
}
export function describeFilters(f) {
  const adj = [];
  if (f.spice === 'spicy') adj.push('spicy');
  if (f.spice === 'mild') adj.push('mild');
  if (f.vegan) adj.push('vegan');
  else if (f.diet === 'veg') adj.push('vegetarian');
  if (f.diet === 'nonveg') adj.push('non-veg');
  if (f.gf) adj.push('gluten-free');
  if (f.jain) adj.push('Jain');
  if (f.halal) adj.push('halal');
  const noun = f.category === 'all' ? 'dishes' : f.category === 'specials' ? 'chef specials' : catLabel(f.category).toLowerCase() + (f.category === 'pizza' ? 's' : f.category === 'mains' ? 's' : '');
  let s = [...adj, noun].join(' ');
  if (f.avoid && f.avoid.length) {
    const names = f.avoid.map((a) => allergenLabel(a).toLowerCase());
    s += ' without ' + (names.length < 2 ? names[0] : names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1]);
  }
  if (f.meal) s += ' for ' + f.meal;
  if (f.maxPrice) s += ' under ' + fmt(f.maxPrice).replace('.00', '');
  return s;
}

// ---------- Input guardrail layer ----------
const GUARD_RULES = [
  { kind: 'prompt-injection', re: /\b(ignore|forget|disregard|override|bypass)\b.{0,30}\b(rules?|instructions?|prompts?|guidelines?|polic(y|ies)|previous|above|system)\b/ },
  { kind: 'prompt-injection', re: /\b(system prompt|developer mode|jailbreak|you are now|pretend (you|to be)|act as (an?|the)|admin mode|root access)\b/ },
  { kind: 'price-manipulation', re: /\b(set|change|make|update|lower|drop)\b.{0,25}\b(price|cost|bill|total)s?\b|\bprices? (to|=)\s*\$?\d|\bfor free\b|\bon the house\b|\b100 ?% off\b|\bdiscount\b|\bcoupon\b|\bcomp (my|the|our)\b|\bzero dollars\b/ },
  { kind: 'out-of-scope', re: /\b(write|generate|create|give me|show me)\b.{0,25}\b(python|javascript|script|code|program|sql|function|essay|poem|story)\b|<script|drop table|select \* from|rm -rf|\bbase64\b/ },
  { kind: 'out-of-scope', re: /\b(weather|stock price|bitcoin|crypto|election|homework|translate this|news today)\b/ },
];
export function guardrail(text) {
  for (const r of GUARD_RULES) if (r.re.test(text)) return { blocked: true, kind: r.kind };
  return { blocked: false };
}

// ---------- Speech safety parsing ----------
export function sanitizeTranscript(raw) {
  let t = String(raw || '').replace(/[\u0000-\u001f\u007f<>{}`]/g, ' ').replace(/\s+/g, ' ').trim();
  let truncated = false;
  if (t.length > MAX_TURN_CHARS) {
    t = t.slice(0, MAX_TURN_CHARS).replace(/\s+\S*$/, '');
    truncated = true;
  }
  return { text: t, truncated };
}

// ---------- Simulated LLM intent parser -> tool calls ----------
const NUM = { a: 1, an: 1, one: 1, single: 1, two: 2, couple: 2, pair: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
export const norm = (t) =>
  t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'").replace(/&/g, ' and ')
    .replace(/[^a-z0-9$.%' -]/g, ' ').replace(/\s+/g, ' ').trim();

function findAll(text, alias) {
  const out = [];
  let i = text.indexOf(alias);
  while (i !== -1) {
    const before = i === 0 ? ' ' : text[i - 1];
    let end = i + alias.length;
    if (text.slice(end, end + 2) === 'es' && !/[a-z]/.test(text[end + 2] || ' ')) end += 2;
    else if (text[end] === 's' && !/[a-z]/.test(text[end + 1] || ' ')) end += 1;
    const after = text[end] || ' ';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) out.push({ start: i, end });
    i = text.indexOf(alias, i + 1);
  }
  return out;
}
export function findItems(text, menu) {
  const cands = [];
  for (const item of menu) {
    const aliases = [norm(item.name), ...(item.aliases || []).map(norm)];
    for (const a of aliases) for (const m of findAll(text, a)) cands.push({ item, ...m, len: m.end - m.start });
  }
  cands.sort((a, b) => b.len - a.len);
  const picked = [];
  for (const c of cands) if (!picked.some((p) => c.start < p.end && p.start < c.end)) picked.push(c);
  return picked.sort((a, b) => a.start - b.start);
}
function qtyBefore(text) {
  const toks = text.trim().split(' ').slice(-4).reverse();
  for (const t of toks) {
    if (/^\d+$/.test(t)) return Math.min(parseInt(t, 10), 99);
    if (t in NUM) return NUM[t];
    if (!['of', 'the', 'x', 'more', 'order', 'orders', 'portion', 'portions', 'plate', 'plates', 'glass', 'glasses', 'cup', 'cups', 'slice', 'slices'].includes(t)) break;
  }
  return 1;
}
const wordNum = (w) => (/^\d+$/.test(w) ? parseInt(w, 10) : NUM[w]);

const RE = {
  callServer: /\b(call|get|send|need|bring|want|page)\b.{0,15}\b(server|waiter|waitress|staff|someone|manager|host)\b|\b(assistance|help please)\b/,
  bill: /\b(bill|check please|the check|our check|my check|split the check|pay(ing)? now|ready to pay|settle up)\b/,
  split: /\bsplit\b.*?\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\b|\b(\d+|two|three|four|five|six|seven|eight)\s+ways\b/,
  placeOrder: /\b(place|send|submit|confirm|finali[sz]e)\b.{0,15}\border\b|\bthat'?s all\b|\bthat is all\b|\bsend it to the kitchen\b/,
  cart: /\b(my|our) (cart|order|basket)\b|\bwhat (did|have) (i|we) order(ed)?\b/,
  clear: /\b(clear|reset|remove)\b.{0,12}\bfilters?\b|\bshow (me )?(everything|all dishes|the (whole|full) menu|full menu)\b|\bstart over\b/,
  remove: /\b(remove|delete|cancel|take off|drop|no more)\b/,
  question: /\b(what'?s in|what is in|tell me about|describe|ingredients|is the|is it|does the|does it|how spicy|what comes with|allergens?|calories|what is the|what'?s the)\b/,
  recommend: /\b(recommend|suggest|what'?s good|popular|signature|favou?rite|surprise me)\b/,
  priceAttempt: /\$\s*\d+(\.\d+)?|\b\d+\s*(dollars|bucks)\b/,
  allergy: /\ballerg(?:y|ic|ies)\b(?: to)? ([a-z ]{3,30}?)(?=[,.;!?]|\s+(?:and|please|so|but|add)\b|$)/,
  // "Does the korma have nuts?", "is the tiramisu nut-free", "any gluten in the penne"
  allergenAsk: /\b(contains?|have|has|got|any|free|safe|allerg\w*|is there|are there)\b/,
  cancelOrder: /\b(undo|cancel|take back)\b.{0,20}\b(order|that|it)\b|^undo\b/,
};

// Short answers to "Shall I send it?" and "Would you like to add …?".
export function confirmWord(raw) {
  const t = norm(raw).replace(/[.!]+$/, '');
  if (/^(no|nope|not yet|wait|hold on|don'?t|no thanks?|no thank you|not now|cancel)\b/.test(t)) return 'no';
  if (/^(yes|yeah|yep|yup|sure|ok|okay|please|please do|go ahead|confirm|correct|that'?s right|send|send it|do it|add it|yes please|of course|absolutely)\b/.test(t)) return 'yes';
  return null;
}

function extractFilters(t) {
  const f = { ...EMPTY_FILTERS };
  let found = false;
  if (/\bnon[- ]?veg(etarian)?\b|\bmeat\b|\b(chicken|beef|lamb|seafood|fish|pork)\b/.test(t)) { f.diet = 'nonveg'; found = true; }
  else if (/\b(vegetarian|veggie|veg)\b/.test(t)) { f.diet = 'veg'; found = true; }
  if (/\b(vegan|plant[- ]based)\b/.test(t)) { f.vegan = true; f.diet = 'veg'; found = true; }
  if (/\bgluten[- ]?free\b|\bceliac\b|\bcoeliac\b|\bno gluten\b/.test(t)) { f.gf = true; found = true; }
  if (/\bjain\b/.test(t)) { f.jain = true; f.diet = 'veg'; found = true; }
  if (/\bhalal\b/.test(t)) { f.halal = true; found = true; }
  // "nut-free", "without dairy", "no sesame" (gluten is covered by the gluten-free filter above)
  if (/\b(free|without|no|avoid|allerg\w*)\b/.test(t)) {
    const avoid = allergensIn(t).filter((a) => a !== 'gluten');
    if (avoid.length) {
      f.avoid = avoid; found = true;
      // "fish-free" named fish, which isn't a request for non-veg dishes.
      if (f.diet === 'nonveg' && !/\bnon[- ]?veg|\bmeat\b|\b(chicken|beef|lamb|pork)\b/.test(t)) f.diet = null;
    }
  }
  if (/\b(not spicy|mild|no spice|not too hot)\b/.test(t)) { f.spice = 'mild'; found = true; }
  else if (/\b(spicy|hot|fiery|chil(l)?i|heat)\b/.test(t)) { f.spice = 'spicy'; found = true; }
  const meal = t.match(/\b(breakfast|brunch|lunch|dinner|supper)\b/);
  if (meal) { f.meal = { brunch: 'breakfast', supper: 'dinner' }[meal[1]] || meal[1]; found = true; }
  const cats = [
    ['specials', /\bchef'?s? specials?\b|\bspecials\b|\bsignature\b/],
    ['starters', /\b(starters?|appeti[sz]ers?|small plates?|to start)\b/],
    ['mains', /\b(mains?|main courses?|entrees?|main dish(es)?)\b/],
    ['pizza', /\bpizzas?\b/],
    ['desserts', /\b(desserts?|sweets?|something sweet)\b/],
    ['beverages', /\b(drinks?|beverages?|mocktails?|juices?|coffee|something to drink)\b/],
  ];
  for (const [id, re] of cats) if (re.test(t)) { f.category = id; found = true; break; }
  // An imported menu's own sections: "show me the biryanis" finds "Popular Biryani & Rice Items".
  if (f.category === 'all') {
    for (const sec of menuMeta.sections) if (sectionWords(sec.label).some((w) => new RegExp(`\\b${w}(s|es|ies|y)?\\b`).test(t))) { f.category = sec.id; found = true; break; }
  }
  const mp = t.match(/\b(under|below|less than|cheaper than|max(?:imum)?|up to|within)\s*(?:\$|aed|rs|inr|₹|€|£)?\s*(\d{1,6})\b/);
  if (mp) { f.maxPrice = parseInt(mp[2], 10); found = true; }
  return { filters: f, found };
}

const SECTION_STOP = new Set(['popular', 'items', 'item', 'main', 'mains', 'course', 'courses', 'house', 'special', 'specials', 'signature', 'with', 'from', 'menu', 'dishes', 'dish', 'selection', 'assorted', 'fresh', 'our', 'the', 'and', 'all', 'more', 'other', 'others', 'sides', 'side']);
// The words a guest might use for a section, reduced to a stem that also matches plurals.
const sectionWords = (label) => norm(label).split(' ').filter((w) => w.length >= 4 && !SECTION_STOP.has(w))
  .map((w) => w.replace(/(ies|es|s)$/, '')).filter((w) => w.length >= 3);

// Returns raw "LLM" tool calls. These are untrusted until validateCall() passes them.
export function parseIntent(raw, menu) {
  const t = norm(raw);
  const calls = [];
  const allergy = raw.toLowerCase().match(RE.allergy);
  if (allergy) calls.push({ tool: 'set_instructions', args: { text: 'Allergy: ' + allergy[1].trim() } });

  if (RE.callServer.test(t)) return [...calls, { tool: 'call_server', args: { reason: 'Guest requested assistance' } }];
  if (RE.bill.test(t) || /\bsplit\b/.test(t)) {
    const sm = t.match(RE.split);
    const n = sm ? wordNum(sm[1] || sm[2]) : /\bsplit\b/.test(t) ? 2 : 1;
    return [...calls, { tool: 'request_bill', args: { split_ways: n } }];
  }
  const hits = findItems(t, menu);
  if (RE.cancelOrder.test(t) && !hits.length) return [...calls, { tool: 'cancel_order', args: {} }];
  if (RE.placeOrder.test(t)) return [...calls, { tool: 'place_order', args: {} }];
  if (RE.cart.test(t) && !hits.length) return [...calls, { tool: 'open_cart', args: {} }];
  if (RE.clear.test(t)) return [...calls, { tool: 'clear_filters', args: {} }];

  if (hits.length) {
    if (RE.remove.test(t)) return [...calls, ...hits.map((h) => ({ tool: 'remove_from_cart', args: { item_id: h.item.id } }))];
    const asked = allergensIn(t);
    const ordering = /\b(add|order|i'?ll have|get me|i want|we want)\b/.test(t);
    if (asked.length && !ordering && (RE.allergenAsk.test(t) || RE.question.test(t))) {
      return [...calls.filter((c) => c.tool !== 'set_instructions'), { tool: 'allergen_check', args: { item_id: hits[0].item.id, allergen: asked[0] } }];
    }
    if (RE.question.test(t) && !ordering) return [...calls, { tool: 'describe_item', args: { item_id: hits[0].item.id } }];
    const priceAttempt = t.match(RE.priceAttempt);
    hits.forEach((h, i) => {
      const tail = t.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : t.length);
      const mods = Object.keys(MODIFIERS).filter((k) => MODIFIERS[k].re.test(tail));
      const args = { item_id: h.item.id, qty: qtyBefore(t.slice(i ? hits[i - 1].end : 0, h.start)), modifiers: mods };
      // A naive LLM would happily copy a user-stated price into the call. The validator must strip it.
      if (priceAttempt) args.unit_price = parseFloat(priceAttempt[0].replace(/[^0-9.]/g, ''));
      calls.push({ tool: 'add_to_cart', args });
    });
    return calls;
  }
  const { filters, found } = extractFilters(t);
  if (found) return [...calls, { tool: 'apply_filters', args: filters }];
  if (RE.recommend.test(t)) return [...calls, { tool: 'apply_filters', args: { ...EMPTY_FILTERS, category: 'specials' } }];
  if (calls.length) return calls;
  return [{ tool: 'fallback', args: {} }];
}

// ---------- Strict tool-call schema validation ----------
const MEALS = ['breakfast', 'lunch', 'dinner'];
const T = {
  str: (max) => (v) => (typeof v === 'string' && v.length <= max ? null : `must be a string of at most ${max} chars`),
  int: (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? null : `must be an integer ${min}-${max}`),
  num: (min, max) => (v) => (v === null || (typeof v === 'number' && v >= min && v <= max) ? null : `must be null or ${min}-${max}`),
  bool: (v) => (typeof v === 'boolean' ? null : 'must be boolean'),
  oneOf: (list) => (v) => (list.includes(v) ? null : `must be one of ${list.map(String).join(', ')}`),
  listOf: (list, max) => (v) => (Array.isArray(v) && v.length <= max && v.every((x) => list.includes(x)) ? null : `must be a list of up to ${max} of ${list.join(', ')}`),
};
const TOOL_SCHEMAS = {
  apply_filters: {
    diet: T.oneOf([null, 'veg', 'nonveg']), vegan: T.bool, gf: T.bool, jain: T.bool, halal: T.bool, avoid: T.listOf(ALLERGEN_KEYS, 6),
    spice: T.oneOf([null, 'spicy', 'mild']), meal: T.oneOf([null, ...MEALS]),
    category: (v) => (v === 'all' || v === 'specials' || isCategory(v) ? null : 'must be a menu category'), maxPrice: T.num(1, 100000),
  },
  allergen_check: { item_id: 'menu_item', allergen: T.oneOf(ALLERGEN_KEYS) },
  cancel_order: {},
  clear_filters: {},
  add_to_cart: { item_id: 'menu_item', qty: T.int(1, 10), modifiers: 'modifier_list' },
  remove_from_cart: { item_id: 'menu_item' },
  describe_item: { item_id: 'menu_item' },
  call_server: { reason: T.str(80) },
  request_bill: { split_ways: T.int(1, 12) },
  place_order: {},
  open_cart: {},
  set_instructions: { text: T.str(120) },
  fallback: {},
};
const MONEY_KEYS = /price|cost|total|amount|discount|subtotal|tax/i;

export function validateCall(call, menu) {
  const errors = [], stripped = [];
  const schema = TOOL_SCHEMAS[call.tool];
  if (!schema) return { ok: false, errors: [`unknown tool "${call.tool}"`], stripped, args: {} };
  const args = {};
  for (const [k, v] of Object.entries(call.args || {})) {
    if (!(k in schema)) { stripped.push({ key: k, value: v, money: MONEY_KEYS.test(k) }); continue; }
    const rule = schema[k];
    if (rule === 'menu_item') {
      if (!menu.some((m) => m.id === v)) errors.push(`${k}: "${v}" is not on the menu`);
      else args[k] = v;
    } else if (rule === 'modifier_list') {
      const item = menu.find((m) => m.id === call.args.item_id);
      const allowed = item ? allowedMods(item) : [];
      args[k] = [];
      for (const mod of Array.isArray(v) ? v.slice(0, 6) : []) {
        if (allowed.includes(mod)) args[k].push(mod);
        else stripped.push({ key: `${k}.${mod}`, value: MODIFIERS[mod] ? MODIFIERS[mod].label : mod, money: false, notAllowed: true });
      }
    } else {
      const e = rule(v);
      if (e) errors.push(`${k} ${e}`);
      else args[k] = v;
    }
  }
  for (const k of Object.keys(schema)) {
    if (!(k in args) && (schema[k] === 'menu_item' || (call.tool === 'add_to_cart' && k === 'qty'))) {
      if (!errors.some((e) => e.startsWith(k))) errors.push(`${k} is required`);
    }
  }
  return { ok: errors.length === 0, errors, stripped, args };
}

// ---------- Menu ingestion helpers ----------
export function inferTags(name, desc = '') {
  const t = norm(name + ' ' + desc);
  const nonveg = /\b(chicken|mutton|goat|keema|kheema|gosht|seekh|shawarma|kebab|kabab|beef|(?<!(cauliflower|tofu|mushroom|celeriac|cabbage) )steak|lamb|pork|duck|boar|bacon|salami|nduja|prosciutto|fish|salmon|tuna|cod|shrimp|prawns?|crab|lobster|squid|calamari|anchov(y|ies)|veal|venison)\b/.test(t);
  const dairy = /\b(cheese|cream|butter|milk|paneer|ghee|malai|makhani|dahi|raita|lassi|kulfi|rabri|ricotta|mascarpone|parmesan|parmigiano|burrata|mozzarella|fior di latte|yogurt|labneh|gelato|creme|anglaise|custard|pecorino)\b/.test(t);
  const egg = /\b(egg|eggs|aioli|mayo)\b/.test(t);
  const gluten = /\b(bread|breads|roti|chapati|naan|nan|paratha|kulcha|bhatura|puri|poori|samosa|pasta|pappardelle|penne|spaghetti|pizza|dough|crust|toast|tart|tatin|brioche|flatbread|sourdough|cake)\b/.test(t);
  const nuts = /\b(walnut|almond|pecan|hazelnut|pistachio|cashew|peanut|kaju|badam)s?\b/.test(t);
  const fish = /\b(fish|salmon|tuna|cod|hammour|pomfret|kingfish|anchov(y|ies))\b/.test(t);
  const shellfish = /\b(prawns?|shrimps?|crab|lobster)\b/.test(t);
  let category = 'mains';
  if (/\b(soup|veloute|salad|tartare|bruschetta|carpaccio|starter|croquette)s?\b/.test(t)) category = 'starters';
  if (/\b(tart|tatin|cake|mousse|gelato|sorbet|pudding|brulee|tiramisu|panna cotta|dessert|kheer|halwa|kulfi|gulab jamun|rasmalai|jalebi|kunafa|umm ali)\b/.test(t)) category = 'desserts';
  if (/\b(mocktail|cocktail|lemonade|juice|coffee|tea|chai|lassi|soda|old fashioned|spritz|zero[- ]proof)\b/.test(t)) category = 'beverages';
  if (/\bpizza\b/.test(norm(name))) category = 'pizza';
  const spicy = /\b(nduja|chili|chilli|harissa|jalapeno|peppercorn|spicy|vindaloo|65|chettinad|kolhapuri|mirchi)\b/.test(t) ? 2
    : /\b(pepper|smoked paprika|ginger|masala|biryani|tikka|curry|curries)\b/.test(t) ? 1 : 0;
  const allergens = [dairy && 'dairy', egg && 'egg', gluten && 'gluten', nuts && 'nuts', fish && 'fish', shellfish && 'shellfish'].filter(Boolean);
  return {
    category, diet: nonveg ? 'nonveg' : 'veg', vegan: !nonveg && !dairy && !egg, gf: !gluten, spicy, allergens,
    meals: category === 'beverages' ? ['lunch', 'dinner'] : /\b(pancake|egg|toast|brunch)\b/.test(t) ? ['breakfast', 'lunch'] : ['lunch', 'dinner'],
  };
}

export const SAMPLE_EXTRACTION = [
  { name: 'Roasted Butternut Velouté', desc: 'Sage brown butter, toasted pepitas, crème fraîche', price: 12 },
  { name: 'Duck Confit Salad', desc: 'Frisée, candied walnuts, orange segments, sherry vinaigrette', price: 18 },
  { name: 'Wild Boar Pappardelle', desc: 'Slow-braised boar ragù, juniper, pecorino', price: 34 },
  { name: 'Charred Cauliflower Steak', desc: 'Smoked paprika romesco, golden raisins, herb salsa', price: 26 },
  { name: 'Nduja & Hot Honey Pizza', desc: 'Calabrian nduja, fior di latte, chili honey', price: 25 },
  { name: 'Spiced Pear Tarte Tatin', desc: 'Star anise caramel, cinnamon crème anglaise', price: 13 },
  { name: 'Smoked Maple Old Fashioned (zero-proof)', desc: 'Seedlip Spice, smoked maple, orange bitters', price: 11, lowConf: 'Price partly obscured on page 2' },
].map((r, i) => ({ ...r, conf: r.lowConf ? 0.72 : [0.97, 0.93, 0.91, 0.88, 0.95, 0.9][i], ...inferTags(r.name, r.desc) }));
