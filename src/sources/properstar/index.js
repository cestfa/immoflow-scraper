/**
 * Properstar source.
 *
 * Properstar search pages expose server-rendered listing cards with the key
 * rent fields already visible in the card markup.
 * Target URLs are read from PROPERSTAR_URLS (comma-separated) in .env.
 */

'use strict';

const path = require('path');

const SOURCE_ID = 'properstar';
const SOURCE_CONST = 'PROPERSTAR';
const ID_PREFIX = 'PROPERSTAR_';
const DEFAULT_TARGET_URL = 'https://www.properstar.ch/suisse/lausanne/louer/appartement-maison/plus-recents?price.max=1700';

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

  const raw = env.PROPERSTAR_URLS;
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

function parseHighlights(highlightsText) {
  const text = String(highlightsText || '').trim();

  return {
    property_type: text ? text.split('•').map((part) => part.trim()).filter(Boolean)[0] || null : null,
    rooms: (() => {
      const roomMatch = text.match(/(\d+(?:[.,]\d+)?)\s*p(?:ce|ces|i[eè]ce|i[eè]ces)\b/i)
        || text.match(/(\d+(?:[.,]\d+)?)\s*chambre(?:s)?\b/i);

      return roomMatch ? toFloatOrNull(roomMatch[1]) : null;
    })(),
    living_space_m2: (() => {
      const surfaceMatch = text.match(/(\d+(?:[.,]\d+)?)\s*m²\b/i);
      return surfaceMatch ? toFloatOrNull(surfaceMatch[1]) : null;
    })(),
    available_from: null,
  };
}

function parseLocation(locationText) {
  const text = String(locationText || '').trim();
  const result = {
    street: null,
    street_number: null,
    zip_code: null,
    city: null,
  };

  if (!text) return result;

  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  const streetKeywords = /^(rue|chemin|avenue|route|boulevard|place|impasse|quai|all[ée]e|sentier|promenade|mont[ée]e|passage|clos|d[ée]tour|dr\.|av\.)\b/i;

  let streetPart = null;
  let cityPart = null;

  if (parts.length === 1) {
    if (/lausanne/i.test(parts[0])) {
      result.city = parts[0];
    } else {
      streetPart = parts[0];
    }
  } else {
    const first = parts[0];
    const last = parts[parts.length - 1];
    const firstLooksStreet = /\d/.test(first) || streetKeywords.test(first);
    const lastLooksStreet = /\d/.test(last) || streetKeywords.test(last);

    if (firstLooksStreet && !lastLooksStreet) {
      streetPart = first;
      cityPart = last;
    } else if (!firstLooksStreet && lastLooksStreet) {
      cityPart = first;
      streetPart = last;
    } else if (/lausanne/i.test(first) && !/lausanne/i.test(last)) {
      cityPart = first;
      streetPart = last;
    } else if (/lausanne/i.test(last) && !/lausanne/i.test(first)) {
      streetPart = first;
      cityPart = last;
    } else {
      streetPart = first;
      cityPart = last;
    }
  }

  if (cityPart) {
    result.city = cityPart;
  }

  if (streetPart) {
    const streetMatch = String(streetPart).match(/^(.*?)(?:\s+(\d+[a-zA-Z]?))?$/);
    result.street = streetMatch ? streetMatch[1].trim() || null : streetPart;
    result.street_number = streetMatch && streetMatch[2] ? streetMatch[2].trim() : null;
  }

  return result;
}

function absolutizeUrl(url) {
  const value = String(url || '').trim();
  if (!value) return null;

  try {
    return new URL(value, 'https://www.properstar.ch').toString();
  } catch (_) {
    return null;
  }
}

async function beforeExtract(page, { sourceLabel } = {}) {
  const waitTimeoutMs = 20_000;

  try {
    await page.waitForFunction(
      () => {
        const hasListingLinks = document.querySelectorAll('a[href*="/annonce/"]').length > 0;
        if (hasListingLinks) return true;

        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        return scripts.some((script) => /"@type"\s*:\s*"ItemList"/.test(String(script.textContent || '')));
      },
      { timeout: waitTimeoutMs },
    );
  } catch (_) {
    const label = sourceLabel || `[${SOURCE_ID.toUpperCase()}]`;
    console.log(`⚠️  ${label} Listing signals not detected within ${waitTimeoutMs}ms; continuing`);
  }
}

