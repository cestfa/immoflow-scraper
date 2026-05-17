'use strict';

const path = require('path');
const { extractPrice } = require('../../core/price-utils');

const SOURCE_ID = 'myhomies';
const SOURCE_CONST = 'MYHOMIES';
const ID_PREFIX = 'MYHOMIES_';
const DEFAULT_TARGET_URL = 'https://fr.myhomies.ch/discover/Lausanne-flatshare';

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

  const raw = env.MYHOMIES_URLS;
  if (!raw) return [DEFAULT_TARGET_URL];

  return raw.split(',').map((url) => url.trim()).filter(Boolean);
}

function extractListingsFromDocument() {
  const results = [];
  const seen = new Set();

  const cards = Array.from(document.querySelectorAll('#filter-listing .group-item'));

  cards.forEach((card) => {
    try {
      const fullText = (card.innerText || card.textContent || '').trim();
      
      if (!fullText || /^\d+$/.test(fullText) || !/CHF/i.test(fullText)) return;

      const textNodes = Array.from(card.querySelectorAll('.bubble-element.Text'))
        .map((n) => (n.innerText || n.textContent).trim())
        .filter(Boolean);

      let priceText = '';
      let locationText = '';
      let dateText = '';

      textNodes.forEach((line) => {
        if (/CHF/i.test(line)) priceText = line;
        else if (/m²/i.test(line)) locationText = line;
        // Aggressive fallback to catch the date block no matter what
        else if (/disponible|available/i.test(line) || /\d{1,2}[^\d\w]+\d{1,2}[^\d\w]+\d{2,4}/.test(line)) {
          dateText = line;
        }
      });

      let imgUrl = null;
      
      const imageNode = card.querySelector('[style*="background-image"]');
      if (imageNode) {
        const style = imageNode.getAttribute('style') || '';
        const matchImg = style.match(/background-image\s*:\s*url\((.*?)\)/i);
        
        if (matchImg && matchImg[1]) {
          let rawUrl = matchImg[1].replace(/&quot;/g, '').replace(/['"]/g, '').replace(/&amp;/g, '&').trim();
          if (rawUrl.startsWith('//')) rawUrl = `https:${rawUrl}`;
          imgUrl = rawUrl;
        }
      }

      const rawId = `${priceText}-${locationText}`;
      if (seen.has(rawId)) return;
      seen.add(rawId);

      results.push({
        priceText,
        locationText,
        dateText,
        fullText, 
        imgUrl
      });
    } catch (_) {}
  });

  return results;
}

async function extractListings(page) {
  await page.waitForSelector('#filter-listing .group-item', { timeout: 15000 });
  const raw = await page.evaluate(extractListingsFromDocument);

  return raw.map((item) => {
    // 1. Parse Area, Zip Code, and City
    let zip = null;
    let city = null;
    let area = null;
    const locMatch = (item.locationText || '').match(/([\d\s.,]+)\s*m²\s*-\s*(?:(\d{4})\s*,)?\s*(.+)/i);
    
    if (locMatch) {
      area = parseFloat(locMatch[1].replace(/\s+/g, '').replace(',', '.'));
      zip = locMatch[2] ? locMatch[2].trim() : null;
      city = locMatch[3] ? locMatch[3].replace(/^,\s*/, '').trim() : null;
    }

    // 2. Parse Date (Bulletproof digit-only extraction)
    let availableFrom = null;
    const textToSearch = item.dateText || item.fullText || '';
    
    // Looks purely for ## (anything) ## (anything) ####
    const dateMatch = textToSearch.match(/(\d{1,2})[^\d\w]+(\d{1,2})[^\d\w]+(\d{2,4})/);
    if (dateMatch) {
      let p1 = parseInt(dateMatch[1], 10);
      let p2 = parseInt(dateMatch[2], 10);
      let p3 = parseInt(dateMatch[3], 10);
      
      let y, m, d;
      // Guarantee proper assignment of Year vs Day
      if (p3 >= 2000 || (p3 >= 20 && p3 <= 99)) {
        y = p3 < 100 ? p3 + 2000 : p3;
        m = p2;
        d = p1;
      } else if (p1 >= 2000) {
        y = p1;
        m = p2;
        d = p3;
      }
      
      // Safety bounds to prevent matching random street numbers
      if (y >= 2000 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        availableFrom = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }

    // 3. Construct clean Address
    const addressRaw = [zip, city].filter(Boolean).join(' ') || item.locationText;

    // 4. Create a DETERMINISTIC ID
    const cleanPrice = item.priceText ? item.priceText.replace(/\D/g, '') : '0';
    const cleanCity = city ? city.toLowerCase().replace(/[^a-z0-9]/g, '-') : 'unknown';
    const distinctId = `${cleanPrice}-${area || 0}-${cleanCity}`;

    return {
      id: `${ID_PREFIX}${distinctId}`,
      source: SOURCE_CONST,
      url: DEFAULT_TARGET_URL, 
      address_raw: addressRaw,
      image_urls: item.imgUrl ? [item.imgUrl] : [],
      title: null,
      description: null,
      price: extractPrice(item.priceText),
      currency: 'CHF',
      price_period: 'month',
      rooms: null,
      living_space_m2: Number.isFinite(area) ? area : null,
      floor: null,
      total_floors: null,
      street: null,
      street_number: null,
      zip_code: zip,
      city: city,
      country_code: 'CH',
      latitude: null,
      longitude: null,
      listing_type: 'share',
      property_type: 'colocation',
      available_from: availableFrom,
    };
  });
}

module.exports = {
  id: SOURCE_ID,
  name: 'myHOMIES',
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
    sampleHtmlPath: path.resolve(__dirname, '../../../data/myhomies/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/myhomies/sample.expected.json'),
  },
};