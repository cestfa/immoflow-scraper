/**
 * Dreamo source.
 *
 * Lausanne rental search results are rendered as object cards with stable
 * `data-object-id` values, inline image URLs, and structured price / room /
 * surface / address fields in the card body.
 * Target URLs are read from DREAMO_URLS (comma-separated) in .env.
 */

'use strict';

const path = require('path');

const SOURCE_ID = 'dreamo';
const SOURCE_CONST = 'DREAMO';
const ID_PREFIX = 'DREAMO_';
const DEFAULT_TARGET_URL = 'https://www.dreamo.ch/fr/recherche/location/lausanne?post=1&page=1&sort=ba&deal=RENT&location=l4%2B0&radius_to=0&category%5B%5D=28%2C73%2C17%2C18%2C16%2C74%2C19%2C25%2C80%2C24%2C21%2C188%2C27%2C26%2C103%2C184%2C81%2C104%2C22%2C215%2C216%2C217%2C218&category%5B%5D=36%2C29%2C30%2C32%2C189%2C105%2C83%2C98%2C75%2C106%2C107%2C76%2C108%2C109%2C31%2C82%2C34%2C110%2C111%2C79%2C35%2C95%2C33%2C99%2C87%2C96%2C91%2C89%2C84%2C112%2C90%2C182%2C100%2C97%2C192%2C213%2C219%2C220%2C85&price_to_rent=1700&price_to=1700&style=horizontal';

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

  const raw = env.DREAMO_URLS;
  if (!raw) return [DEFAULT_TARGET_URL];

  return raw.split(',').map((url) => url.trim()).filter(Boolean);
}

function toIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFloatOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseFloat(String(value).replace(/'/g, '').replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAddress(addressRaw) {
  const text = String(addressRaw || '').trim();
  const result = {
    street: null,
    street_number: null,
    zip_code: null,
    city: null,
  };

  if (!text) return result;

  const match = text.match(/^(\d{4})\s+(.+?)(?:,\s*(.+))?$/);
  if (!match) {
    result.city = text.includes('Lausanne') ? 'Lausanne' : null;
    return result;
  }

  result.zip_code = match[1];
  result.city = match[2].trim() || null;

  const streetRaw = String(match[3] || '').trim();
  if (!streetRaw) return result;

  const streetMatch = streetRaw.match(/^(.*?)(?:\s+(\d+[a-zA-Z]?))?$/);
  result.street = streetMatch ? streetMatch[1].trim() || null : streetRaw;
  result.street_number = streetMatch && streetMatch[2] ? streetMatch[2].trim() : null;
  return result;
}

function parseListingCard(card) {
  const text = (card.innerText || '').replace(/\r/g, '').trim();
  const image = card.querySelector('.box_picture img.box_picture.only_pic, .box_picture img[src], img[src]');
  const href = card.querySelector('a.box_inner_link[href]')?.getAttribute('href') || card.querySelector('a[href*="/fr/o/"]')?.getAttribute('href') || '';
  const dataObjectId = card.getAttribute('data-object-id') || href.match(/-(\d+)$/)?.[1] || null;

  const priceLine = card.querySelector('.price span')?.textContent?.trim() || text.split('\n').find((line) => /CHF|\/mois|\+\s*ch\./i.test(line)) || '';
  const roomsLine = card.querySelector('.rooms .value_wrapper, .rooms')?.textContent?.trim() || text.split('\n').find((line) => /pi[eè]ces?/i.test(line)) || '';
  const surfaceLine = card.querySelector('.square_meters .value_wrapper, .square_meters')?.textContent?.trim() || text.split('\n').find((line) => /m²|m2/i.test(line)) || '';
  const addressLine = card.querySelector('.adress')?.textContent?.trim() || text.split('\n').find((line) => /Lausanne/i.test(line) && /\d{4}/.test(line)) || '';
  const title = card.querySelector('.title')?.textContent?.trim() || card.querySelector('.object_category')?.textContent?.trim() || null;
  const description = card.querySelector('.description')?.textContent?.trim() || null;
  const availability = card.querySelector('.value_wrapper .value')?.textContent?.trim() || null;

  const roomMatch = roomsLine.match(/(\d+(?:[.,]\d+)?)\s*pi[eè]ce/i);
  const surfaceMatch = surfaceLine.match(/(\d+(?:[.,]\d+)?)\s*m(?:²|2)\b/i);
  const priceMatch = priceLine.match(/([\d'\s]+)\s*(?:\.-|\.|-)?/);

  const imageUrl = image?.getAttribute('src') || image?.getAttribute('data-src') || null;

  return {
    rawId: dataObjectId,
    url: href,
    image_url: imageUrl,
    address_raw: [title, roomsLine, surfaceLine, priceLine, addressLine, description].filter(Boolean).join('\n'),
    title,
    description,
    price: priceMatch ? toIntOrNull(priceMatch[1]) : null,
    rooms: roomMatch ? toFloatOrNull(roomMatch[1]) : null,
    living_space_m2: surfaceMatch ? toFloatOrNull(surfaceMatch[1]) : null,
    addressLine,
    availability,
  };
}

async function extractListings(page) {
  const raw = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('article.box.box_object_item.box_object_item_objects_search'));
    const seen = new Set();
    const results = [];

    cards.forEach((card) => {
      const parsed = (function parseListingCardFromBrowser(cardEl) {
        const text = (cardEl.innerText || '').replace(/\r/g, '').trim();
        const image = cardEl.querySelector('.box_picture img.box_picture.only_pic, .box_picture img[src], img[src]');
        const href = cardEl.querySelector('a.box_inner_link[href]')?.getAttribute('href') || cardEl.querySelector('a[href*="/fr/o/"]')?.getAttribute('href') || '';
        const dataObjectId = cardEl.getAttribute('data-object-id') || (href.match(/-(\d+)$/) || [])[1] || null;
        if (!dataObjectId || seen.has(dataObjectId)) return null;

        const priceLine = cardEl.querySelector('.price span')?.textContent?.trim() || text.split('\n').find((line) => /CHF|\/mois|\+\s*ch\./i.test(line)) || '';
        const roomsLine = cardEl.querySelector('.rooms .value_wrapper, .rooms')?.textContent?.trim() || text.split('\n').find((line) => /pi[eè]ces?/i.test(line)) || '';
        const surfaceLine = cardEl.querySelector('.square_meters .value_wrapper, .square_meters')?.textContent?.trim() || text.split('\n').find((line) => /m²|m2/i.test(line)) || '';
        const addressLine = cardEl.querySelector('.adress')?.textContent?.trim() || text.split('\n').find((line) => /Lausanne/i.test(line) && /\d{4}/.test(line)) || '';
        const title = cardEl.querySelector('.title')?.textContent?.trim() || cardEl.querySelector('.object_category')?.textContent?.trim() || null;
        const description = cardEl.querySelector('.description')?.textContent?.trim() || null;
        const availability = Array.from(cardEl.querySelectorAll('.value_wrapper .value')).map((el) => (el.textContent || '').trim()).find((value) => /^\d{2}\.\d{2}\.\d{4}$|^Imm[eé]diatement$/i.test(value)) || null;

        const roomMatch = roomsLine.match(/(\d+(?:[.,]\d+)?)\s*pi[eè]ce/i);
        const surfaceMatch = surfaceLine.match(/(\d+(?:[.,]\d+)?)\s*m(?:²|2)\b/i);
        const priceMatch = priceLine.match(/([\d'\s]+)\s*(?:\.-|\.|-)?/);
        const imageUrl = image?.getAttribute('src') || image?.getAttribute('data-src') || null;

        seen.add(dataObjectId);

        return {
          rawId: dataObjectId,
          url: href,
          image_url: imageUrl,
          address_raw: [title, roomsLine, surfaceLine, priceLine, addressLine, description].filter(Boolean).join('\n'),
          title,
          description,
          price: priceMatch ? parseInt(priceMatch[1].replace(/[^\d]/g, ''), 10) : null,
          rooms: roomMatch ? Number.parseFloat(roomMatch[1].replace(',', '.')) : null,
          living_space_m2: surfaceMatch ? Number.parseFloat(surfaceMatch[1].replace(',', '.')) : null,
          addressLine,
          availability,
        };
      })(card);

      if (parsed) results.push(parsed);
    });

    return results;
  });

  return raw.map((item) => {
    const addressParts = parseAddress(item.addressLine);
    const propertyType = /maison/i.test(item.title || '') ? 'house' : /appartement/i.test(item.title || '') ? 'apartment' : null;

    return {
      id: `${ID_PREFIX}${item.rawId}`,
      source: SOURCE_CONST,
      url: item.url ? new URL(item.url, 'https://www.dreamo.ch').toString() : 'none',
      address_raw: item.address_raw,
      image_urls: item.image_url ? [new URL(item.image_url, 'https://www.dreamo.ch').toString()] : [],
      title: item.title,
      description: item.description,
      price: item.price,
      currency: 'CHF',
      price_period: 'month',
      rooms: item.rooms,
      living_space_m2: item.living_space_m2,
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
      property_type: propertyType,
      available_from: item.availability && /^\d{2}\.\d{2}\.\d{4}$/.test(item.availability) ? item.availability.split('.').reverse().join('-') : null,
    };
  });
}

module.exports = {
  id: SOURCE_ID,
  name: 'Dreamo',
  loginRequired: false,
  loginUrl: null,
  initialDelayMs: 3000,
  scrollDelayMs: 1200,
  scrollDistance: 900,
  scrollTargetPreference: 'document',
  normalizeTargetUrl,
  getTargets,
  extractListings,
  fixtures: {
    sampleHtmlPath: path.resolve(__dirname, '../../../data/dreamo/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/dreamo/sample.expected.json'),
  },
};