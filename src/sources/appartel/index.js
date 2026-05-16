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

  const cards = Array.from(document.querySelectorAll('main a[href^="/annonces/"]'));

  cards.forEach((card) => {
    try {
      const href = card.getAttribute('href') || card.href || '';
      const match = href.match(/\/annonces\/([0-9a-f-]{8,})/i);
      if (!match) return;

      const rawId = match[1];
      if (seen.has(rawId)) return;
      seen.add(rawId);

      const titleNode = card.querySelector('h3');
      const typeNode = Array.from(card.querySelectorAll('div, span')).find((node) => {
        const label = text(node);
        return label === 'chambre' || label === 'appartement';
      }) || null;

      const locationNode = Array.from(card.querySelectorAll('span, div')).find((node) => /Vd$/i.test(text(node))) || null;
      const priceNode = card.querySelector('.text-2xl.font-bold') || null;
      const periodNode = Array.from(card.querySelectorAll('span')).find((node) => /\/mois/i.test(text(node))) || null;
      const extraNode = Array.from(card.querySelectorAll('span')).find((node) => {
        const value = text(node);
        return value && value !== text(priceNode) && value !== text(periodNode) && !/Vd$/i.test(value);
      }) || null;

      results.push({
        rawId,
        url: href.startsWith('/') ? `https://appartel.ch${href}` : href,
        address_raw: [text(titleNode), text(locationNode)].filter(Boolean).join(' | '),
        title: text(titleNode),
        property_type: text(typeNode) || null,
        location_raw: text(locationNode),
        price: priceNode ? `${text(priceNode)} ${text(periodNode)}`.trim() : '',
        availability_text: text(extraNode),
      });
    } catch (_) {}
  });

  return results;
}

async function extractListings(page) {
  try {
    await page.getByRole('button', { name: 'Accepter' }).click({ timeout: 2000 });
  } catch (_) {}

  await page.waitForSelector('main a[href^="/annonces/"] h3', { timeout: 15000 });
  const raw = await page.evaluate(extractListingsFromDocument);

  return raw.map((item) => {
    const locationParts = parseLocation(item.location_raw);

    return {
      id: `${ID_PREFIX}${item.rawId}`,
      source: SOURCE_CONST,
      url: item.url,
      address_raw: item.address_raw,
      image_urls: [],
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