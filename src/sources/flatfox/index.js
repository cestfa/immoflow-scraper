/**
 * Flatfox source.
 *
 * Flatfox search pages are backed by public Flatfox APIs. We query those APIs
 * directly using the active search filters instead of depending on fragile DOM
 * card selectors.
 * Target URLs are read from FLATFOX_URLS (comma-separated) in .env.
 */

'use strict';

const path = require('path');

const SOURCE_ID = 'flatfox';
const SOURCE_CONST = 'FLATFOX';
const ID_PREFIX = 'FLATFOX_';
const DEFAULT_TARGET_URL = 'https://flatfox.ch/fr/search/?east=6.727412&max_price=1750&north=46.591715&object_category=APARTMENT&object_category=HOUSE&object_category=SHARED&offer_type=RENT&place_name=Lausanne%2C%20canton%20de%20Vaud%2C%20Suisse&place_type=place&query=Lausanne&south=46.454875&take=48&west=6.553590';
const PIN_API_URL = 'https://flatfox.ch/api/v1/pin/';
const PUBLIC_LISTING_API_URL = 'https://flatfox.ch/api/v1/public-listing/';
const PUBLIC_LISTING_INCLUDES = ['is_liked', 'is_disliked', 'is_subscribed'];

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

  const raw = env.FLATFOX_URLS;
  if (!raw) return [DEFAULT_TARGET_URL];

  return raw.split(',').map((url) => url.trim()).filter(Boolean);
}

function toIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePropertyType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'apartment') return 'apartment';
  if (text === 'house') return 'house';
  if (text === 'shared') return 'shared';
  return text;
}

function normalizeListingType(offerType, objectCategory) {
  const offer = String(offerType || '').trim().toUpperCase();
  const objectType = String(objectCategory || '').trim().toUpperCase();

  if (offer === 'RENT' && objectType === 'SHARED') return 'share';
  if (offer === 'RENT') return 'rent';
  if (offer === 'BUY') return 'buy';
  return 'unknown';
}

function parseTargetUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return {
      url: parsed,
      maxPrice: toIntOrNull(parsed.searchParams.get('max_price')),
      objectCategories: parsed.searchParams.getAll('object_category').filter(Boolean),
      offerType: (parsed.searchParams.get('offer_type') || 'RENT').trim().toUpperCase(),
      take: toIntOrNull(parsed.searchParams.get('take')),
      locale: parsed.pathname.split('/').filter(Boolean)[0] || 'fr',
    };
  } catch (_) {
    return {
      url: new URL(DEFAULT_TARGET_URL),
      maxPrice: 1750,
      objectCategories: ['APARTMENT', 'HOUSE', 'SHARED'],
      offerType: 'RENT',
      take: 48,
      locale: 'fr',
    };
  }
}

function buildPinApiUrl(targetUrl, selectionPk) {
  const parsed = parseTargetUrl(targetUrl);
  const pinUrl = new URL(PIN_API_URL);

  if (parsed.url.searchParams.get('east')) pinUrl.searchParams.set('east', parsed.url.searchParams.get('east'));
  if (parsed.url.searchParams.get('west')) pinUrl.searchParams.set('west', parsed.url.searchParams.get('west'));
  if (parsed.url.searchParams.get('north')) pinUrl.searchParams.set('north', parsed.url.searchParams.get('north'));
  if (parsed.url.searchParams.get('south')) pinUrl.searchParams.set('south', parsed.url.searchParams.get('south'));

  pinUrl.searchParams.set('max_count', String(parsed.take || 400));

  if (parsed.maxPrice !== null) pinUrl.searchParams.set('max_price', String(parsed.maxPrice));
  if (parsed.offerType) pinUrl.searchParams.set('offer_type', parsed.offerType);

  for (const category of parsed.objectCategories) {
    pinUrl.searchParams.append('object_category', category);
  }

  if (selectionPk) pinUrl.searchParams.set('selection', String(selectionPk));

  return pinUrl.toString();
}

function buildPublicListingApiUrl(pks) {
  const apiUrl = new URL(PUBLIC_LISTING_API_URL);
  apiUrl.searchParams.set('expand', 'cover_image');

  for (const include of PUBLIC_LISTING_INCLUDES) {
    apiUrl.searchParams.append('include', include);
  }

  apiUrl.searchParams.set('limit', '0');

  for (const pk of pks) {
    apiUrl.searchParams.append('pk', String(pk));
  }

  return apiUrl.toString();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Flatfox API request failed with status ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  return response.json();
}

async function readSearchContext(page) {
  const targetUrl = /^https?:/i.test(page.url()) ? page.url() : DEFAULT_TARGET_URL;

  const domContext = await page.evaluate(() => {
    const searchRoot = document.querySelector('[data-selection-pk]');
    return {
      selectionPk: searchRoot?.getAttribute('data-selection-pk') || null,
      detailTemplate: searchRoot?.getAttribute('data-url-template-listing-detail') || null,
    };
  });

  return {
    targetUrl,
    selectionPk: domContext.selectionPk || null,
    detailTemplate: domContext.detailTemplate || `/${parseTargetUrl(targetUrl).locale}/listing/__pk__/`,
  };
}

