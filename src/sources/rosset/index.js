/**
 * Rosset source.
 *
 * Lausanne rental search results.
 * Target URLs are read from ROSSET_URLS (comma-separated) in .env.
 */

const path = require('path');

const SOURCE_ID = 'rosset';
const SOURCE_CONST = 'ROSSET';
const ID_PREFIX = 'ROSSET_';
const DEFAULT_TARGET_URL = 'https://www.rosset.ch/louer?location=Lausanne&locationKind=city&types=appartement%2Cmaison';

function normalizeTargetUrl(url) {
  try {
    const normalized = new URL(url);
    normalized.hash = '';
    return normalized.toString();
  } catch (_) {
    return String(url).split('#')[0].split('?')[0];
  }
}

function getTargets({ urls = [], env = {} } = {}) {
  if (urls.length) return urls.filter(Boolean);

  const raw = env.ROSSET_URLS;
  if (!raw) return [DEFAULT_TARGET_URL];

  return raw.split(',').map((url) => url.trim()).filter(Boolean);
}

function parseNumericText(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const normalized = text.replace(/[’']/g, '').replace(/\s+/g, '').replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).replace(/[^\d.,]/g, '').replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function parseAvailableFrom(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const match = text.match(/^(\d{2})[-./](\d{2})[-./](\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    return `${year}-${month}-${day}`;
  }

  const isoMatch = text.match(/^(\d{4})[-./](\d{2})[-./](\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month}-${day}`;
  }

  return null;
}

function slugFromUrl(url) {
  const value = String(url || '').trim();
  if (!value) return null;

  try {
    const parsed = new URL(value, 'https://www.rosset.ch');
    const segments = parsed.pathname.split('/').filter(Boolean);
    const slug = segments[segments.length - 1] || segments[segments.length - 2] || value;
    return slug.replace(/\.html$/i, '').replace(/[^0-9A-Za-z._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || null;
  } catch (_) {
    return value.replace(/\.html$/i, '').replace(/[^0-9A-Za-z._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || null;
  }
}

function decodeNextJsString(encoded) {
  const once = JSON.parse(`"${String(encoded || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return once.replace(/\\"/g, '"');
}

function parseRossetListingsFromHtml(html) {
  const matches = Array.from(String(html || '').matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\);?/g));

  const parseObjectsFromDecodedPayload = (decoded) => {
    const marker = '"properties":[';
    const start = decoded.indexOf(marker);
    if (start === -1) return [];

    let index = start + marker.length;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let currentStart = null;
    const objects = [];

    for (; index < decoded.length; index += 1) {
      const char = decoded[index];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') {
        if (depth === 0) currentStart = index;
        depth += 1;
        continue;
      }

      if (char === '}') {
        depth -= 1;
        if (depth === 0 && currentStart !== null) {
          const slice = decoded.slice(currentStart, index + 1);
          try {
            objects.push(JSON.parse(slice));
          } catch (_) {}
          currentStart = null;
        }
        continue;
      }

      if (char === ']' && depth === 0) break;
    }

    return objects;
  };

  const parseFloorFromText = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    const floorMatch = normalized.match(/(\d+(?:er|e|ème)?\s+étage|rez-de-chaussée)/i);
    return floorMatch ? floorMatch[1] : null;
  };

  for (const match of matches) {
    const decoded = decodeNextJsString(match[1]);
    if (!decoded.includes('"priceRaw"') || !decoded.includes('"properties"')) continue;

    const items = parseObjectsFromDecodedPayload(decoded);
    if (!items.length) continue;

    return items.map((item) => {
      const url = item.uri ? `https://www.rosset.ch/${String(item.uri).replace(/^\//, '')}` : (item.href ? `https://www.rosset.ch/${String(item.href).replace(/^\//, '')}` : '');
      const rawId = slugFromUrl(url) || slugFromUrl(item.slug) || slugFromUrl(item.id);
      const addressParts = String(item.address || '').split(',').map((part) => part.trim()).filter(Boolean);
      const city = item.city || (addressParts.length ? addressParts[0] : null) || null;

      return {
        rawId,
        url,
        title: item.location || null,
        address_raw: [item.location, item.description, item.address].filter(Boolean).join(' | '),
        image_urls: Array.isArray(item.images) ? item.images.filter(Boolean) : [],
        price_text: item.priceRaw ?? item.price ?? null,
        rooms_text: item.roomsRaw ?? item.rooms ?? null,
        surface_text: item.surface ?? null,
        floor_text: parseFloorFromText(item.location),
        street: addressParts.length ? addressParts[addressParts.length - 1] : null,
        zip_code: addressParts.find((part) => /^\d{4}$/.test(part)) || null,
        city,
        latitude: typeof item.lat === 'number' ? item.lat : null,
        longitude: typeof item.lng === 'number' ? item.lng : null,
        property_type: item.propertyType ? String(item.propertyType).charAt(0).toUpperCase() + String(item.propertyType).slice(1) : null,
        available_from: parseAvailableFrom(item.availabilityDate),
      };
    }).filter((item) => item.rawId);
  }

  return [];
}

async function extractListings(page) {
  const html = await page.content();
  const raw = parseRossetListingsFromHtml(html);

  return raw.map((item) => ({
    id: `${ID_PREFIX}${item.rawId}`,
    source: SOURCE_CONST,
    url: item.url,
    address_raw: item.address_raw || item.title || '',
    image_urls: item.image_urls || [],
    title: item.title || null,
    description: null,
    price: parsePrice(item.price_text),
    currency: 'CHF',
    price_period: 'month',
    rooms: parseNumericText(item.rooms_text),
    living_space_m2: parseNumericText(item.surface_text),
    floor: item.floor_text || null,
    total_floors: null,
    street: item.street || null,
    street_number: null,
    zip_code: item.zip_code || null,
    city: item.city || null,
    country_code: 'CH',
    latitude: item.latitude,
    longitude: item.longitude,
    listing_type: 'rent',
    property_type: item.property_type || null,
    available_from: item.available_from || null,
  }));
}

module.exports = {
  id: SOURCE_ID,
  name: 'Rosset',
  loginRequired: false,
  loginUrl: null,
  maxScrolls: 25,
  initialDelayMs: 2500,
  scrollDelayMs: 1200,
  scrollDistance: 900,
  normalizeTargetUrl,
  getTargets,
  extractListings,
  fixtures: {
    sampleHtmlPath: path.resolve(__dirname, '../../../data/rosset/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/rosset/sample.expected.json'),
  },
};
