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
const DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.APPARTEL_DEBUG || ''));
const LISTING_WAIT_TIMEOUT_MS = Number.parseInt(process.env.APPARTEL_WAIT_TIMEOUT_MS || '10000', 10);
const SUPABASE_URL = 'https://enjxuxkuupiwmrtdrtvs.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVuanh1eGt1dXBpd21ydGRydHZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI3NjU2NTMsImV4cCI6MjA3ODM0MTY1M30.eei1t3c-FaVMKZ7-tICFiUzkEgQDI6GLqIviks_NwQ0';
const SUPABASE_SELECT = [
  'id',
  'user_id',
  'titre',
  'description',
  'prix_mois',
  'type_logement',
  'ville',
  'canton',
  'quartier',
  'code_postal',
  'equipements',
  'photos',
  'statut',
  'date_debut',
  'date_fin',
  'surface_m2',
  'vues',
  'created_at',
  'updated_at',
  'disponibilite_type',
  'nb_pieces',
  'nb_chambres',
  'nb_salles_bain',
  'nb_personnes_max',
  'masquer_adresse',
  'masquer_coordonnees',
  'latitude',
  'longitude',
  'nombre_pieces',
].join(',');

const pageDebugState = new WeakMap();

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

function parseTargetParameters(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return {
      city: (parsed.searchParams.get('ville') || '').trim(),
      maxPrice: Number.parseInt(parsed.searchParams.get('prixMax') || '2000', 10),
    };
  } catch (_) {
    return { city: '', maxPrice: 2000 };
  }
}

function buildSupabaseApiUrl(targetUrl) {
  const { city, maxPrice } = parseTargetParameters(targetUrl);
  const endpoint = new URL('/rest/v1/annonces_public', SUPABASE_URL);
  endpoint.searchParams.set('select', SUPABASE_SELECT);
  endpoint.searchParams.set('statut', 'eq.active');
  if (Number.isFinite(maxPrice) && maxPrice > 0) {
    endpoint.searchParams.set('prix_mois', `lte.${maxPrice}`);
  }
  if (city) {
    const normalized = city.toLowerCase().trim();
    endpoint.searchParams.set('or', [
      `ville.ilike.%25${normalized}%25`,
      `canton.ilike.%25${normalized}%25`,
      `quartier.ilike.%25${normalized}%25`,
    ].join(','));
  }
  endpoint.searchParams.set('order', 'created_at.desc');
  return endpoint.toString();
}

async function fetchListingsFromApi(page) {
  const targetUrl = page.url();
  const apiUrl = buildSupabaseApiUrl(targetUrl);

  const response = await fetch(apiUrl, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase API request failed with status ${response.status}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

function normalizeApiListing(item) {
  const city = String(item.ville || '').trim() || null;
  const canton = String(item.canton || '').trim() || null;
  const quartier = String(item.quartier || '').trim() || null;
  const locationParts = [quartier, city, canton].filter(Boolean);

  return {
    id: `${ID_PREFIX}${item.id}`,
    source: SOURCE_CONST,
    url: `https://appartel.ch/annonces/${item.id}`,
    address_raw: [String(item.titre || '').trim(), locationParts.join(', ')].filter(Boolean).join(' | '),
    image_urls: Array.isArray(item.photos) ? item.photos.filter(Boolean) : [],
    title: String(item.titre || '').trim() || null,
    description: String(item.description || '').trim() || null,
    price: Number.isFinite(Number(item.prix_mois)) ? Number(item.prix_mois) : null,
    currency: 'CHF',
    price_period: 'month',
    rooms: Number.isFinite(Number(item.nb_pieces ?? item.nombre_pieces)) ? Number(item.nb_pieces ?? item.nombre_pieces) : null,
    living_space_m2: Number.isFinite(Number(item.surface_m2)) ? Number(item.surface_m2) : null,
    floor: null,
    total_floors: null,
    street: null,
    street_number: null,
    zip_code: String(item.code_postal || '').trim() || null,
    city,
    country_code: 'CH',
    latitude: Number.isFinite(Number(item.latitude)) ? Number(item.latitude) : null,
    longitude: Number.isFinite(Number(item.longitude)) ? Number(item.longitude) : null,
    listing_type: 'rent',
    property_type: String(item.type_logement || '').trim() || null,
    available_from: item.disponibilite_type === 'date' && item.date_debut ? item.date_debut : null,
  };
}

function installDebugHooks(page) {
  if (!DEBUG_ENABLED || pageDebugState.has(page)) return pageDebugState.get(page) || null;

  const state = { failedRequests: [] };

  page.on('console', (message) => {
    const type = message.type();
    if (type === 'debug' || type === 'error' || type === 'warning') {
      console.log(`🐛 [APPARTEL][console:${type}] ${message.text()}`);
    }
  });

  page.on('pageerror', (error) => {
    console.log(`🐛 [APPARTEL][pageerror] ${error.message}`);
  });

  page.on('requestfailed', (request) => {
    state.failedRequests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      failure: request.failure()?.errorText || 'unknown',
    });
  });

  pageDebugState.set(page, state);
  return state;
}

