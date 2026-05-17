/**
 * Facebook Groups source.
 *
 * ID convention: FACEBOOK_GROUPS_<id>
 * Source string:  FACEBOOK_GROUPS
 *
 * Target URLs: FACEBOOK_GROUPS_URLS (comma-separated) in .env
 * Auth:        storage/facebook-cookies.json  (shared with Marketplace source)
 *
 * Posts are unstructured text. Reliably extracts:
 *   id, source, url, address_raw, image_urls, price
 *
 * Structured fields (rooms, zip_code, city …) are null for this source.
 */

'use strict';

const path = require('path');
const { extractPrice } = require('../../core/price-utils');
const { DEFAULT_SOURCE_CONFIG } = require('../../core/config');

const SOURCE_ID    = 'facebook-groups';
const SOURCE_CONST = 'FACEBOOK_GROUPS';   // written to listings.source
const ID_PREFIX    = 'FACEBOOK_GROUPS_';  // prepended to listings.id

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

function normalizeTargetUrl(url) {
  return url.split('?')[0].split('&')[0];
}

function getTargets({ urls = [], env = {} } = {}) {
  if (urls.length) return urls.filter(Boolean);
  const raw = env.FACEBOOK_GROUPS_URLS;
  if (!raw) return [];
  return raw.split(',').map((u) => u.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// DOM parser — runs inside page.evaluate (browser context only)
// ---------------------------------------------------------------------------

function extractListingsFromDocument() {
  const results   = [];
  const feedItems = document.querySelectorAll('div[aria-posinset]');

  feedItems.forEach((item) => {
    try {
      if (!item.innerText || item.innerText.trim().length === 0) return;

      // Clone and strip noise nodes (reactions, comment boxes, etc.)
      const postClone = item.cloneNode(true);
      postClone
        .querySelectorAll('div[role="article"], form, [role="button"], [aria-label*="comment" i], [aria-label*="réponse" i]')
        .forEach((node) => node.remove());

      const textNodes   = Array.from(postClone.querySelectorAll('div[dir="auto"]'));
      const cleanTexts  = textNodes.map((n) => n.innerText.trim()).filter((t) => t.length > 0);
      const mainContent = cleanTexts.join('\n').replace(/\n\s*\n/g, '\n').trim();

      // Skip non-listing noise (marketplace promotions, very short posts)
      if (mainContent.includes('Vendre un article') && mainContent.length < 150) return;
      if (mainContent.length < 15) return;

      // Extract post URL and stable ID
      const links = Array.from(item.querySelectorAll('a'));
      let postUrl        = 'none';
      let fbId           = null;
      let fallbackUserId = null;

      for (const link of links) {
        const href      = link.href || '';
        const postMatch = href.match(/(?:posts|permalink|listing)\/(\d+)/);
        if (postMatch) { postUrl = href.split('?')[0].split('&')[0]; fbId = postMatch[1]; break; }
        const userMatch = href.match(/\/user\/(\d+)/);
        if (userMatch && !fallbackUserId) fallbackUserId = userMatch[1];
      }

      const textFingerprint = mainContent.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30);
      const rawId           = fbId || `fp_${fallbackUserId || 'anon'}_${textFingerprint}`;

      // Anti-ghost-image: only real scontent images over 100px wide
      const imageUrls = Array.from(item.querySelectorAll('img'))
        .filter((img) => img.src.includes('scontent') && img.width > 100)
        .map((img) => img.src);

      results.push({ rawId, url: postUrl, address_raw: mainContent, image_urls: imageUrls, price: mainContent });
    } catch (_) {}
  });

  return results;
}

// ---------------------------------------------------------------------------
// Playwright extractor
// ---------------------------------------------------------------------------

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<object[]>}
 */
async function extractListings(page) {
  const raw = await page.evaluate(extractListingsFromDocument);

  return raw.map((item) => ({
    id:              `${ID_PREFIX}${item.rawId}`,
    source:          SOURCE_CONST,
    url:             item.url,
    address_raw:     item.address_raw,
    image_urls:      item.image_urls || [],
    title:           null,
    description:     null,
    price:           extractPrice(item.price),
    currency:        'CHF',
    price_period:    'month',
    rooms:           null,
    living_space_m2: null,
    floor:           null,
    total_floors:    null,
    street:          null,
    street_number:   null,
    zip_code:        null,
    city:            null,
    country_code:    'CH',
    latitude:        null,
    longitude:       null,
    listing_type:    'rent',
    property_type:   null,
    available_from:  null,
  }));
}

// ---------------------------------------------------------------------------
// Source descriptor
// ---------------------------------------------------------------------------

module.exports = {
  id:             SOURCE_ID,
  name:           'Facebook Groups',
  cookieSourceId: 'facebook',
  loginRequired:  true,

  // Facebook's feed scrolls on window/document — forcing 'document' mode
  // avoids the engine latching onto a high-scoring inner div that moves
  // independently of the actual post feed.
  scrollTargetPreference:  'document',

  scrollSafetyLimit:       50,
  scrollIdleRounds:        6,       // FB lazy-loads slowly, give it more rounds
  initialDelayMs:          8000,    // extra time for FB's heavy initial render
  scrollDelayMs:           1200,
  scrollSettleMs:          4000,    // wait longer after each scroll for XHR
  scrollDistance:          900,
  loginUrl:                DEFAULT_SOURCE_CONFIG.loginUrl,

  normalizeTargetUrl,
  getTargets,
  extractListings,

  fixtures: {
    sampleHtmlPath:     path.resolve(__dirname, '../../../data/facebook-groups/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/facebook-groups/sample.expected.json'),
  },
};