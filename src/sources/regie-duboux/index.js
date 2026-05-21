/**
 * Regie Duboux source.
 *
 * Search requests can return either full HTML pages or an AJAX JSON payload
 * where the `list` field contains listing-card HTML.
 * Target URLs are read from REGIE_DUBOUX_URLS (comma-separated) in .env.
 */

'use strict';

const path = require('path');
const { extractPrice } = require('../../core/price-utils');

const SOURCE_ID = 'regie-duboux';
const SOURCE_CONST = 'REGIE_DUBOUX';
const ID_PREFIX = 'REGIE_DUBOUX_';
const DEFAULT_TARGET_URL = 'https://location.regieduboux.ch/fr/a/o/search?page_size=24&pagination_type=manual_ajax&from=ol%2C19315&post=1&deal=rent&sort=id&category%5B%5D=28%2C73%2C17%2C18%2C16%2C74%2C19%2C25%2C80%2C24%2C21%2C188%2C27%2C26%2C103%2C184%2C81%2C104%2C22&category%5B%5D=36%2C29%2C30%2C32%2C189%2C105%2C83%2C98%2C75%2C106%2C107%2C76%2C108%2C109%2C31%2C82%2C34%2C110%2C111%2C79%2C35%2C95%2C33%2C99%2C87%2C96%2C91%2C89%2C84%2C112%2C90%2C182%2C100%2C97%2C192%2C213%2C219%2C220&category%5B%5D=215%2C216%2C217%2C218&location=l122257%2B5&radius_to=5&price_to=2000&style=thumbnail&load=list_total&total=true';

function normalizeTargetUrl(url) {
  try {
    const normalized = new URL(url);
    normalized.search = '';
    return normalized.toString();
  } catch (_) {
    return String(url).split('?')[0];
  }
}

function getTargets({ urls = [], env = {} } = {}) {
  if (urls.length) return urls.filter(Boolean);

  const raw = env.REGIE_DUBOUX_URLS;
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

function extractListingsFromDocument() {
  const origin = 'https://location.regieduboux.ch';

  const text = (node) => String(node?.textContent || '').replace(/\s+/g, ' ').trim();

  const absolutizeUrl = (src) => {
    if (!src) return '';
    try {
      return new URL(src, origin).toString();
    } catch (_) {
      return src;
    }
  };

  const parseCards = (rootDocument) => {
    const cards = Array.from(rootDocument.querySelectorAll('article.box_object_item'));
    const results = [];

    cards.forEach((card) => {
      try {
        const dataId = card.getAttribute('data-object-id') || '';
        const link = card.querySelector('a.box_inner_link[href]');
        const href = link?.getAttribute('href') || link?.href || '';
        const idMatch = href.match(/-(\d+)(?:\?|$)/);
        const rawId = dataId || (idMatch ? idMatch[1] : '');
        if (!rawId) return;

        const imageUrls = Array.from(card.querySelectorAll('.box_picture img'))
          .map((img) => img.getAttribute('src') || img.currentSrc || '')
          .map(absolutizeUrl)
          .filter(Boolean);

        const title = text(card.querySelector('.box_body h2')) || null;
        const city = text(card.querySelector('.caract_location .value')) || null;
        const priceText = text(card.querySelector('.caract_price .value'));
        const surfaceText = text(card.querySelector('.caract_surface_living .value'));
        const roomsText = text(card.querySelector('.caract_rooms .value'));
        const floorText = text(card.querySelector('.caract_floor .value'));
        const detailsText = text(card.querySelector('.caract_list')) || text(card);

        results.push({
          rawId,
          url: absolutizeUrl(href),
          image_urls: [...new Set(imageUrls)],
          title,
          city,
          price_text: priceText,
          living_space_m2_text: surfaceText,
          rooms_text: roomsText,
          floor_text: floorText,
          address_raw: detailsText,
          property_type: title,
        });
      } catch (_) {}
    });

    return results;
  };

  const bodyText = text(document.body) || text(document.documentElement);
  try {
    const payload = JSON.parse(bodyText);
    if (payload && typeof payload.list === 'string' && payload.list.trim()) {
      const parser = new DOMParser();
      const parsed = parser.parseFromString(payload.list, 'text/html');
      return parseCards(parsed);
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
    address_raw: item.address_raw || item.city || item.title || '',
    image_urls: item.image_urls || [],
    title: item.title || null,
    description: null,
    price: extractPrice(item.price_text),
    currency: 'CHF',
    price_period: 'month',
    rooms: parseNumericText(item.rooms_text),
    living_space_m2: parseNumericText(item.living_space_m2_text),
    floor: parseFloor(item.floor_text),
    total_floors: null,
    street: null,
    street_number: null,
    zip_code: null,
    city: item.city || null,
    country_code: 'CH',
    latitude: null,
    longitude: null,
    listing_type: 'rent',
    property_type: item.property_type || null,
    available_from: null,
  }));
}

module.exports = {
  id: SOURCE_ID,
  name: 'Regie Duboux',
  loginRequired: false,
  loginUrl: null,
  scrollSafetyLimit: 8,
  scrollIdleRounds: 2,
  initialDelayMs: 2000,
  scrollDelayMs: 800,
  scrollDistance: 900,
  scrollTargetPreference: 'auto',
  normalizeTargetUrl,
  getTargets,
  extractListings,
  fixtures: {
    sampleHtmlPath: path.resolve(__dirname, '../../../data/regie-duboux/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/regie-duboux/sample.expected.json'),
  },
};