async function extractListings(page) {
  const rawListings = await page.evaluate(() => {
    const listings = [];

    const textOrNull = (element) => {
      const value = element?.textContent?.trim() || '';
      return value || null;
    };

    const pickSrcFromSrcset = (srcset) => {
      const value = String(srcset || '').trim();
      if (!value) return null;
      const firstCandidate = value.split(',')[0]?.trim() || '';
      return firstCandidate.split(/\s+/)[0] || null;
    };

    const absolutizeUrl = (url) => {
      const value = String(url || '').trim();
      if (!value) return null;

      try {
        return new URL(value, 'https://www.properstar.ch').toString();
      } catch (_) {
        return null;
      }
    };

    const stableListingIdFromUrl = (url) => {
      const value = String(url || '').trim();
      if (!value) return null;

      const match = value.match(/\/annonce\/(\d+)/);
      return match ? match[1] : null;
    };

    const parseJsonLdListings = () => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const parsedListings = [];

      scripts.forEach((script) => {
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
            const rawId = stableListingIdFromUrl(item.url) || String(entry.position || '').trim() || null;

            parsedListings.push({
              rawId,
              url: item.url || null,
              price_text: item?.offers?.price !== undefined && item?.offers?.price !== null
                ? `${item.offers.price} CHF`
                : null,
              title_text: item.name || null,
              location_text: [address.addressLocality, address.streetAddress].filter(Boolean).join(', ') || null,
              highlights_text: null,
              image_urls: Array.isArray(item.image)
                ? item.image.map((src) => absolutizeUrl(src)).filter(Boolean)
                : [absolutizeUrl(item.image)].filter(Boolean),
              street: address.streetAddress || null,
              street_number: null,
              zip_code: address.postalCode || null,
              city: address.addressLocality || null,
              property_type: item.mainEntity?.['@type'] || item['@type'] || null,
              rooms: item.mainEntity?.numberOfBedrooms ?? null,
              living_space_m2: null,
              available_from: item.datePosted || null,
            });
          });
        });
      });

      return parsedListings;
    };

    const jsonLdListings = parseJsonLdListings();
    if (jsonLdListings.length) return jsonLdListings;

    const cards = Array.from(document.querySelectorAll('article'));

    cards.forEach((article) => {
      const titleLink = article.querySelector('a.listing-title[href*="/annonce/"]')
        || Array.from(article.querySelectorAll('a[href*="/annonce/"]')).find((link) => textOrNull(link));

      const href = titleLink?.getAttribute('href') || titleLink?.href || '';
      const rawIdMatch = href.match(/\/annonce\/(\d+)/);
      if (!rawIdMatch) return;

      const priceText = textOrNull(article.querySelector('.listing-price-main span'));
      const titleText = textOrNull(article.querySelector('.listing-title'));
      const locationText = textOrNull(article.querySelector('.item-location'));
      const highlightsText = textOrNull(article.querySelector('.item-highlights'));

      const imageUrls = Array.from(article.querySelectorAll('.item-picture picture img, .item-picture picture source[srcset]'))
        .map((element) => {
          if (element.tagName.toLowerCase() === 'source') {
            return pickSrcFromSrcset(element.getAttribute('srcset'));
          }

          return element.currentSrc || element.src || element.getAttribute('src') || null;
        })
        .filter(Boolean);

      listings.push({
        rawId: rawIdMatch[1],
        url: href,
        price_text: priceText,
        title_text: titleText,
        location_text: locationText,
        highlights_text: highlightsText,
        image_urls: Array.from(new Set(imageUrls)),
      });
    });

    return listings;
  });

  return rawListings.map((item) => {
    const highlightParts = parseHighlights(item.highlights_text);
    const locationParts = parseLocation(item.location_text || item.title_text);
    const listingTitle = item.title_text && item.title_text !== item.location_text ? item.title_text : null;
    const rawId = item.rawId || (item.url ? String(item.url).match(/\/annonce\/(\d+)/)?.[1] : null);

    return {
      id: `${ID_PREFIX}${rawId}`,
      source: SOURCE_CONST,
      url: absolutizeUrl(item.url) || 'none',
      address_raw: [item.price_text, item.title_text, item.location_text, item.highlights_text].filter(Boolean).join(' | '),
      image_urls: (item.image_urls || []).map(absolutizeUrl).filter(Boolean),
      title: listingTitle,
      description: null,
      price: item.price_text ? toIntOrNull(item.price_text) : null,
      currency: 'CHF',
      price_period: 'month',
      rooms: item.rooms ?? highlightParts.rooms,
      living_space_m2: item.living_space_m2 ?? highlightParts.living_space_m2,
      floor: null,
      total_floors: null,
      street: item.street ?? locationParts.street,
      street_number: item.street_number ?? locationParts.street_number,
      zip_code: item.zip_code ?? locationParts.zip_code,
      city: item.city ?? locationParts.city,
      country_code: 'CH',
      latitude: null,
      longitude: null,
      listing_type: 'rent',
      property_type: item.property_type ?? highlightParts.property_type,
      available_from: item.available_from ?? highlightParts.available_from,
    };
  });
}

module.exports = {
  id: SOURCE_ID,
  name: 'Properstar',
  loginRequired: false,
  loginUrl: null,
  initialDelayMs: 2500,
  scrollDelayMs: 1000,
  scrollDistance: 900,
  scrollTargetPreference: 'document',
  beforeExtract,
  normalizeTargetUrl,
  getTargets,
  extractListings,
  fixtures: {
    sampleHtmlPath: path.resolve(__dirname, '../../../data/properstar/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/properstar/sample.expected.json'),
  },
};