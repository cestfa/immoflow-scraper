/**
 * Appartel source.
 *
 * Lausanne search results render as simple listing cards with title, type,
 * location, price, and duration text. Target URLs are read from APPARTEL_URLS.
 */

'use strict';

const path = require('path');

const SOURCE_ID = 'appartel';
const SOURCE_CONST = 'APPARTEL';
const ID_PREFIX = 'APPARTEL_';
const DEFAULT_TARGET_URL = 'https://appartel.ch/annonces?ville=Lausanne&prixMax=2000&lat=46.520714&lng=6.632528';
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
  let url = endpoint.toString();
  if (city) {
    const normalized = city.toLowerCase().trim();
    url += `&or=(${[
      `ville.ilike.%25${normalized}%25`,
      `canton.ilike.%25${normalized}%25`,
      `quartier.ilike.%25${normalized}%25`,
    ].join(',')})`;
  }
  return `${url}&order=created_at.desc`;
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

async function extractListings(page) {
  const apiRows = await fetchListingsFromApi(page);
  return apiRows.map(normalizeApiListing);
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