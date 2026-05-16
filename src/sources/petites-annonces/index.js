/**
 * Petitesannonces.ch source.
 *
 * Search result pages expose regular listing rows with address, type, rooms,
 * surface, price, and date columns.
 * Target URLs are read from PETITES_ANNONCES_URLS (comma-separated) in .env.
 */

'use strict';

const path = require('path');
const { extractPrice } = require('../../core/price-utils');

const SOURCE_ID = 'petites-annonces';
const SOURCE_CONST = 'PETITES_ANNONCES';
const ID_PREFIX = 'PETITES_ANNONCES_';
const DEFAULT_TARGET_URL = 'https://www.petitesannonces.ch/recherche/?tid=2701&ot=0&ri=0&ra=0&pi=&pa=1700&si=&sa=&zi=&ci=Lausanne&st=&cy=0';

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

  const raw = env.PETITES_ANNONCES_URLS;
  if (!raw) return [DEFAULT_TARGET_URL];

  return raw.split(',').map((url) => url.trim()).filter(Boolean);
}

function parseAddressParts(addressRaw) {
  const value = String(addressRaw || '').trim();
  if (!value) {
    return {
      zip_code: null,
      city: null,
      street: null,
      street_number: null,
    };
  }

  const match = value.match(/^(\d{4})\s+([^,]+?)(?:,\s*(.+))?$/);
  if (!match) {
    return {
      zip_code: null,
      city: null,
      street: null,
      street_number: null,
    };
  }

  const zip_code = match[1];
  const city = match[2].trim();
  const streetRaw = (match[3] || '').trim();

  if (!streetRaw) {
    return {
      zip_code,
      city,
      street: null,
      street_number: null,
    };
  }

  const streetMatch = streetRaw.match(/^(.*?)(?:\s+(\d+[a-zA-Z]?))?$/);
  const street = streetMatch ? streetMatch[1].trim() : streetRaw;
  const street_number = streetMatch && streetMatch[2] ? streetMatch[2].trim() : null;

  return {
    zip_code,
    city,
    street: street || null,
    street_number,
  };
}

function parseNumberText(value) {
  const text = String(value || '').trim();
  if (!text || text === '-') return null;

  const normalized = text.replace(/'/g, '').replace(/\s+/g, '').replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePriceText(value) {
  const text = String(value || '').trim();
  if (!text || text === '-') return null;

  const cleaned = text.replace(/[^\d']/g, '');
  if (!cleaned) return null;

  const parsed = Number.parseInt(cleaned.replace(/'/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractListingsFromDocument() {
  const results = [];
  const rows = Array.from(document.querySelectorAll('div.ele'));

  rows.forEach((row) => {
    try {
      const listingLink = Array.from(row.querySelectorAll('a[href^="/a/"]')).find((link) => /\d+/.test(link.getAttribute('href') || ''));
      if (!listingLink) return;

      const href = listingLink.getAttribute('href') || listingLink.href || '';
      const idMatch = href.match(/\/a\/(\d+)/);
      if (!idMatch) return;

      const rawId = idMatch[1];
      const children = Array.from(row.children || []);

      const addressNode = children[1] || row.querySelector('a[href^="/a/"]');
      const typeNode = children[2] || null;
      const roomsNode = children[3] || null;
      const surfaceNode = children[4] || null;
      const priceNode = children[5] || null;

      const addressRaw = addressNode ? (addressNode.innerText || addressNode.textContent || '').trim() : '';
      if (!addressRaw) return;

      const imageUrls = Array.from(row.querySelectorAll('img'))
        .map((img) => img.src || img.getAttribute('src') || '')
        .filter((src) => src && !src.startsWith('data:'))
        .map((src) => {
          try {
            return new URL(src, 'https://www.petitesannonces.ch').toString();
          } catch (_) {
            return src;
          }
        });

      results.push({
        rawId,
        url: href.startsWith('/') ? `https://www.petitesannonces.ch${href}` : href,
        address_raw: addressRaw,
        image_urls: [...new Set(imageUrls)],
        property_type: typeNode ? (typeNode.innerText || typeNode.textContent || '').trim() : '',
        rooms: roomsNode ? (roomsNode.innerText || roomsNode.textContent || '').trim() : '',
        living_space_m2: surfaceNode ? (surfaceNode.innerText || surfaceNode.textContent || '').trim() : '',
        price: priceNode ? (priceNode.innerText || priceNode.textContent || '').trim() : '',
      });
    } catch (_) {}
  });

  return results;
}

async function extractListings(page) {
  const raw = await page.evaluate(extractListingsFromDocument);

  return raw.map((item) => {
    const addressParts = parseAddressParts(item.address_raw);

    return {
      id: `${ID_PREFIX}${item.rawId}`,
      source: SOURCE_CONST,
      url: item.url,
      address_raw: item.address_raw,
      image_urls: item.image_urls || [],
      title: null,
      description: null,
      price: parsePriceText(item.price) ?? extractPrice(item.price),
      currency: 'CHF',
      price_period: 'month',
      rooms: parseNumberText(item.rooms),
      living_space_m2: parseNumberText(item.living_space_m2),
      floor: null,
      total_floors: null,
      street: addressParts.street,
      street_number: addressParts.street_number,
      zip_code: addressParts.zip_code,
      city: addressParts.city,
      country_code: 'CH',
      latitude: null,
      longitude: null,
      listing_type: 'rent',
      property_type: item.property_type || null,
      available_from: null,
    };
  });
}

module.exports = {
  id: SOURCE_ID,
  name: 'Petitesannonces.ch',
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
    sampleHtmlPath: path.resolve(__dirname, '../../../data/petites-annonces/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/petites-annonces/sample.expected.json'),
  },
};