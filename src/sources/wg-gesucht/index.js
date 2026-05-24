/**
 * WG-Gesucht Lausanne source.
 *
 * Public search results page for Lausanne rentals and flatshares.
 * Target URLs are read from WG_GESUCHT_URLS (comma-separated) in .env.
 */

const path = require('path');

const SOURCE_ID = 'wg-gesucht';
const SOURCE_CONST = 'WG_GESUCHT';
const ID_PREFIX = 'WG_GESUCHT_';
const DEFAULT_TARGET_URL = 'https://www.wg-gesucht.de/en/wg-zimmer-und-1-zimmer-wohnungen-und-wohnungen-und-haeuser-in-Lausanne.151.0+1+2+3.1.0.html?clear_filter=1';

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

  const raw = env.WG_GESUCHT_URLS;
  if (!raw) return [DEFAULT_TARGET_URL];

  return raw.split(',').map((url) => url.trim()).filter(Boolean);
}

function parseNumericText(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const normalized = text
    .replace(/[']/g, '')
    .replace(/\s+/g, '')
    .replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFloor(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const match = text.match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseRoomsFromHeader(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const match = text.match(/(\d+(?:[\.,]\d+)?)/);
  return match ? Number.parseFloat(match[1].replace(',', '.')) : null;
}

function extractListingsFromDocument() {
  const origin = 'https://www.wg-gesucht.de';

  const text = (node) => String(node?.textContent || '').replace(/\s+/g, ' ').trim();
  const absolutizeUrl = (src) => {
    if (!src) return '';
    try {
      return new URL(src, origin).toString();
    } catch (_) {
      return src;
    }
  };

  const parseRoomsFromText = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    const match = normalized.match(/(\d+(?:[\.,]\d+)?)/);
    return match ? Number.parseFloat(match[1].replace(',', '.')) : null;
  };

  const parseSurfaceFromText = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    const match = normalized.match(/(\d+(?:[\.,]\d+)?)\s*m(?:²|2)?/i);
    return match ? Number.parseFloat(match[1].replace(',', '.')) : null;
  };

  const stableListingIdFromUrl = (url) => {
    const value = String(url || '').trim();
    if (!value) return null;

    const numericMatch = value.match(/(?:-|\.)(\d{5,})(?:\.html)?(?:\?|$)/) || value.match(/\/(\d{5,})(?:\.html)?(?:\?|$)/);
    if (numericMatch) return numericMatch[1];

    try {
      const parsed = new URL(value);
      const slug = parsed.pathname
        .split('/')
        .filter(Boolean)
        .pop() || value;
      return slug
        .replace(/\.html$/i, '')
        .replace(/[^0-9A-Za-z._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || null;
    } catch (_) {
      return value
        .replace(/\.html$/i, '')
        .replace(/[^0-9A-Za-z._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || null;
    }
  };

  const parsePrice = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const normalized = String(value).replace(/[^\d.,]/g, '').replace(',', '.');
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  };
  const parseJsonLdItems = (rootDocument) => {
    const scriptNodes = Array.from(rootDocument.querySelectorAll('script[type="application/ld+json"]'));
    const items = [];

    scriptNodes.forEach((script) => {
      const raw = String(script.textContent || '').trim();
      if (!raw) return;

      let parsed = null;
      try {
        parsed = Function(`return (${raw.replace(/;\s*$/, '')})`)();
      } catch (_) {
        return;
      }

      const candidates = Array.isArray(parsed) ? parsed : [parsed];

      candidates.forEach((candidate) => {
        const list = candidate?.mainEntity?.itemListElement;
        if (!Array.isArray(list)) return;

        list.forEach((entry) => {
          const item = entry?.item;
          if (!item || typeof item !== 'object') return;

          const address = item?.mainEntity?.address || {};
          const imageValue = item.image;
          const imageUrls = Array.isArray(imageValue)
            ? imageValue.map((src) => absolutizeUrl(src)).filter(Boolean)
            : [absolutizeUrl(imageValue)].filter(Boolean);

          const description = String(item.description || '').trim();
          const title = String(item.name || '').trim() || null;
          const rooms = parseRoomsFromText(description) ?? parseRoomsFromText(title);
          const livingSpace = parseSurfaceFromText(title) ?? parseSurfaceFromText(description);
          const url = absolutizeUrl(item.url || '');
          const rawId = stableListingIdFromUrl(url) || stableListingIdFromUrl(title) || stableListingIdFromUrl(`${entry.position || ''}`);

          items.push({
            rawId,
            url,
            title,
            address_raw: [title, address.streetAddress, address.addressLocality, address.addressRegion].filter(Boolean).join(' | '),
            street: address.streetAddress || null,
            city: address.addressLocality || null,
            zip_code: address.postalCode || null,
            priceText: parsePrice(item?.offers?.price) || null,
            rooms,
            livingSpace,
            image_urls: imageUrls,
            property_type: item?.offers?.['@type'] || null,
            available_from: item.datePosted || null,
          });
        });
      });
    });

    return items;
  };

  const parseCards = (rootDocument) => {
    const cards = Array.from(rootDocument.querySelectorAll('article.box_object_item_userauth_selection, article.box_object_item'));
    const results = [];

    cards.forEach((card) => {
      try {
        const rawId = card.getAttribute('data-object-id') || '';
        const link = card.querySelector('a.box_inner_link[href], a[href*="/en/"]');
        const href = link?.getAttribute('href') || link?.href || '';
        if (!rawId && !href) return;

        const title = text(card.querySelector('.box_body h2')) || null;
        const locationText = text(card.querySelector('.caract_location .value')) || null;
        const priceText = text(card.querySelector('.caract_price .value')) || '';
        const surfaceText = text(card.querySelector('.caract_surface_living .value')) || text(card.querySelector('.surface_living .value')) || '';
        const roomsText = text(card.querySelector('.caract_rooms .value')) || '';
        const floorText = text(card.querySelector('.caract_floor .value')) || '';
        const cardText = text(card.querySelector('.box_body')) || text(card);

        const imageUrls = Array.from(card.querySelectorAll('img'))
          .map((img) => img.getAttribute('src') || img.currentSrc || '')
          .map(absolutizeUrl)
          .filter(Boolean);

        const rooms = parseNumericText(roomsText) ?? parseRoomsFromHeader(cardText);
        const livingSpace = parseNumericText(surfaceText);

        let street = null;
        let city = null;
        if (locationText) {
          const parts = locationText.split('|').map((part) => part.trim()).filter(Boolean);
          if (parts.length >= 2) {
            street = parts[0] || null;
            city = parts[parts.length - 1] || null;
          } else {
            const pieces = locationText.split(',').map((part) => part.trim()).filter(Boolean);
            street = pieces[0] || null;
            city = pieces[1] || null;
          }
        }

        results.push({
          rawId,
          url: absolutizeUrl(href),
          title,
          locationText,
          street,
          city,
          priceText,
          roomsText,
          floorText,
          livingSpace,
          rooms,
          image_urls: [...new Set(imageUrls)],
          address_raw: [title, locationText, priceText].filter(Boolean).join(' | '),
          property_type: title,
          statusText: cardText,
        });
      } catch (_) {}
    });

    return results;
  };

  try {
    const jsonLdItems = parseJsonLdItems(document);
    if (jsonLdItems.length) return jsonLdItems;
  } catch (_) {}

  try {
    const bodyText = text(document.body) || text(document.documentElement);
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed.list === 'string' && parsed.list.trim()) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(parsed.list, 'text/html');
      return parseCards(doc);
    }
  } catch (_) {}

  return parseCards(document);
}

async function extractListings(page) {
  const raw = await page.evaluate(extractListingsFromDocument);

  return raw.map((item) => ({
    id: `${ID_PREFIX}${item.rawId}`,
    source: SOURCE_CONST,
    url: item.url,
    address_raw: item.address_raw || item.locationText || item.city || item.title || '',
    image_urls: item.image_urls || [],
    title: item.title || null,
    description: null,
    price: item.priceText ?? null,
    currency: 'CHF',
    price_period: 'month',
    rooms: item.rooms,
    living_space_m2: item.livingSpace,
    floor: parseFloor(item.floorText),
    total_floors: null,
    street: item.street || null,
    street_number: null,
    zip_code: item.zip_code || null,
    city: item.city || null,
    country_code: 'CH',
    latitude: null,
    longitude: null,
    listing_type: 'rent',
    property_type: item.property_type || null,
    available_from: item.available_from ? String(item.available_from) : null,
  }));
}

module.exports = {
  id: SOURCE_ID,
  name: 'WG-Gesucht',
  loginRequired: false,
  loginUrl: null,
  scrollSafetyLimit: 8,
  scrollIdleRounds: 2,
  initialDelayMs: 2500,
  scrollDelayMs: 900,
  scrollDistance: 900,
  scrollTargetPreference: 'auto',
  normalizeTargetUrl,
  getTargets,
  extractListings,
  fixtures: {
    sampleHtmlPath: path.resolve(__dirname, '../../../data/wg-gesucht/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/wg-gesucht/sample.expected.json'),
  },
};
