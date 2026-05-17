/**
 * Appartel source.
 *
 * Lausanne search results render as simple listing cards with title, type,
 * location, price, and duration text. Target URLs are read from APPARTEL_URLS.
 */

'use strict';

const path = require('path');
const { extractPrice } = require('../../core/price-utils');

const SOURCE_ID = 'appartel';
const SOURCE_CONST = 'APPARTEL';
const ID_PREFIX = 'APPARTEL_';
const DEFAULT_TARGET_URL = 'https://appartel.ch/annonces?ville=Lausanne&prixMax=2000&lat=46.520714&lng=6.632528';

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

  const raw = env.APPARTEL_URLS;
  if (!raw) return [DEFAULT_TARGET_URL];

  return raw.split(',').map((url) => url.trim()).filter(Boolean);
}

function parseLocation(value) {
  const text = String(value || '').trim();
  if (!text) return { city: null, street: null, street_number: null };

  const [cityPart] = text.split(',');
  return {
    city: cityPart ? cityPart.trim() || null : null,
    street: null,
    street_number: null,
  };
}

function parseDuration(value) {
  const text = String(value || '').trim();
  if (!text || /immédiatement/i.test(text) || /par consentement/i.test(text)) return null;
  return null;
}

function extractListingsFromDocument() {
  const results = [];
  const seen = new Set();

  const text = (node) => String(node?.textContent || '').replace(/\s+/g, ' ').trim();

  // FIX: Iterate over the listing card containers, NOT the inner links.
  const cards = Array.from(document.querySelectorAll('main .group.bg-card'));

  cards.forEach((card) => {
    try {
      const link = card.querySelector('a[href^="/annonces/"]');
      if (!link) return;

      const href = link.getAttribute('href') || link.href || '';
      const match = href.match(/\/annonces\/([0-9a-f-]{8,})/i);
      if (!match) return;

      const rawId = match[1];
      if (seen.has(rawId)) return;
      seen.add(rawId);

      // Extract text content
      const titleNode = card.querySelector('h3');
      const typeNode = titleNode ? titleNode.nextElementSibling : null;
      
      const mapPinIcon = card.querySelector('svg.lucide-map-pin');
      const locationNode = mapPinIcon ? mapPinIcon.nextElementSibling : null;
      
      const priceNode = card.querySelector('.text-2xl.font-bold');
      const periodNode = priceNode ? priceNode.nextElementSibling : null;
      
      const priceContainer = priceNode ? priceNode.parentElement : null;
      const extraNode = priceContainer ? priceContainer.nextElementSibling : null;

      // FIX: Extract images
      const imgNodes = Array.from(card.querySelectorAll('img'));
      const image_urls = imgNodes.map(img => img.src || img.getAttribute('src')).filter(Boolean);

      results.push({
        rawId,
        url: href.startsWith('/') ? `https://appartel.ch${href}` : href,
        address_raw: [text(titleNode), text(locationNode)].filter(Boolean).join(' | '),
        title: text(titleNode),
        property_type: text(typeNode) || null,
        location_raw: text(locationNode),
        price: priceNode ? `${text(priceNode)} ${text(periodNode)}`.trim() : '',
        availability_text: text(extraNode),
        image_urls: image_urls
      });
    } catch (_) {}
  });

  return results;
}

async function extractListings(page) {
  try {
    await page.getByRole('button', { name: 'Accepter' }).click({ timeout: 2000 });
  } catch (_) {}

  // Appartel renders listings client-side after a delayed fetch, so wait for
  // the card containers themselves rather than a visible heading.
  try {
    await page.waitForSelector('main .group.bg-card', { timeout: 30000, state: 'attached' });
  } catch (_) {
    return [];
  }

  const raw = await page.evaluate(extractListingsFromDocument);

  return raw.map((item) => {
    const locationParts = parseLocation(item.location_raw);

    return {
      id: `${ID_PREFIX}${item.rawId}`,
      source: SOURCE_CONST,
      url: item.url,
      address_raw: item.address_raw,
      image_urls: item.image_urls || [], // FIX: Passed through image URLs instead of a hardcoded []
      title: item.title || null,
      description: null,
      price: extractPrice(item.price),
      currency: 'CHF',
      price_period: 'month',
      rooms: null,
      living_space_m2: null,
      floor: null,
      total_floors: null,
      street: locationParts.street,
      street_number: locationParts.street_number,
      zip_code: null,
      city: locationParts.city,
      country_code: 'CH',
      latitude: null,
      longitude: null,
      listing_type: 'rent',
      property_type: item.property_type || null,
      available_from: parseDuration(item.availability_text),
    };
  });
}

module.exports = {
  id: SOURCE_ID,
  name: 'Appartel',
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
    sampleHtmlPath: path.resolve(__dirname, '../../../data/appartel/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/appartel/sample.expected.json'),
  },
};