async function logDebugSnapshot(page, reason) {
  if (!DEBUG_ENABLED) return;

  const state = pageDebugState.get(page) || { failedRequests: [] };

  try {
    const snapshot = await page.evaluate(() => {
      const text = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const main = document.querySelector('main');
      const bodyText = text(document.body?.innerText || '');

      return {
        title: text(document.title),
        url: location.href,
        readyState: document.readyState,
        h1: text(document.querySelector('main h1')?.textContent),
        status: text(document.querySelector('main p')?.textContent),
        cards: document.querySelectorAll('main .group.bg-card').length,
        mainHtml: text(main?.innerHTML || '').slice(0, 1500),
        bodyText: bodyText.slice(0, 1000),
      };
    });

    console.log(`🐛 [APPARTEL][debug] ${reason}`);
    console.log(`   url: ${snapshot.url}`);
    console.log(`   title: ${snapshot.title || '(none)'}`);
    console.log(`   readyState: ${snapshot.readyState || '(none)'}`);
    console.log(`   h1: ${snapshot.h1 || '(none)'}`);
    console.log(`   status: ${snapshot.status || '(none)'}`);
    console.log(`   cards: ${snapshot.cards}`);
    if (snapshot.mainHtml) {
      console.log(`   mainHtml: ${snapshot.mainHtml}`);
    }
    if (snapshot.bodyText) {
      console.log(`   body: ${snapshot.bodyText}`);
    }

    if (state.failedRequests.length) {
      console.log('   failed requests:');
      for (const item of state.failedRequests.slice(-10)) {
        console.log(`     - ${item.method} ${item.resourceType} ${item.url} :: ${item.failure}`);
      }
    } else {
      console.log('   failed requests: none captured');
    }
  } catch (err) {
    console.log(`🐛 [APPARTEL][debug] Snapshot error: ${err.message}`);
  }
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
  installDebugHooks(page);

  try {
    await page.getByRole('button', { name: 'Accepter' }).click({ timeout: 2000 });
  } catch (_) {}

  // Appartel renders listings client-side after a delayed fetch, so wait for
  // the card containers themselves rather than a visible heading.
  try {
    await page.waitForSelector('main .group.bg-card', { timeout: LISTING_WAIT_TIMEOUT_MS, state: 'attached' });
  } catch (_) {
    await logDebugSnapshot(page, `listing wait timed out after ${LISTING_WAIT_TIMEOUT_MS}ms`);

    try {
      const apiRows = await fetchListingsFromApi(page);
      if (DEBUG_ENABLED) {
        console.log(`🐛 [APPARTEL][debug] API fallback returned ${apiRows.length} row(s)`);
      }
      return apiRows.map(normalizeApiListing);
    } catch (err) {
      if (DEBUG_ENABLED) {
        console.log(`🐛 [APPARTEL][debug] API fallback failed: ${err.message}`);
      }
      return [];
    }
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