/**
 * Régie Braun source.
 *
 * Lausanne rental search results expose structured cards with type, address,
 * location, rooms, surface, availability, price, images, and optional geo data.
 * Target URLs are read from REGIE_BRAUN_URLS (comma-separated) in .env.
 */

'use strict';

const path = require('path');
const { extractPrice } = require('../../core/price-utils');

const SOURCE_ID = 'regie-braun';
const SOURCE_CONST = 'REGIE_BRAUN';
const ID_PREFIX = 'REGIE_BRAUN_';
const DEFAULT_TARGET_URL = 'https://www.regiebraun.ch/louer/';

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

  const raw = env.REGIE_BRAUN_URLS;
  if (!raw) return [DEFAULT_TARGET_URL];

  return raw.split(',').map((url) => url.trim()).filter(Boolean);
}

function parseNumericText(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const normalized = text.replace(/'/g, '').replace(/\s+/g, '').replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAvailableFrom(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const match = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) return null;

  const [, day, month, year] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).toISOString().slice(0, 10);
}

function extractListingsFromDocument() {
  const results = [];
  const cards = Array.from(document.querySelectorAll('a.card-location[href]'));

  const parseStreetParts = (value) => {
    const text = String(value || '').trim();
    if (!text) {
      return { street: null, street_number: null };
    }

    const match = text.match(/^(.*?)(?:\s+(\d+[a-zA-Z]?))?$/);
    return {
      street: match ? match[1].trim() || null : text,
      street_number: match && match[2] ? match[2].trim() : null,
    };
  };

  const absolutizeUrl = (src) => {
    if (!src) return '';
    try {
      return new URL(src, 'https://www.regiebraun.ch').toString();
    } catch (_) {
      return src;
    }
  };

  const text = (node) => String(node?.textContent || '').replace(/\s+/g, ' ').trim();

  cards.forEach((card) => {
    try {
      const href = card.getAttribute('href') || card.href || '';
      const idMatch = href.match(/_([^_/?]+)$/);
      if (!idMatch) return;

      const rawId = idMatch[1];
      const titleNode = card.querySelector('.card-title');
      const locationNode = card.querySelector('.__location');
      const priceNode = card.querySelector('.__price-tag');
      const detailNodes = Array.from(card.querySelectorAll('.__details > div'));
      const tagTypeNode = card.querySelector('.__tag-type');
      const geoRaw = card.getAttribute('data-geoloc');

      const imageUrls = Array.from(card.querySelectorAll('img'))
        .map((img) => img.getAttribute('src') || img.getAttribute('data-src') || img.currentSrc || img.src || '')
        .map(absolutizeUrl)
        .filter(Boolean);

      const detailTexts = detailNodes.map((node) => text(node)).filter(Boolean);
      const roomsText = detailTexts.find((value) => /pcs?/i.test(value)) || '';
      const surfaceText = detailTexts.find((value) => /m\s?2|m²/i.test(value)) || '';
      const availableText = detailTexts.find((value) => /\d{2}\.\d{2}\.\d{4}/.test(value)) || '';

      const title = text(titleNode);
      const location = text(locationNode).replace(/^.*?\s+/, '').trim();
      const addressParts = parseStreetParts(title);
      const geo = geoRaw ? JSON.parse(geoRaw) : null;

      results.push({
        rawId,
        url: href.startsWith('/') ? `https://www.regiebraun.ch${href}` : href,
        address_raw: text(card),
        image_urls: [...new Set(imageUrls)],
        title,
        property_type: text(tagTypeNode) || null,
        location_raw: location,
        price: text(priceNode),
        rooms: roomsText,
        living_space_m2: surfaceText,
        available_from_text: availableText,
        street: addressParts.street,
        street_number: addressParts.street_number,
        latitude: geo && Number.isFinite(geo.lat) ? geo.lat : null,
        longitude: geo && Number.isFinite(geo.lng) ? geo.lng : null,
      });
    } catch (_) {}
  });

  return results;
}

async function extractListings(page) {
  await page.waitForSelector('a.card-location[href]', { timeout: 15000 });
  const raw = await page.evaluate(extractListingsFromDocument);

  return raw.map((item) => ({
    id: `${ID_PREFIX}${item.rawId}`,
    source: SOURCE_CONST,
    url: item.url,
    address_raw: item.address_raw,
    image_urls: item.image_urls || [],
    title: item.title || null,
    description: null,
    price: extractPrice(item.price),
    currency: 'CHF',
    price_period: 'month',
    rooms: parseNumericText(item.rooms),
    living_space_m2: parseNumericText(item.living_space_m2),
    floor: null,
    total_floors: null,
    street: item.street || null,
    street_number: item.street_number || null,
    zip_code: null,
    city: item.location_raw || null,
    country_code: 'CH',
    latitude: item.latitude,
    longitude: item.longitude,
    listing_type: 'rent',
    property_type: item.property_type,
    available_from: parseAvailableFrom(item.available_from_text),
  }));
}

module.exports = {
  id: SOURCE_ID,
  name: 'Régie Braun',
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
    sampleHtmlPath: path.resolve(__dirname, '../../../data/regie-braun/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/regie-braun/sample.expected.json'),
  },
};