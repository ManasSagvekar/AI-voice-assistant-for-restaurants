import assert from 'node:assert/strict';
import test from 'node:test';
import { linesFromPdf, parseMenu, parseMenuText } from '../shared/menuparse.js';

// The text layer of a one-column PDF menu (Tayeb Kitchen's layout): a large title, an address,
// capitalised section headings, and prices far to the right of each dish.
const item = (str, x, y, h) => ({ str, x, y, h, w: str.length * h * 0.5 });
const TAYEB = [{
  width: 595,
  items: [
    item('TAYEB KITCHEN & RESTAURANT', 65, 758, 28), item('Al Khabaisi, Deira, Dubai, UAE', 216, 727, 12),
    item('POPULAR BIRYANI & RICE ITEMS', 57, 671, 16),
    item('AED 32.00', 480, 635, 12), item('Chicken 65 Biryani', 57, 635, 11),
    item('AED 31.00 – 38.00', 437, 608, 12), item('Mutton Dum Biryani', 57, 608, 11),
    item('CURRIES & MAIN COURSES', 57, 459, 16),
    item('AED 25.00', 480, 423, 12), item('Butter Chicken', 57, 423, 11),
    item('AED 18.00', 480, 396, 12), item('Paneer Butter Masala', 57, 396, 11),
    item('STARTERS & BREADS', 57, 329, 16),
    item('AED 2.00', 487, 239, 12), item('Tandoori Roti / Chapati', 57, 239, 11),
    item('Prices are subject to change. For verification please check official delivery aggregators.', 106, 186, 8),
    item('Page 1', 510, 26, 9),
  ],
}];

test("a PDF menu keeps the restaurant's own sections, in order, with every dish and the currency", () => {
  const r = parseMenu(linesFromPdf(TAYEB));
  assert.equal(r.title, 'Tayeb Kitchen & Restaurant');
  assert.equal(r.currency, 'AED');
  assert.deepEqual(r.sections.map((s) => s.label), ['Popular Biryani & Rice Items', 'Curries & Main Courses', 'Starters & Breads']);
  assert.deepEqual(r.rows.map((d) => [d.name, d.price]), [
    ['Chicken 65 Biryani', 32], ['Mutton Dum Biryani', 31], ['Butter Chicken', 25], ['Paneer Butter Masala', 18], ['Tandoori Roti / Chapati', 2],
  ]);
  assert.deepEqual([...new Set(r.rows.map((d) => d.category))], r.sections.map((s) => s.id));
  assert.match(r.rows[1].priceNote, /AED 31\.00 – 38\.00/);
  assert.ok(r.rows[1].conf < 0.8, 'a price range needs checking');
  assert.equal(r.rows.find((d) => d.name === 'Paneer Butter Masala').diet, 'veg');
  assert.ok(r.rows[4].aliases.includes('chapati'));
});

test('a two-column page is read one column at a time', () => {
  const pages = [{
    width: 600,
    items: [
      item('STARTERS', 40, 700, 16), item('DESSERTS', 330, 700, 16),
      item('Soup', 40, 670, 11), item('$6', 250, 670, 11), item('Kulfi', 330, 670, 11), item('$5', 540, 670, 11),
      item('Samosa', 40, 650, 11), item('$4', 250, 650, 11), item('Jalebi', 330, 650, 11), item('$4.50', 530, 650, 11),
      item('Salad', 40, 630, 11), item('$7', 250, 630, 11), item('Halwa', 330, 630, 11), item('$5', 540, 630, 11),
    ],
  }];
  const r = parseMenu(linesFromPdf(pages));
  assert.equal(r.currency, 'USD');
  assert.deepEqual(r.rows.map((d) => [d.name, d.category]), [
    ['Soup', 'starters'], ['Samosa', 'starters'], ['Salad', 'starters'], ['Kulfi', 'desserts'], ['Jalebi', 'desserts'], ['Halwa', 'desserts'],
  ]);
});

test('a text price list: headings with colons, descriptions under dishes, prices on their own line', () => {
  const r = parseMenuText([
    'The Corner Cafe',
    'Breakfast Plates:',
    'Masala Omelette - 120/-',
    'Three eggs, onion, green chilli',
    'Aloo Paratha',
    'Rs. 90',
    'Chai & Coffee:',
    'Cutting Chai | Rs 20',
    'Filter Coffee ........ Rs 35',
  ].join('\n'));
  assert.equal(r.currency, 'INR');
  assert.deepEqual(r.sections.map((s) => s.label), ['Breakfast Plates', 'Chai & Coffee']);
  assert.deepEqual(r.rows.map((d) => [d.name, d.price]), [['Masala Omelette', 120], ['Aloo Paratha', 90], ['Cutting Chai', 20], ['Filter Coffee', 35]]);
  assert.equal(r.rows[0].desc, 'Three eggs, onion, green chilli');
});

test('a number inside a dish name is not mistaken for its price', () => {
  const r = parseMenuText('Chicken 65\nAED 24\nChicken 65 Dry\tAED 26');
  assert.deepEqual(r.rows.map((d) => [d.name, d.price]), [['Chicken 65', 24], ['Chicken 65 Dry', 26]]);
});
