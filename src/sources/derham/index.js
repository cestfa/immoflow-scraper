/**
 * Derham source.
 *
 * Lausanne rental search cards expose postal code, city, price, property type,
 * room count, and living area. Target URLs come from DERHAM_URLS.
 */

'use strict';

const path = require('path');
const { extractPrice } = require('../../core/price-utils');

const SOURCE_ID = 'derham';
const SOURCE_CONST = 'DERHAM';
const ID_PREFIX = 'DERHAM_';
const DEFAULT_TARGET_URL = 'https://www.derham.ch/fr/louer?field_geofield_proximity%5Bvalue%5D=0&field_geofield_proximity%5Bsource_configuration%5D%5Borigin_address%5D=Lausanne&field_property_type_target_id=17&field_total_price%5Bmin%5D=&field_total_price%5Bmax%5D=1750&field_part_number%5Bmin%5D=&field_part_number%5Bmax%5D=&field_living_area%5Bmin%5D=&field_living_area%5Bmax%5D=&sort_by=field_total_price_value_desc';

function normalizeTargetUrl(url) {
  try {
    const normalized = new URL(url);
    normalized.hash = '';
    return normalized.toString();
  } catch (_) {
    return String(url).split('#')[0];
  }
}

function getTargets({ urls = [], env = {} } = {}) {
  if (urls.length) return urls.filter(Boolean);

  const raw = env.DERHAM_URLS;
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

function extractListingsFromDocument() {
  const results = [];
  const seen = new Set();

  const text = (node) => String(node?.textContent || '').replace(/\s+/g, ' ').trim();

  const cards = Array.from(document.querySelectorAll('a[href^="/fr/louer/"]')).filter((anchor) => {
    const value = text(anchor);
    return /CHF/i.test(value) && /pièces?/i.test(value);
  });

  cards.forEach((card) => {
    try {
      const href = card.getAttribute('href') || card.href || '';
      const match = href.match(/\/fr\/louer\/([^/?#]+)/);
      if (!match) return;

      const rawId = match[1];
      if (seen.has(rawId)) return;
      seen.add(rawId);

      const postalMatch = text(card).match(/\b(\d{4})\s+([^\n]+?)\s+CHF/i);
      const priceNode = card.querySelector('.field--name-field-total-price') || null;
      const propertyTypeNode = Array.from(card.querySelectorAll('.property-info-sec-common span')).find((node) => {
        const value = text(node).toLowerCase();
        return value === 'appartement' || value === 'maison' || value === 'immeuble' || value === 'local commercial';
      }) || null;
      const parts = Array.from(card.querySelectorAll('.property-info-sec-common span')).map((node) => text(node)).filter(Boolean);
      const roomText = parts.find((value) => /pièces?/i.test(value)) || '';
      const areaText = parts.find((value) => /m²?/i.test(value) || /m2/i.test(value)) || '';

      const addressRaw = postalMatch ? `${postalMatch[1]} ${postalMatch[2]}` : text(card);

      results.push({
        rawId,
        url: href.startsWith('/') ? `https://www.derham.ch${href}` : href,
        address_raw: addressRaw,
        title: null,
        property_type: text(propertyTypeNode) || null,
        location_raw: postalMatch ? postalMatch[2].trim() : null,
        postal_code: postalMatch ? postalMatch[1] : null,
        price: text(priceNode),
        rooms: roomText,
        living_space_m2: areaText,
      });
    } catch (_) {}
  });

  return results;
}

async function extractListings(page) {
  await page.waitForSelector('a[href^="/fr/louer/"] .property-info-sec-common, a[href^="/fr/louer/"] .field--name-field-total-price', { timeout: 15000 });
  const raw = await page.evaluate(extractListingsFromDocument);

  return raw.map((item) => ({
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
    rooms: parseNumericText(item.rooms),
    living_space_m2: parseNumericText(item.living_space_m2),
    floor: null,
    total_floors: null,
    street: null,
    street_number: null,
    zip_code: item.postal_code || null,
    city: item.location_raw || null,
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
  name: 'Derham',
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
    sampleHtmlPath: path.resolve(__dirname, '../../../data/derham/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/derham/sample.expected.json'),
  },
};