function toAbsoluteImageUrl(url) {
  const value = String(url || '').trim();
  if (!value) return null;

  try {
    return new URL(value, 'https://flatfox.ch').toString();
  } catch (_) {
    return null;
  }
}

function buildListingUrlPath(row, locale, detailTemplate) {
  const candidateUrl = String(row.url || '').trim();

  if (candidateUrl) {
    try {
      const parsed = new URL(candidateUrl, 'https://flatfox.ch');
      const segments = parsed.pathname.split('/').filter(Boolean);

      if (segments.length) {
        segments[0] = locale;
        return `/${segments.join('/')}/`;
      }

      return parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
    } catch (_) {
      const normalizedPath = candidateUrl.startsWith('/') ? candidateUrl : `/${candidateUrl}`;
      return normalizedPath.endsWith('/') ? normalizedPath : `${normalizedPath}/`;
    }
  }

  const slug = String(row.slug || '').trim();
  const listingPk = row.pk ?? row.id;

  if (slug && listingPk !== null && listingPk !== undefined) {
    return `/${locale}/flat/${slug}/${listingPk}/`;
  }

  if (detailTemplate && listingPk !== null && listingPk !== undefined) {
    return String(detailTemplate).replace('__pk__', String(listingPk));
  }

  if (listingPk !== null && listingPk !== undefined) {
    return `/${locale}/listing/${listingPk}/`;
  }

  return `/${locale}/listing/`;
}

function normalizeListingRow(row, detailTemplate, locale) {
  const listingPk = row.pk ?? row.id;
  const listingUrlPath = buildListingUrlPath(row, locale, detailTemplate);
  const coverImage = row.cover_image?.url_listing_search || row.cover_image?.url || null;
  const imageUrl = toAbsoluteImageUrl(coverImage);
  const imageUrls = imageUrl ? [imageUrl] : [];
  const street = String(row.street || '').trim() || null;
  const zipCode = row.zipcode !== null && row.zipcode !== undefined ? String(row.zipcode).trim() || null : null;
  const city = String(row.city || '').trim() || null;
  const publicAddress = String(row.public_address || '').trim() || null;
  const title = String(row.short_title || row.rent_title || row.public_title || '').trim() || null;
  const description = String(row.description || row.description_title || '').trim() || null;
  const objectCategory = row.object_category || row.object_type;

  return {
    id: `${ID_PREFIX}${listingPk}`,
    source: SOURCE_CONST,
    url: `https://flatfox.ch${listingUrlPath}`,
    address_raw: publicAddress || [street, zipCode, city].filter(Boolean).join(', ') || title,
    image_urls: imageUrls,
    title,
    description,
    price: toIntOrNull(row.price_display ?? row.rent_gross ?? row.rent_net),
    currency: 'CHF',
    price_period: 'month',
    rooms: toNumericOrNull(row.number_of_rooms),
    living_space_m2: toNumericOrNull(row.surface_living ?? row.livingspace ?? row.surface_usable),
    floor: toIntOrNull(row.floor),
    total_floors: null,
    street,
    street_number: null,
    zip_code: zipCode,
    city,
    country_code: 'CH',
    latitude: toNumericOrNull(row.latitude),
    longitude: toNumericOrNull(row.longitude),
    listing_type: normalizeListingType(row.offer_type, objectCategory),
    property_type: normalizePropertyType(objectCategory),
    available_from: String(row.moving_date_type || '').toLowerCase() === 'dat' && row.moving_date ? String(row.moving_date) : null,
  };
}

async function extractListings(page) {
  const { targetUrl, selectionPk, detailTemplate } = await readSearchContext(page);
  const locale = parseTargetUrl(targetUrl).locale;
  const pinUrl = buildPinApiUrl(targetUrl, selectionPk);
  const pinRows = await fetchJson(pinUrl);
  const pks = Array.isArray(pinRows)
    ? pinRows.map((row) => row?.pk ?? row?.id).filter((pk) => pk !== null && pk !== undefined)
    : [];

  if (!pks.length) return [];

  const listingsUrl = buildPublicListingApiUrl(pks);
  const rows = await fetchJson(listingsUrl);

  return (Array.isArray(rows) ? rows : []).map((row) => normalizeListingRow(row, detailTemplate, locale));
}

module.exports = {
  id: SOURCE_ID,
  name: 'Flatfox',
  loginRequired: false,
  loginUrl: null,
  scrollSafetyLimit: 1,
  scrollIdleRounds: 1,
  initialDelayMs: 0,
  scrollDelayMs: 0,
  scrollDistance: 0,
  scrollTargetPreference: 'document',
  normalizeTargetUrl,
  getTargets,
  extractListings,
  fixtures: {
    sampleHtmlPath: path.resolve(__dirname, '../../../data/flatfox/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/flatfox/sample.expected.json'),
  },
};
