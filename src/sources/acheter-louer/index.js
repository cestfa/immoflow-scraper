/**
 * Acheter-Louer source.
 *
 * Lausanne rental search results are server-rendered cards with stable detail
 * links and the key rental fields already visible in the card text.
 * Target URLs are read from ACHETER_LOUER_URLS (comma-separated) in .env.
 */

'use strict';

const path = require('path');

const SOURCE_ID = 'acheter-louer';
const SOURCE_CONST = 'ACHETER_LOUER';
const ID_PREFIX = 'ACHETER_LOUER_';
const DEFAULT_TARGET_URL = 'https://www.acheter-louer.ch/?t=2&page=result&tri=&triSens=&dist=6&commune=554&region=&bounds=&area=&npa=&p=&communeName=Lausanne&type_1=1&prixMax=1700&surfaceMin=&surfaceMax=&pieceMin=&pieceMax=&ns=';

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

  const raw = env.ACHETER_LOUER_URLS;
  if (!raw) return [DEFAULT_TARGET_URL];

  return raw.split(',').map((url) => url.trim()).filter(Boolean);
}

function toIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAddress(locationText) {
  const text = String(locationText || '').trim();
  const result = {
    street: null,
    street_number: null,
    zip_code: null,
    city: null,
  };

  if (!text) return result;

  const match = text.match(/^(\d{4})\s+([^\-]+?)(?:\s+-\s+(.*))?$/);

  if (!match) {
    result.city = text.includes('Lausanne') ? 'Lausanne' : null;
    return result;
  }

  result.zip_code = match[1];
  result.city = match[2].trim() || null;

  const streetRaw = String(match[3] || '').trim();
  if (!streetRaw) return result;

  const streetMatch = streetRaw.match(/^(.*)\s+(\d+[a-zA-Z]*)$/);

  if (streetMatch && !/\d/.test(streetMatch[1])) {
    result.street = streetMatch[1].trim() || null;
    result.street_number = streetMatch[2].trim();
    return result;
  }

  result.street = streetRaw;
  result.street_number = null;

  return result;
}

