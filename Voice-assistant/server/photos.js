// Dish photos for an imported menu, found on Wikipedia (free-licensed images only). Each photo is
// downloaded once into MEDIA_DIR and served from this server, so tablets never load images from the
// internet. A photo's `credit` links to its file page, which names the author and licence.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const UA = { 'User-Agent': 'TazteMenuPhotos/1.0 (restaurant menu import)' };
const API = 'https://en.wikipedia.org/w/api.php';
const GENERIC = new Set(['assorted', 'full', 'half', 'dry', 'classic', 'special', 'house', 'signature', 'plate', 'portion', 'regular', 'large', 'small', 'fresh', 'homemade', 'our', 'the', 'and', 'with']);
const FOOD = /\b(dish|dishes|food|bread|flatbread|curry|rice|dessert|drink|beverage|snack|sweet|soup|salad|cheese|kebab|pastry|cake|noodles?|sauce|stew|pudding|biscuit|pancake|sandwich|pizza|pasta|coffee|tea|juice|cocktail|fried|grilled|roast(ed)?|marinated|confection)\b/i;
const NOT_A_DISH = /\b(restaurant|chef|restaurateur|film|series|album|song|novel|cuisine of|culinary traditions|cooking style|cooking technique|oven|spice mixture|list of|topics referred|cultivar|company|brand|chain)\b/i;
const MAIN = new Set(['chicken', 'mutton', 'lamb', 'goat', 'beef', 'pork', 'fish', 'prawn', 'shrimp', 'crab', 'egg', 'paneer', 'tofu', 'mushroom', 'duck', 'turkey']);
const MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Wikimedia limits bursts of requests (429); wait as asked and try again a few times.
async function politeFetch(url, timeout) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
    if (res.status !== 429 || attempt === 3) return res;
    await pause(Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt * 2, 30) * 1000);
  }
}

const words = (t) => t.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
  .map((w) => w.replace(/ies$/, 'y').replace(/(?<=[^s])s$/, ''));

export function createPhotos(dir) {
  async function search(query) {
    const url = `${API}?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=6`
      + '&prop=pageimages|description&piprop=thumbnail|name&pithumbsize=800&pilicense=free';
    const res = await politeFetch(url, 10000);
    if (!res.ok) throw new Error(`Wikipedia returned ${res.status}`);
    const data = await res.json();
    return Object.values((data.query && data.query.pages) || {}).sort((a, b) => a.index - b.index);
  }

  // The best free photo for a dish name, or null when nothing on Wikipedia is clearly that dish.
  // Photos in `used` (other dishes on this menu) count for less, so similar dishes vary when they can.
  async function lookup(name, skip = [], used = []) {
    const base = name.replace(/\([^)]*\)/g, ' ').split('/')[0].replace(/\s+/g, ' ').trim();
    const dishWords = words(base).filter((w) => !GENERIC.has(w));
    const queries = [...new Set([base, dishWords.join(' ')])].filter(Boolean);
    let best = null;
    for (const q of queries) {
      for (const page of await search(q)) {
        if (!page.thumbnail || !page.pageimage || skip.includes(page.pageimage)) continue;
        const desc = page.description || '';
        if (NOT_A_DISH.test(desc) || !FOOD.test(desc)) continue;
        // The last word usually says what the dish is ("… Biryani"), so it counts most.
        const title = words(page.title);
        const overlap = dishWords.reduce((n, w, i) => n + (title.includes(w) ? (i === dishWords.length - 1 ? 2 : 1) : 0), 0);
        if (!overlap) continue;
        // A photo of another main ingredient (chicken for a paneer dish) is the wrong dish.
        const clash = title.some((w) => MAIN.has(w) && !dishWords.includes(w)) ? 3 : 0;
        const score = overlap - clash - page.index * 0.1 - (used.includes(page.pageimage) ? 1.5 : 0);
        if (!best || score > best.score) best = { score, page };
      }
    }
    return best && best.page;
  }

  async function download(url) {
    const res = await politeFetch(url, 20000);
    const type = (res.headers.get('content-type') || '').split(';')[0];
    if (!res.ok || !MIME[type]) throw new Error(`Image download failed (${res.status} ${type})`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > 4 * 1024 * 1024) throw new Error('Image too large');
    const file = createHash('sha1').update(url).digest('hex').slice(0, 20) + MIME[type];
    mkdirSync(dir, { recursive: true });
    if (!existsSync(path.join(dir, file))) writeFileSync(path.join(dir, file), body);
    return file;
  }

  // Returns { img, credit, source } for a dish, or null. `skip` lists photos already rejected for it.
  async function find(name, { skip = [], used = [] } = {}) {
    const page = await lookup(name, skip, used);
    if (!page) return null;
    const file = await download(page.thumbnail.source);
    return { img: '/media/' + file, credit: `https://en.wikipedia.org/wiki/File:${encodeURIComponent(page.pageimage)}`, source: page.pageimage };
  }

  // Photos for several dishes, one at a time to stay within Wikimedia's limits. Calls onPhoto(dish,
  // photo or null) as each one is ready; errors for one dish don't stop the rest.
  async function findAll(dishes, onPhoto) {
    const used = [];
    for (const d of dishes) {
      let photo = null;
      try { photo = await find(d.name, { used }); } catch (e) { console.error(`[photos] ${d.name}: ${e.message}`); }
      if (photo) used.push(photo.source);
      onPhoto(d, photo);
      await pause(400);
    }
  }

  return { find, findAll };
}
