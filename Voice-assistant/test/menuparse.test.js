import assert from 'node:assert/strict';
import test from 'node:test';
import { linesFromPdf, pageFromOcr, parseMenu, parseMenuText } from '../shared/menuparse.js';

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

// Tesseract gives words with boxes, y growing downwards; a line of words on one row of a picture.
const ocrLine = (y, ...words) => ({
  bbox: { y0: y, y1: y + 30 },
  words: words.map(([text, x, confidence = 95]) => ({ text, confidence, bbox: { x0: x, x1: x + text.length * 14, y0: y, y1: y + 30 } })),
});
const fromOcr = (...lines) => parseMenu(linesFromPdf([pageFromOcr(lines, 1000, 1400)]));

test('a menu read from a picture: separate words still make dishes, prices and sections', () => {
  const r = fromOcr(
    ocrLine(100, ['POPULAR', 40], ['BIRYANI', 180], ['&', 300], ['RICE', 330]),
    ocrLine(160, ['Chicken', 40], ['65', 160], ['Biryani', 210], ['.......', 400], ['AED', 800], ['32.00', 860]),
    ocrLine(210, ['Mutton', 40], ['Dum', 150], ['Biryani', 220], ['AED', 700], ['31.00', 760], ['–', 840], ['38.00', 870]),
    ocrLine(260, ['Tandoori', 40], ['Roti', 170], ['/', 240], ['Chapati', 260], ['AED', 800], ['2.00', 860]),
  );
  assert.deepEqual(r.sections.map((s) => s.label), ['Popular Biryani & Rice']);
  assert.deepEqual(r.rows.map((d) => [d.name, d.price]), [['Chicken 65 Biryani', 32], ['Mutton Dum Biryani', 31], ['Tandoori Roti / Chapati', 2]]);
  assert.deepEqual(r.rows[1].priceRange, [31, 38]);
  assert.equal(r.currency, 'AED');
});

test('misread digits are corrected, and specks and leader dots are dropped', () => {
  const r = fromOcr(ocrLine(100, ['Butter', 40], ['Chicken', 140], ['|', 300], ['~~', 340, 20], ['2O.00', 800]), ocrLine(150, ['Fish', 40], ['Biryani', 100], ['l5.5O', 800], ['x', 900, 10]));
  assert.deepEqual(r.rows.map((d) => [d.name, d.price]), [['Butter Chicken', 20], ['Fish Biryani', 15.5]]);
});

test('a word the reader was unsure of marks that dish for checking', () => {
  const r = fromOcr(ocrLine(100, ['Butter', 40, 96], ['Chicken', 140, 96], ['25.00', 800, 41]), ocrLine(150, ['Fish', 40, 97], ['Biryani', 100, 97], ['30.00', 800, 96]));
  assert.equal(r.rows[0].conf, 0.41);
  assert.match(r.rows[0].priceNote, /Hard to read/);
  assert.equal(r.rows[1].priceNote, '');
});

test('a misread price never becomes a dish', () => {
  const r = fromOcr(ocrLine(100, ['AED', 40], ['31.00', 100], ['38.00', 800]), ocrLine(150, ['Fish', 40], ['Biryani', 100], ['AED', 800], ['30', 860]));
  assert.deepEqual(r.rows.map((d) => d.name), ['Fish Biryani']);
});

test('a price that lost its decimal point in a picture is recovered and flagged', () => {
  const r = fromOcr(
    ocrLine(100, ['Fish', 40], ['Biryani', 100], ['30.00', 800]), ocrLine(150, ['Butter', 40], ['Chicken', 140], ['25.00', 800]),
    ocrLine(200, ['Prawns', 40], ['Biryani', 140], ['4000', 800]), ocrLine(250, ['Chicken', 40], ['65', 160], ['Dry', 210], ['24.50', 800]),
  );
  assert.equal(r.rows[2].price, 40);
  assert.match(r.rows[2].priceNote, /Read as 4000, taken to be 40\.00/);
  assert.equal(r.rows[2].conf, 0.5);
  // On a menu of whole numbers, a high price is left alone.
  const whole = fromOcr(ocrLine(100, ['Thali', 40], ['120', 800]), ocrLine(150, ['Biryani', 40], ['250', 800]), ocrLine(200, ['Kebab', 40], ['300', 800]));
  assert.deepEqual(whole.rows.map((d) => d.price), [120, 250, 300]);
});

test('a picture that mostly read badly says so', () => {
  const bad = fromOcr(ocrLine(100, ['Fish', 40, 40], ['30.00', 800, 50]), ocrLine(150, ['Soup', 40, 30], ['25.00', 800, 60]), ocrLine(200, ['Naan', 40, 96], ['4.00', 800, 96]));
  assert.equal(bad.hardToRead, true);
  const good = fromOcr(ocrLine(100, ['Fish', 40], ['30.00', 800]), ocrLine(150, ['Soup', 40], ['25.00', 800]));
  assert.equal(good.hardToRead, false);
});
