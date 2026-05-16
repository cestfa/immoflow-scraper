/**
 * myHOMIES source.
 *
 * Lausanne colocation search results render as Bubble cards with price,
 * surface, postal code, city, availability, and a canonical flatshare slug.
 * Target URLs are read from MYHOMIES_URLS (comma-separated) in .env.
 */

'use strict';

const path = require('path');
const { extractPrice } = require('../../core/price-utils');

const SOURCE_ID = 'myhomies';
const SOURCE_CONST = 'MYHOMIES';
const ID_PREFIX = 'MYHOMIES_';
const DEFAULT_TARGET_URL = 'https://fr.myhomies.ch/discover/Lausanne-flatshare';

function normalizeTargetUrl(url) {
  try {
    const normalized = new URL(url);
    normalized.search = '';
    normalized.hash = '';
    return normalized.toString();
  } catch (_) {
    return String(url).split('?')[0].split('#')[0];
  }
}

function getTargets({ urls = [], env = {} } = {}) {
  if (urls.length) return urls.filter(Boolean);

  const raw = env.MYHOMIES_URLS;
  if (!raw) return [DEFAULT_TARGET_URL];

  return raw.split(',').map((url) => url.trim()).filter(Boolean);
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseAvailableFrom(value) {
  const text = String(value || '').trim();
  const match = text.match(/Disponible à partir du (\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;

  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function parseSurface(value) {
  const text = String(value || '').trim();
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
  if (!match) return null;

  const parsed = Number.parseFloat(match[1].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLocation(value) {
  const text = String(value || '').trim();
  if (!text) {
    return { zip_code: null, city: null };
  }

  const match = text.match(/-\s*(.*?)\s*,\s*(.+)$/);
  if (!match) return { zip_code: null, city: null };

  const zipCode = match[1] ? match[1].trim() : '';
  const city = match[2] ? match[2].trim() : '';

  return {
    zip_code: zipCode || null,
    city: city || null,
  };
}

function extractListingsFromDocument() {
  const normalizeText = (node) => String(node?.textContent || '').replace(/\s+/g, ' ').trim();
  const parseImageUrl = (node) => {
    const style = node?.getAttribute('style') || '';
    const match = style.match(/background-image:\s*url\(["']?(.*?)["']?\)/i);
    return match ? match[1] : '';
  };
  const cards = Array.from(document.querySelectorAll('#filter-listing .group-item'));
  const results = [];
  const seen = new Set();

  cards.forEach((card) => {
    try {
      const text = String(card.innerText || '').trim();
      if (!/CHF par mois/i.test(text)) return;

      const entryMatch = (card.className || '').match(/\bentry-(\d+)\b/);
      const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const priceText = lines.find((line) => /CHF par mois/i.test(line)) || '';
      const locationText = lines.find((line) => /m²/i.test(line) && /-/.test(line)) || '';
      const availabilityText = lines.find((line) => /Disponible à partir du/i.test(line)) || '';
      const badgeText = lines.find((line) => /Top listed|Nouveau/i.test(line)) || '';

      const imageNode = card.querySelector('[style*="background-image"]');
      const imageUrl = parseImageUrl(imageNode);
      const rawId = entryMatch ? `entry-${entryMatch[1]}` : null;

      if (!rawId && seen.has(text)) return;
      if (rawId) seen.add(rawId); else seen.add(text);

      results.push({
        rawId,
        url: null,
        address_raw: normalizeText(card),
        image_urls: imageUrl ? [imageUrl] : [],
        badge: badgeText || null,
        description: null,
        price_text: priceText,
        location_text: locationText,
        available_from_text: availabilityText,
      });
    } catch (_) {}
  });

  return results;
}

async function extractListings(page) {
  await page.waitForSelector('#filter-listing .group-item', { timeout: 15000 });

    const domRaw = await page.evaluate(extractListingsFromDocument);
    // domRaw collected from page

  // Also attempt Bubble client DB extraction (live-only). We'll score both
  // sources and pick the one returning more entries with a parseable price.
    const bubbleRaw = await page.evaluate(() => {
    try {
      const rows = Array.from(document.querySelectorAll('#filter-listing .group-item'));
      const out = [];
      rows.forEach((card) => {
        try {
          const row = card.querySelector('.clickable-element') || card;
          const ds = row?.bubble_data?.bubble_instance?._watchers?.data_source?.value;
          if (!ds || !ds.db || !ds.id) return;
          const obj = ds.db.get(ds.id);
          const safe = (k) => {
            try {
              const v = obj.get(k);
              if (v == null) return '';
              if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
              if (typeof v === 'object') {
                // If it's a DBNode-like object with .get(), try common scalar fields
                if (typeof v.get === 'function') {
                  const keys = ['text', 'url', 'src', 'file', 'image_url', 'value', 'name', 'label'];
                  for (let i = 0; i < keys.length; i++) {
                    try {
                      const vv = v.get(keys[i]);
                      if (vv != null) return String(vv);
                    } catch (e) {}
                  }
                }
                if (v.url) return v.url;
                if (v[0] && v[0].url) return v[0].url;
                if (Array.isArray(v) && v.length && typeof v[0] === 'string') return v[0];
                if (typeof v.toString === 'function') return v.toString();
              }
              return String(v);
            } catch (e) {
              return '';
            }
          };
          out.push({
            rawId: String(ds.id),
            url: row?.querySelector('a')?.href || '',
            price_text: safe('monthly_cost_number') || safe('price') || '',
            title: safe('listing_title_text') || safe('title') || '',
            location_text: safe('location_geographic_address') || '',
            availability_text: safe('available_from_date') || safe('available_from') || '',
            image: safe('cover_image_image') || '',
          });
        } catch (e) {}
      });
      return out;
    } catch (e) {
      return [];
    }
  });

  // bubbleRaw collected from page

  const normalizeDom = (items) => items.map((item) => ({
    id: `${ID_PREFIX}${item.rawId}`,
    source: SOURCE_CONST,
    url: item.url,
    address_raw: item.address_raw,
    image_urls: item.image_urls || [],
    title: item.badge || null,
    description: item.description,
    price: extractPrice(item.price_text),
    currency: 'CHF',
    price_period: 'month',
    rooms: null,
    living_space_m2: item.surface_m2 ?? null,
    floor: null,
    total_floors: null,
    street: null,
    street_number: null,
    zip_code: item.zip_code || null,
    city: item.city || null,
    country_code: 'CH',
    latitude: null,
    longitude: null,
    listing_type: 'share',
    property_type: 'colocation',
    available_from: parseAvailableFrom(item.available_from_text),
  }));

  // Recompute location and ids for DOM results using Node helpers
  const domPost = normalizeDom(Array.isArray(domRaw) ? domRaw : []).map((it, idx) => {
    const original = (Array.isArray(domRaw) ? domRaw : [])[idx] || {};
    const { zip_code, city } = parseLocation(original.location_text || '');
    const surface_m2 = parseSurface(original.location_text || '');
    const rawId = original.rawId || slugify([city, original.price_text, original.location_text, (original.image_urls||[])[0]].filter(Boolean).join('-')) || `dom-${idx}`;
    return Object.assign({}, it, {
      id: `${ID_PREFIX}${rawId}`,
      zip_code: zip_code || null,
      city: city || null,
      living_space_m2: surface_m2 ?? null,
    });
  });

  const normalizeBubble = (items) => items.map((item) => ({
    id: `${ID_PREFIX}${item.rawId}`,
    source: SOURCE_CONST,
    url: item.url || DEFAULT_TARGET_URL,
    address_raw: item.title || '',
    image_urls: item.image ? [item.image] : [],
    title: item.title || null,
    description: null,
    price: extractPrice(item.price_text || ''),
    currency: 'CHF',
    price_period: 'month',
    rooms: null,
    living_space_m2: null,
    floor: null,
    total_floors: null,
    street: null,
    street_number: null,
    zip_code: null,
    city: null,
    country_code: 'CH',
    latitude: null,
    longitude: null,
    listing_type: 'share',
    property_type: 'colocation',
    available_from: parseAvailableFrom(item.availability_text || ''),
  }));

  const cleaned = (list) => list.filter((it) => {
    if (!it) return false;
    // Drop DBNode placeholders that appear when Bubble objects serialize oddly
    const suspect = (v) => typeof v === 'string' && v.startsWith('DBNode<');
    if (suspect(it.title) || suspect(it.address_raw) || (it.price == null)) return false;
    return true;
  });

  const domNorm = domPost;
  const bubbleNorm = normalizeBubble(Array.isArray(bubbleRaw) ? bubbleRaw : []);

  const domGood = cleaned(domNorm);
  const bubbleGood = cleaned(bubbleNorm);

  // Prefer the set with more priced listings; tie -> prefer DOM
  const chosen = (domGood.length >= bubbleGood.length) ? domGood : bubbleGood;

  return chosen;
}

module.exports = {
  id: SOURCE_ID,
  name: 'myHOMIES',
  loginRequired: false,
  loginUrl: null,
  scrollSafetyLimit: 20,
  scrollIdleRounds: 3,
  initialDelayMs: 2500,
  scrollDelayMs: 1000,
  scrollDistance: 900,
  scrollTargetPreference: 'auto',
  normalizeTargetUrl,
  getTargets,
  extractListings,
  fixtures: {
    sampleHtmlPath: path.resolve(__dirname, '../../../data/myhomies/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/myhomies/sample.expected.json'),
  },
};