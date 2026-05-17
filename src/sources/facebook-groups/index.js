/**
 * Facebook Groups source.
 *
 * ID convention: FACEBOOK_GROUPS_<id>
 * Source string:  FACEBOOK_GROUPS
 *
 * Target URLs: FACEBOOK_GROUPS_URLS (comma-separated) in .env
 * Auth:        storage/facebook-cookies.json  (shared with Marketplace source)
 */

'use strict';

const path = require('path');
const { extractPrice } = require('../../core/price-utils');
const { DEFAULT_SOURCE_CONFIG } = require('../../core/config');

const SOURCE_ID    = 'facebook-groups';
const SOURCE_CONST = 'FACEBOOK_GROUPS';
const ID_PREFIX    = 'FACEBOOK_GROUPS_';

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
  const results = [];
  const feedItems = document.querySelectorAll('div[aria-posinset]');

  // Establish base fallback group URL completely free of tracking params
  const cleanCurrentUrl = window.location.href.split('?')[0].split('&')[0];
  const groupUrlMatch = cleanCurrentUrl.match(/\/groups\/([^\/]+)/);
  const fallbackGroupUrl = groupUrlMatch ? `https://www.facebook.com/groups/${groupUrlMatch[1]}/` : cleanCurrentUrl;

  const normalizeWhitespace = (str) =>
    str
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/Voir plus$/i, '') 
      .replace(/See more$/i, '')  
      .replace(/…$/, '')
      .trim();

  feedItems.forEach((item) => {
    try {
      const links = Array.from(item.querySelectorAll('a[href]'));
      const isCommerce = links.some(l => (l.getAttribute('href') || '').includes('/commerce/listing/'));

      // 1. Text Extraction
      let fullTextRaw = '';
      let titleText = '';

      if (isCommerce) {
        const titleNode = item.querySelector('[data-ad-rendering-role="title"]');
        const descNode = item.querySelector('[data-ad-rendering-role="description"]');
        const messageNode = item.querySelector('[data-ad-rendering-role="story_message"]');
        
        titleText = titleNode ? titleNode.innerText : '';
        fullTextRaw = [
          titleText,
          descNode ? descNode.innerText : '',
          messageNode ? messageNode.innerText : ''
        ].filter(Boolean).join('\n');
      } else {
        const messageNode = item.querySelector('[data-ad-rendering-role="story_message"]');
        fullTextRaw = messageNode ? messageNode.innerText : '';
      }

      const cleanText = normalizeWhitespace(fullTextRaw);
      if (cleanText.length < 15) return;

      // 2. Heavy-Duty URL & ID Resolution Engine
      let fbId = null;
      let postUrl = null;

      for (const link of links) {
        const href = link.getAttribute('href') || '';

        // Match structural Marketplace Listings
        const commerceMatch = href.match(/\/commerce\/listing\/(\d+)/);
        if (commerceMatch) {
          fbId = commerceMatch[1];
          postUrl = `https://www.facebook.com/commerce/listing/${fbId}/`;
          break; 
        }

        // Match explicit group post permalinks
        const groupPostMatch = href.match(/\/groups\/[^\/]+\/(?:posts|permalink)\/(\d+)/);
        if (groupPostMatch && !fbId) {
          fbId = groupPostMatch[1];
          let cleanHref = href.split('?')[0].split('&')[0];
          postUrl = cleanHref.startsWith('http') ? cleanHref : `https://www.facebook.com${cleanHref}`;
          break;
        }

        // Hidden in Photo Album links (set=pcb.XXXXX)
        const pcbMatch = href.match(/set=pcb\.(\d+)/);
        if (pcbMatch && !fbId) {
          fbId = pcbMatch[1];
        }

        // Backup structural structural parameters
        const multiMatch = href.match(/multi_permalinks=(\d+)/);
        if (multiMatch && !fbId) {
          fbId = multiMatch[1];
        }
      }

      // Reconstruct single post URL if structural ID was caught via fallbacks
      if (fbId && !postUrl) {
        if (groupUrlMatch && groupUrlMatch[1]) {
          postUrl = `https://www.facebook.com/groups/${groupUrlMatch[1]}/posts/${fbId}/`;
        } else {
          postUrl = `https://www.facebook.com/permalink.php?story_fbid=${fbId}&id=0`;
        }
      }

      // Catch-all fallbacks to completely eliminate "none", null or unnormalized values
      if (!fbId) {
        const fingerprint = cleanText.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
        fbId = `anon_${fingerprint}`;
      }
      
      if (!postUrl || postUrl === 'none') {
        postUrl = fallbackGroupUrl;
      } else {
        // Enforce removal of residual query parameters across compiled strings
        postUrl = postUrl.split('?')[0].split('&')[0];
      }

      // 3. Clean Image Extraction
      const imageUrls = Array.from(item.querySelectorAll('img'))
        .map((img) => img.src)
        .filter(Boolean)
        .filter((src) => src.includes('scontent'))   
        .filter((src) => !src.includes('emoji.php')) 
        .filter((src) => !src.includes('rsrc.php'))  
        .filter((src) => !src.match(/\/[sp]\d{2}x\d{2}\//)) 
        .filter((src, index, arr) => arr.indexOf(src) === index); 

      results.push({
        rawId: fbId,
        url: postUrl,
        address_raw: cleanText,
        title: titleText || null, 
        image_urls: imageUrls,
        price_raw: cleanText, 
      });

    } catch (err) {
      console.error('Error parsing individual FB post:', err);
    }
  });

  const uniqueResults = [];
  const seenIds = new Set();
  
  for (const res of results) {
    if (!seenIds.has(res.rawId)) {
      seenIds.add(res.rawId);
      uniqueResults.push(res);
    }
  }

  return uniqueResults;
}

// ---------------------------------------------------------------------------
// Playwright extractor
// ---------------------------------------------------------------------------

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<object[]>}
 */
async function extractListings(page) {
  const rawListings = await page.evaluate(extractListingsFromDocument);

  return rawListings.map((item) => ({
    id:              `${ID_PREFIX}${item.rawId}`,
    source:          SOURCE_CONST,
    url:             item.url,
    address_raw:     item.address_raw,
    image_urls:      item.image_urls || [],
    title:           item.title,
    description:     null,
    price:           extractPrice(item.price_raw),
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
  id:                     SOURCE_ID,
  name:                   'Facebook Groups',
  cookieSourceId:         'facebook',
  loginRequired:          true,

  scrollTargetPreference: 'document',
  scrollSafetyLimit:      3,
  scrollIdleRounds:       6,
  initialDelayMs:         8000,
  scrollDelayMs:          1200,
  scrollSettleMs:         4000,
  scrollDistance:         900,
  loginUrl:               DEFAULT_SOURCE_CONFIG.loginUrl,

  normalizeTargetUrl,
  getTargets,
  extractListings,

  fixtures: {
    sampleHtmlPath:     path.resolve(__dirname, '../../../data/facebook-groups/sample.html'),
    sampleExpectedPath: path.resolve(__dirname, '../../../data/facebook-groups/sample.expected.json'),
  },
};