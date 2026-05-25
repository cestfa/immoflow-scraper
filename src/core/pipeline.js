/**
 * Core scrape pipeline.
 *
 * Responsibilities:
 *   - Browser lifecycle (launch, context, cookies)
 *   - Smart infinite-scroll engine
 *   - DB sync: fetch existing rows → mergeForUpsert → batch upsert + price_history
 *
 * All Supabase calls go through the pure-REST client in supabase.js.
 * Data shaping goes through normalizeListing / mergeForUpsert in core.js.
 *
 * scrapeSource() now returns enriched stats used by the Discord alert:
 *   {
 *     newCount, updatedCount, skipped,
 *     urlResults: [{ url, listingCount, scrollAttempts, scrollFallback, warnings }]
 *   }
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const {
  STORAGE_DIR,
  USER_AGENT,
  BROWSER_VIEWPORT,
  BROWSER_NAVIGATION_TIMEOUT,
  BROWSER_INTERACTION_TIMEOUT,
  LINUX_LAUNCH_ARGS,
} = require('./config');

const { normalizeListing, mergeForUpsert } = require('./core');

// Low-listing warning threshold — override via env SCRAPE_LOW_LISTING_THRESHOLD
const LOW_LISTING_THRESHOLD = Number.parseInt(process.env.SCRAPE_LOW_LISTING_THRESHOLD || '1', 10);

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

function isHeadlessEnvironment() {
  if (process.platform === 'win32' || process.platform === 'darwin') return false;
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

function buildLaunchOptions(userHeadless) {
  const headless = isHeadlessEnvironment() || userHeadless !== false;
  const args     = process.platform === 'linux' ? [...LINUX_LAUNCH_ARGS] : [];
  return { headless, args };
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function getCookiesPath(source) {
  const cookieSourceId = source.cookieSourceId || source.id;
  return path.resolve(process.cwd(), STORAGE_DIR, `${cookieSourceId}-cookies.json`);
}

async function loadCookiesIfExist(context, source) {
  if (!source.loginRequired) return true;

  const cookiesPath = getCookiesPath(source);

  if (!fs.existsSync(cookiesPath)) {
    console.log(`⚠️  [${source.id}] No cookies at ${cookiesPath}`);
    console.log(`    Run: npm run login -- --source ${source.id}`);
    return false;
  }

  try {
    const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));

    if (!Array.isArray(cookies)) {
      console.log(`⚠️  [${source.id}] Invalid cookie format`);
      return false;
    }

    await context.addCookies(cookies);
    console.log(`🍪 [${source.id}] Loaded ${cookies.length} cookies`);
    return true;
  } catch (err) {
    console.log(`❌ [${source.id}] Cookie load error: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Smart scroll engine
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function installScrollTelemetry(page) {
  try {
    await page.evaluate(() => {
      if (window.__immoScrollTelemetryInstalled) return;

      const telemetry = { mutationCount: 0, lastMutationAt: Date.now() };

      const attachObserver = (root) => {
        if (!root || root.__immoScrollObserverAttached) return;
        try {
          const observer = new MutationObserver((mutations) => {
            telemetry.mutationCount += mutations.length;
            telemetry.lastMutationAt = Date.now();
          });
          observer.observe(root, { childList: true, subtree: true, attributes: true });
          root.__immoScrollObserverAttached = true;
        } catch (_) {}
      };

      const attachShadowRoots = (root) => {
        if (!root || !root.querySelectorAll) return;
        root.querySelectorAll('*').forEach((el) => {
          if (el.shadowRoot) { attachObserver(el.shadowRoot); attachShadowRoots(el.shadowRoot); }
        });
      };

      attachObserver(document);
      attachObserver(document.documentElement);
      attachObserver(document.body);
      attachShadowRoots(document);
      attachShadowRoots(document.documentElement);

      window.__immoScrollTelemetry = telemetry;
      window.__immoScrollTelemetryInstalled = true;
    });
  } catch (_) {}
}

async function inspectScrollState(page) {
  return page.evaluate(() => {
    const scrollingElement = document.scrollingElement || document.documentElement;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const viewportWidth  = window.innerWidth  || document.documentElement.clientWidth  || 0;
    const telemetry      = window.__immoScrollTelemetry || { mutationCount: 0, lastMutationAt: 0 };

    const candidates = [];
    const visitedRoots = new Set();
    let markerIndex = 0;

    const scoreCandidate = (element, rect, overflowY, remaining) => {
      let score = remaining;
      if (overflowY === 'scroll') score += 120;
      else if (overflowY === 'auto') score += 90;
      const role = (element.getAttribute('role') || '').toLowerCase();
      if (role === 'feed' || role === 'main') score += 200;
      if (role === 'region' || role === 'presentation') score += 20;
      if (element.closest('[aria-busy="true"]')) score += 30;
      if (rect.width > viewportWidth * 0.7) score += 50;
      if (rect.height > viewportHeight * 0.5) score += 50;
      if (element === scrollingElement) score += 250;
      return score;
    };

    const collectCandidates = (root) => {
      if (!root || visitedRoots.has(root) || !root.querySelectorAll) return;
      visitedRoots.add(root);
      root.querySelectorAll('*').forEach((element) => {
        if (!(element instanceof HTMLElement)) return;
        const style     = window.getComputedStyle(element);
        const overflowY = style.overflowY;
        const scrollable = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
                        && element.scrollHeight > element.clientHeight + 40;
        if (scrollable) {
          const rect    = element.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0
                       && rect.right > 0 && rect.top < viewportHeight;
          if (visible) {
            const marker    = `immo-scroll-${Date.now().toString(36)}-${markerIndex++}`;
            element.setAttribute('data-immo-scroll-marker', marker);
            const remaining = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
            candidates.push({
              marker, tagName: element.tagName.toLowerCase(),
              role: element.getAttribute('role') || null,
              ariaLabel: element.getAttribute('aria-label') || null,
              top: rect.top, left: rect.left, width: rect.width, height: rect.height,
              scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight, remaining, isDocument: false,
              score: scoreCandidate(element, rect, overflowY, remaining),
            });
          }
        }
        if (element.shadowRoot) collectCandidates(element.shadowRoot);
      });
    };

    collectCandidates(document);

    if (scrollingElement) {
      const rect      = scrollingElement.getBoundingClientRect
        ? scrollingElement.getBoundingClientRect()
        : { top: 0, left: 0, width: viewportWidth, height: viewportHeight, bottom: viewportHeight, right: viewportWidth };
      const remaining = Math.max(0, scrollingElement.scrollHeight - viewportHeight - (window.scrollY || scrollingElement.scrollTop || 0));
      candidates.push({
        marker: '__document__', tagName: scrollingElement.tagName.toLowerCase(),
        role: scrollingElement.getAttribute ? scrollingElement.getAttribute('role') || null : null,
        ariaLabel: scrollingElement.getAttribute ? scrollingElement.getAttribute('aria-label') || null : null,
        top: rect.top, left: rect.left, width: rect.width, height: rect.height,
        scrollTop: window.scrollY || scrollingElement.scrollTop || 0,
        scrollHeight: scrollingElement.scrollHeight, clientHeight: viewportHeight,
        remaining, isDocument: true,
        score: scoreCandidate(scrollingElement, rect, 'auto', remaining),
      });
    }

    candidates.sort((a, b) => b.score - a.score);

    return {
      viewportHeight,
      documentHeight: scrollingElement ? scrollingElement.scrollHeight : document.documentElement.scrollHeight,
      documentTop:    window.scrollY || (scrollingElement ? scrollingElement.scrollTop : 0) || document.documentElement.scrollTop || 0,
      mutationCount:  telemetry.mutationCount || 0,
      lastMutationAt: telemetry.lastMutationAt || 0,
      hasScrollableTargets: candidates.length > 0,
      candidates:     candidates.slice(0, 8),
    };
  });
}

function pickScrollTarget(snapshot, previousTarget, preferredMode = 'auto') {
  const candidates = snapshot?.candidates || [];
  if (preferredMode === 'document') {
    return candidates.find((c) => c.isDocument) || candidates[0] || null;
  }
  if (previousTarget?.marker) {
    const same = candidates.find((c) => c.marker === previousTarget.marker);
    if (same && same.remaining > 0) return same;
  }
  return candidates.find((c) => c.remaining > 0) || candidates[0] || null;
}

function resolveScrollDistance(source, snapshot, target) {
  const viewportHeight      = snapshot?.viewportHeight || 768;
  const configuredDistance  = source.scrollDistance ?? clamp(Math.round(viewportHeight * 1.1), 650, 2200);
  if (!target) return configuredDistance;
  const remaining = typeof target.remaining === 'number' ? target.remaining : configuredDistance;
  return clamp(Math.min(configuredDistance, remaining > 0 ? remaining : configuredDistance), 250, 2600);
}

function describeScrollTarget(target) {
  if (!target) return 'viewport';
  if (target.isDocument || target.marker === '__document__') return 'document';
  const role  = target.role      ? `[role=${target.role}]`     : '';
  const label = target.ariaLabel ? ` aria=${target.ariaLabel}` : '';
  return `${target.tagName}${role}${label}`;
}

async function performSmartScroll(page, scrollTarget, distance) {
  try {
    const viewport = page.viewportSize() || { width: 1366, height: 768 };

    const beforeState = await page.evaluate(({ target }) => {
      const scrollingElement = document.scrollingElement || document.documentElement;
      const resolveTarget = () => {
        if (!target || target.marker === '__document__') return scrollingElement;
        return document.querySelector(`[data-immo-scroll-marker="${target.marker}"]`);
      };
      const element    = resolveTarget();
      if (!element) return null;
      const isDocument = element === scrollingElement;
      return {
        isDocument,
        top:      isDocument ? window.scrollY || scrollingElement.scrollTop || 0 : element.scrollTop,
        height:   isDocument ? scrollingElement.scrollHeight : element.scrollHeight,
        viewport: isDocument ? (window.innerHeight || document.documentElement.clientHeight || 0) : element.clientHeight,
      };
    }, { target: scrollTarget });

    if (!beforeState) return { moved: false, reason: 'missing-target' };

    const targetRemaining = Math.max(0, beforeState.height - beforeState.viewport - beforeState.top);
    const step = Math.max(1, Math.min(distance, targetRemaining || distance));

    const wheelX = clamp(Math.round(scrollTarget?.left != null ? scrollTarget.left + scrollTarget.width / 2 : viewport.width / 2), 1, Math.max(1, viewport.width - 1));
    const wheelY = clamp(Math.round(scrollTarget?.top  != null ? scrollTarget.top  + scrollTarget.height / 2 : viewport.height / 2), 1, Math.max(1, viewport.height - 1));

    try {
      await page.mouse.move(wheelX, wheelY);
      await page.mouse.wheel(0, step);
    } catch (_) {}

    const afterWheel = await page.evaluate(({ target }) => {
      const scrollingElement = document.scrollingElement || document.documentElement;
      const resolveTarget = () => {
        if (!target || target.marker === '__document__') return scrollingElement;
        return document.querySelector(`[data-immo-scroll-marker="${target.marker}"]`);
      };
      const element    = resolveTarget();
      if (!element) return null;
      const isDocument = element === scrollingElement;
      return {
        top:    isDocument ? window.scrollY || scrollingElement.scrollTop || 0 : element.scrollTop,
        height: isDocument ? scrollingElement.scrollHeight : element.scrollHeight,
      };
    }, { target: scrollTarget });

    if (afterWheel && afterWheel.top !== beforeState.top) {
      return {
        moved: true, reason: 'moved',
        beforeTop: beforeState.top, afterTop: afterWheel.top,
        beforeHeight: beforeState.height, afterHeight: afterWheel.height,
        remaining: targetRemaining, step,
        targetKind: beforeState.isDocument ? 'document' : 'element', inputKind: 'wheel',
      };
    }

    // Wheel did not move — fall back to DOM scrollBy
    const fallbackResult = await page.evaluate(({ target, distance }) => {
      const scrollingElement = document.scrollingElement || document.documentElement;
      const resolveTarget = () => {
        if (!target || target.marker === '__document__') return scrollingElement;
        return document.querySelector(`[data-immo-scroll-marker="${target.marker}"]`);
      };
      const element = resolveTarget();
      if (!element) return { moved: false, reason: 'missing-target' };
      const isDocument     = element === scrollingElement;
      const beforeTop      = isDocument ? window.scrollY || scrollingElement.scrollTop || 0 : element.scrollTop;
      const beforeHeight   = isDocument ? scrollingElement.scrollHeight : element.scrollHeight;
      const beforeViewport = isDocument ? (window.innerHeight || document.documentElement.clientHeight || 0) : element.clientHeight;
      const beforeRemaining = Math.max(0, beforeHeight - beforeViewport - beforeTop);
      if (beforeRemaining <= 0) return { moved: false, reason: 'at-end', beforeTop, afterTop: beforeTop, beforeHeight, afterHeight: beforeHeight, remaining: beforeRemaining };
      const step = Math.max(1, Math.min(distance, beforeRemaining));
      if (isDocument) { window.scrollBy(0, step); window.dispatchEvent(new Event('scroll')); }
      else { element.scrollBy({ top: step, behavior: 'instant' }); element.dispatchEvent(new Event('scroll', { bubbles: true })); }
      const afterTop    = isDocument ? window.scrollY || scrollingElement.scrollTop || 0 : element.scrollTop;
      const afterHeight = isDocument ? scrollingElement.scrollHeight : element.scrollHeight;
      return {
        moved: afterTop !== beforeTop, reason: afterTop !== beforeTop ? 'moved' : 'stalled',
        beforeTop, afterTop, beforeHeight, afterHeight, remaining: beforeRemaining, step,
        targetKind: isDocument ? 'document' : 'element', inputKind: 'dom-scroll',
      };
    }, { target: scrollTarget, distance: step });

    return fallbackResult;
  } catch (err) {
    return { moved: false, reason: 'error', error: err.message };
  }
}

async function waitForScrollProgress(page, snapshot, scrollTarget, timeoutMs) {
  const timeout      = Math.max(800, timeoutMs || 0);
  const targetMarker = scrollTarget?.marker || null;

  try {
    await page.waitForFunction(
      ({ documentHeight, documentTop, targetMarker, targetTop, targetHeight }) => {
        const scrollingElement = document.scrollingElement || document.documentElement;
        const currentHeight = scrollingElement ? scrollingElement.scrollHeight : document.documentElement.scrollHeight;
        const currentTop    = window.scrollY || (scrollingElement ? scrollingElement.scrollTop : document.documentElement.scrollTop) || 0;
        if (targetMarker && targetMarker !== '__document__') {
          const target = document.querySelector(`[data-immo-scroll-marker="${targetMarker}"]`);
          if (target) return target.scrollTop !== targetTop || target.scrollHeight !== targetHeight || currentHeight !== documentHeight || currentTop !== documentTop;
        }
        return currentHeight !== documentHeight || currentTop !== documentTop;
      },
      {
        documentHeight: snapshot?.documentHeight || 0,
        documentTop:    snapshot?.documentTop    || 0,
        targetMarker,
        targetTop:    scrollTarget?.scrollTop   ?? 0,
        targetHeight: scrollTarget?.scrollHeight ?? 0,
      },
      { timeout, polling: 100 }
    );
    return true;
  } catch (_) {
    return false;
  }
}

async function waitForNetworkSettling(page, timeoutMs = 3000) {
  try {
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: timeoutMs }),
      page.waitForTimeout(timeoutMs),
    ]);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// DB sync
// ---------------------------------------------------------------------------

const DB_FETCH_CHUNK_SIZE  = Number.parseInt(process.env.DB_FETCH_CHUNK_SIZE  || '120', 10);
const DB_UPSERT_CHUNK_SIZE = Number.parseInt(process.env.DB_UPSERT_CHUNK_SIZE || '100', 10);
const DB_REQUEST_RETRIES   = Number.parseInt(process.env.DB_REQUEST_RETRIES   || '2',   10);

function chunkArray(items, chunkSize) {
  const size = Math.max(1, Number.isFinite(chunkSize) ? chunkSize : 1);
  const out  = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function withRetry(fn, retries, label) {
  const maxRetries = Math.max(0, Number.isFinite(retries) ? retries : 0);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      console.warn(`[DB] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
}

async function syncListings(db, listings, sourceLabel) {
  if (!listings.length) {
    console.log(`${sourceLabel} No listings to sync.`);
    return { newCount: 0, updatedCount: 0 };
  }

  console.log(`\n[DB]${sourceLabel} Syncing ${listings.length} listings...`);

  const ids      = listings.map((l) => l.id);
  const idChunks = chunkArray(ids, DB_FETCH_CHUNK_SIZE);
  const existingRows = [];

  for (let i = 0; i < idChunks.length; i++) {
    const inFilter = `in.(${idChunks[i].join(',')})`;
    const params   = new URLSearchParams({
      select: 'id,price,currency,status,personal_status,snooze_until,note,first_seen',
      id:     inFilter,
    });
    const url = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/listings?${params}`;

    const rows = await withRetry(async () => {
      const res = await fetch(url, {
        headers: {
          apikey:        process.env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`[DB] Batch fetch failed (${res.status}): ${body}`);
      }
      return res.json();
    }, DB_REQUEST_RETRIES, `${sourceLabel} existing-rows chunk ${i + 1}/${idChunks.length}`);

    existingRows.push(...rows);
  }

  const existingMap      = new Map(existingRows.map((r) => [r.id, r]));
  const priceHistoryRows = [];

  const payloads = listings.map((raw) => {
    const normalized = normalizeListing(raw);
    const existing   = existingMap.get(normalized.id) || null;
    const payload    = mergeForUpsert(normalized, existing);

    if (existing && existing.price != null && payload.price != null && existing.price !== payload.price) {
      priceHistoryRows.push({
        listing_id: payload.id,
        old_price:  existing.price,
        new_price:  payload.price,
        currency:   payload.currency,
      });
    }

    return payload;
  });

  const payloadChunks = chunkArray(payloads, DB_UPSERT_CHUNK_SIZE);
  for (let i = 0; i < payloadChunks.length; i++) {
    await withRetry(
      () => db.upsert('listings', payloadChunks[i]),
      DB_REQUEST_RETRIES,
      `${sourceLabel} upsert chunk ${i + 1}/${payloadChunks.length}`
    );
  }

  if (priceHistoryRows.length) {
    try {
      await db.insert('price_history', priceHistoryRows);
      console.log(`[DB]${sourceLabel} Recorded ${priceHistoryRows.length} price change(s)`);
    } catch (err) {
      console.error(`[DB]${sourceLabel} price_history insert failed: ${err.message}`);
    }
  }

  const newCount     = payloads.filter((p) => !existingMap.has(p.id)).length;
  const updatedCount = payloads.length - newCount;

  console.log(`[DB]${sourceLabel} ✅ ${newCount} new, ${updatedCount} updated`);
  return { newCount, updatedCount };
}

// ---------------------------------------------------------------------------
// Single-source scrape — returns enriched stats for Discord alert
// ---------------------------------------------------------------------------

async function scrapeSource({ source, browser, db, options, sourceLabel }) {
  const allListings       = new Map();
  const orderedListingIds = [];

  // Per-URL result objects accumulated for the Discord report
  const urlResults = [];

  const targets = source.getTargets({ urls: options.urls || [], env: process.env });

  if (!targets.length) {
    console.log(`⚠️  ${sourceLabel} No target URLs configured`);
    return { newCount: 0, updatedCount: 0, skipped: true, skipReason: 'no-targets', urlResults };
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🎯 ${sourceLabel} ${source.name} — ${targets.length} target(s)`);

  const context = await browser.newContext({ viewport: BROWSER_VIEWPORT, userAgent: USER_AGENT });

  try {
    const authLoaded = await loadCookiesIfExist(context, source);

    if (source.loginRequired && !authLoaded) {
      return { newCount: 0, updatedCount: 0, skipped: true, skipReason: 'no-cookies', urlResults };
    }

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(BROWSER_NAVIGATION_TIMEOUT);
    page.setDefaultTimeout(BROWSER_INTERACTION_TIMEOUT);

    for (const targetUrl of targets) {
      const cleanUrl = source.normalizeTargetUrl(targetUrl);
      console.log(`\n🛰️  ${sourceLabel} Scraping: ${cleanUrl}`);

      // Per-URL stat object — mutated throughout the scrape loop
      const urlStat = {
        url:           cleanUrl,
        listingCount:  0,
        scrollAttempts: 0,
        scrollFallback: false,   // true if engine switched to document mid-run
        sessionExpired: false,
        error:         null,
        warnings:      [],
      };

      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_NAVIGATION_TIMEOUT });
        await page.waitForTimeout(source.initialDelayMs ?? 6000);

        const currentUrl = page.url();
        if (source.loginRequired && (currentUrl.includes('login') || currentUrl.includes('checkpoint'))) {
          console.log(`❌ ${sourceLabel} Session expired — run: npm run login -- --source ${source.id}`);
          urlStat.sessionExpired = true;
          urlStat.warnings.push('Session expired — cookies need refresh');
          urlResults.push(urlStat);
          continue;
        }

        console.log(`✅ ${sourceLabel} Page loaded`);

        if (typeof source.beforeExtract === 'function') {
          try {
            await source.beforeExtract(page, { sourceLabel });
          } catch (err) {
            console.log(`⚠️  ${sourceLabel} Pre-extract wait failed: ${err.message}`);
          }
        }

        await installScrollTelemetry(page);

        let scrollState        = await inspectScrollState(page);
        let scrollPref         = source.scrollTargetPreference || 'auto';
        let activeScrollTarget = pickScrollTarget(scrollState, null, scrollPref);
        console.log(`📜 ${sourceLabel} Scroll target: ${describeScrollTarget(activeScrollTarget)}`);

        // ── DEBUG: log scroll candidates (DEBUG_SCROLL=1) ────────────────
        if (process.env.DEBUG_SCROLL) {
          console.log(`[DEBUG]${sourceLabel} Scroll candidates:`);
          for (const c of scrollState.candidates) {
            console.log(`  score=${String(c.score).padStart(5)} | ${c.tagName}${c.role ? `[role=${c.role}]` : ''} | remaining=${c.remaining} | isDoc=${c.isDocument}`);
          }
        }
        // ─────────────────────────────────────────────────────────────────

        const countBefore = allListings.size;

        const initial = await source.extractListings(page);
        for (const l of initial) {
          if (!allListings.has(l.id)) orderedListingIds.push(l.id);
          allListings.set(l.id, l);
        }
        if (initial.length) console.log(`   ${sourceLabel} Initial snapshot: ${allListings.size} total`);

        const scrollSafetyLimit  = source.scrollSafetyLimit ?? 50;
        const noProgressLimit    = source.scrollIdleRounds  ?? 4;
        const settleTimeoutMs    = source.scrollSettleMs    ?? source.scrollDelayMs ?? 2500;

        let stagnantRounds      = 0;
        let movedNoGrowthRounds = 0;
        let attempts            = 0;

        while (attempts < scrollSafetyLimit) {
          attempts++;
          const beforeState  = scrollState;
          activeScrollTarget = pickScrollTarget(beforeState, activeScrollTarget, scrollPref);
          const distance     = resolveScrollDistance(source, beforeState, activeScrollTarget);
          const scrollResult = await performSmartScroll(page, activeScrollTarget, distance);
          await waitForScrollProgress(page, beforeState, activeScrollTarget, settleTimeoutMs);
          await waitForNetworkSettling(page, settleTimeoutMs);
          scrollState = await inspectScrollState(page);

          const listings    = await source.extractListings(page);
          const beforeTotal = allListings.size;
          for (const l of listings) {
            if (!allListings.has(l.id)) orderedListingIds.push(l.id);
            allListings.set(l.id, l);
          }
          const afterTotal    = allListings.size;
          const listingGrowth = afterTotal - beforeTotal;
          const documentMoved = scrollState.documentTop !== beforeState.documentTop
                             || scrollState.documentHeight !== beforeState.documentHeight;
          const moved         = scrollResult.moved || documentMoved;

          if (listingGrowth > 0) {
            stagnantRounds      = 0;
            movedNoGrowthRounds = 0;
          } else if (moved) {
            movedNoGrowthRounds++;
            stagnantRounds = 0;

            if (
              movedNoGrowthRounds >= 2 &&
              scrollPref !== 'document' &&
              activeScrollTarget &&
              !activeScrollTarget.isDocument
            ) {
              console.log(`⚠️  ${sourceLabel} Scroll moved but no new items for ${movedNoGrowthRounds} rounds — switching to document scroll`);
              urlStat.scrollFallback = true;
              scrollPref             = 'document';
              movedNoGrowthRounds    = 0;
            }
          } else {
            stagnantRounds++;
            movedNoGrowthRounds = 0;
          }

          console.log(`   ${sourceLabel} Attempt ${String(attempts).padStart(2)}: ${afterTotal} total${listingGrowth > 0 ? ` (+${listingGrowth})` : ''} | ${describeScrollTarget(activeScrollTarget)} | ${scrollResult.reason}`);

          if (stagnantRounds >= noProgressLimit) {
            console.log(`🛑 ${sourceLabel} No new content after ${stagnantRounds} stagnant rounds`);
            break;
          }
          if (scrollResult.reason === 'at-end' && stagnantRounds >= noProgressLimit) {
            console.log(`🛑 ${sourceLabel} Feed end reached`);
            break;
          }
          if (!scrollState.hasScrollableTargets && stagnantRounds > 0) {
            console.log(`🛑 ${sourceLabel} No scrollable target`);
            break;
          }
        }

        urlStat.scrollAttempts = attempts;
        urlStat.listingCount   = allListings.size - countBefore;

        // Low-listing warning
        if (urlStat.listingCount < LOW_LISTING_THRESHOLD) {
          const msg = `Only ${urlStat.listingCount} listing(s) found (threshold: ${LOW_LISTING_THRESHOLD})`;
          console.log(`⚠️  ${sourceLabel} ${msg}`);
          urlStat.warnings.push(msg);
        }

        // Only surface the fallback when we did not recover any listings.
        if (urlStat.scrollFallback && urlStat.listingCount === 0) {
          urlStat.warnings.push('Scroll target auto-corrected to document (possible DOM change)');
        }

      } catch (err) {
        console.error(`❌ ${sourceLabel} Error on ${cleanUrl}: ${err.message}`);
        urlStat.error = err.message;
      }

      urlResults.push(urlStat);
    }

    const finalListings = orderedListingIds.map((id) => allListings.get(id)).filter(Boolean);
    const { newCount, updatedCount } = await syncListings(db, finalListings, sourceLabel);
    return { newCount, updatedCount, skipped: false, urlResults };

  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

async function runScrapePipeline({ sources, db, options = {} }) {
  const launchOptions = buildLaunchOptions(options.headless);
  console.log(`\n🌐 Launching browser (headless=${launchOptions.headless})...`);
  const browser = await chromium.launch(launchOptions);
  console.log('✅ Browser launched\n');

  const summary = [];

  try {
    for (const source of sources) {
      const sourceLabel = `[${source.id.toUpperCase().replace(/-/g, '_')}]`;
      try {
        const result = await scrapeSource({ source, browser, db, options, sourceLabel });
        summary.push({ id: source.id, name: source.name, ...result });
      } catch (err) {
        console.error(`\n💥 ${sourceLabel} Unexpected error: ${err.message}`);
        summary.push({ id: source.id, name: source.name, newCount: 0, updatedCount: 0, error: err.message, urlResults: [] });
      }
    }
  } finally {
    await browser.close();
    console.log('\n🧹 Browser closed');
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 Run summary');
  console.log('─'.repeat(60));
  for (const row of summary) {
    if (row.error)        console.log(`  ${row.id.padEnd(25)} ❌ ${row.error}`);
    else if (row.skipped) console.log(`  ${row.id.padEnd(25)} ⏭️  skipped (${row.skipReason})`);
    else                  console.log(`  ${row.id.padEnd(25)} ✅ ${row.newCount} new, ${row.updatedCount} updated`);
  }
  console.log('═'.repeat(60));

  return summary;
}

module.exports = { runScrapePipeline, getCookiesPath, buildLaunchOptions };