function parseListingText(rawText) {
  const lines = String(rawText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const priceLine = lines.find((line) => /CHF|CHF\.|’|'/i.test(line) || /\d[\d'\s.–-]*\.?$/.test(line));
  const roomLine = lines.find((line) => /pi[eè]ce|m2|m²/i.test(line)) || '';
  const surfaceLine = lines.find((line) => /^\d+(?:[.,]\d+)?\s*m(?:²|2)\b/i.test(line)) || '';
  const typeLine = lines.find((line) => /à louer/i.test(line)) || null;
  const locationLine = lines.find((line) => /^\d{4}\s+/.test(line)) || null;
  const descriptionLines = locationLine ? lines.slice(lines.indexOf(locationLine) + 1) : [];

  const priceMatch = priceLine && priceLine.match(/([\d'\s]+)\s*[.–-]*/);
  const roomMatch = roomLine.match(/(\d+(?:[.,]\d+)?)\s*pi[eè]ce/i);
  const surfaceMatch = surfaceLine.match(/(\d+(?:[.,]\d+)?)\s*m(?:²|2)\b/i) || roomLine.match(/(\d+(?:[.,]\d+)?)\s*m(?:²|2)\b/i);

  return {
    price: priceMatch ? toIntOrNull(priceMatch[1]) : null,
    rooms: roomMatch ? Number.parseFloat(roomMatch[1].replace(',', '.')) : null,
    living_space_m2: surfaceMatch ? Number.parseFloat(surfaceMatch[1].replace(',', '.')) : null,
    property_type: typeLine && /appartement/i.test(typeLine) ? 'apartment' : typeLine && /maison/i.test(typeLine) ? 'house' : null,
    title: typeLine,
    locationLine,
    description: descriptionLines.join(' ').trim() || null,
  };
}

function absolutizeUrl(url) {
  const value = String(url || '').trim();
  if (!value) return null;

  try {
    return new URL(value, 'https://www.acheter-louer.ch').toString();
  } catch (_) {
    return null;
  }
}

async function extractListings(page) {
  const rawListings = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('a[href*="/fr/location-immobilier/"]'));
    const seen = new Set();
    const results = [];

    cards.forEach((anchor) => {
      const href = anchor.getAttribute('href') || anchor.href || '';
      if (!href || seen.has(href)) return;

      const priceText = anchor.querySelector('.price span')?.textContent?.trim() || '';
      const roomNumber = anchor.querySelector('.rooms span:first-child')?.textContent?.trim() || '';
      const roomUnit = anchor.querySelector('.rooms span.text-lowercase')?.textContent?.trim() || '';
      const surfaceNumber = anchor.querySelector('.surface span:first-child')?.textContent?.trim() || '';
      const surfaceUnit = anchor.querySelector('.surface span:last-child')?.textContent?.trim() || '';
      const badgeText = anchor.querySelector('#area-video .btn.btn-danger')?.textContent?.trim() || '';
      const titleEl = anchor.querySelector('h2.vign-title');
      const titleText = titleEl?.childNodes?.[0]?.textContent?.trim() || '';
      const locationSuffix = anchor.querySelector('h2.vign-title span')?.textContent?.trim() || '';
      const locationLine = [titleEl ? titleEl.querySelector('br') ? (titleEl.childNodes?.[2]?.textContent || '').trim() : '' : '', locationSuffix]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const descriptionNode = anchor.querySelector('.vign-desc');
      const descriptionText = descriptionNode
        ? Array.from(descriptionNode.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
        : '';

      const cardRoot = anchor.closest('.pos-rel.vignette') || anchor.parentElement?.parentElement?.parentElement || anchor.parentElement;
      const imageUrl = cardRoot?.querySelector('.pos-rel.imgObj img.img-responsive')?.getAttribute('src')
        || cardRoot?.querySelector('.pos-rel.imgObj img.img-responsive')?.src
        || null;

      const text = [
        priceText,
        [roomNumber, roomUnit].filter(Boolean).join(' '),
        [surfaceNumber, surfaceUnit].filter(Boolean).join(' '),
        badgeText ? badgeText.toUpperCase() : '',
        titleText,
        locationLine,
        descriptionText,
      ].filter(Boolean).join('\n');

      if (!text || !/Lausanne/i.test(text)) return;

      seen.add(href);

      results.push({
        href,
        text,
        image_url: imageUrl,
      });
    });

    return results;
  });

  return rawListings.map((item) => {
    const parsed = parseListingText(item.text);
    const address = parseAddress(parsed.locationLine);

    const idMatch = item.href.match(/-(\d+)\.html(?:$|\?)/);
    const rawId = idMatch ? idMatch[1] : item.href.replace(/[^\dA-Za-z]/g, '').slice(-24);

    return {
      id: `${ID_PREFIX}${rawId}`,
      source: SOURCE_CONST,
      url: absolutizeUrl(item.href) || 'none',
      address_raw: item.text,
      image_urls: item.image_url ? [absolutizeUrl(item.image_url)].filter(Boolean) : [],
      title: parsed.title,
      description: parsed.description,
      price: parsed.price,
      currency: 'CHF',
      price_period: 'month',
      rooms: parsed.rooms,
      living_space_m2: parsed.living_space_m2,
      floor: null,
      total_floors: null,
      street: address.street,
      street_number: address.street_number,
      zip_code: address.zip_code,
      city: address.city || 'Lausanne',
      country_code: 'CH',
      latitude: null,
      longitude: null,
      listing_type: 'rent',
      property_type: parsed.property_type,
      available_from: null,
    };
  });
}

module.exports = {
  id: SOURCE_ID,
  name: 'Acheter-Louer',
  loginRequired: false,
  loginUrl: null,
  initialDelayMs: 2500,
  scrollDelayMs: 1000,
  scrollDistance: 900,
  scrollTargetPreference: 'document',
  normalizeTargetUrl,
  getTargets,
  extractListings,
  fixtures: {
    sampleHtmlPath: path.resolve(__dirname, '../../../data/acheter-louer/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/acheter-louer/sample.expected.json'),
  },
};