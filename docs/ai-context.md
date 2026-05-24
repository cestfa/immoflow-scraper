# AI Context

This is a multi-source housing scraper. It scrapes listing data from one or
more websites and writes it into a Supabase database. Facebook Groups is the
first implemented source.

Read this file first in every session. It tells you where everything is and
what the rules are.

---

## Non-negotiables

- Do not change the Supabase schema without reading `docs/supabase-schema.md` first.
- Preserve user-managed fields on every upsert: `personal_status`, `snooze_until`, `note`.
- Preserve scraper fields on every upsert: `id`, `source`, `url`, `image_urls`,
  `address_raw`, `price`, `status`, `last_seen`, `last_scraped_at`.
- Do not add source-specific code to `src/core/pipeline.js`. Each source is
  isolated under `src/sources/<id>/index.js`.
- A new source must work without touching any existing file except `.env.example`
  and `docs/ai-context.md` (to add a note under "Registered sources").

---

## Runtime shape

| File | Role |
|------|------|
| `src/main.js` | Command router (`login`, `scrape`, `validate-fixtures`) |
| `src/core/pipeline.js` | Browser launch, per-source scrape loop, Supabase sync |
| `src/core/supabase.js` | Supabase client creation |
| `src/sources/loader.js` | Auto-discovers source modules (no registry to update) |
| `src/sources/<id>/index.js` | One source module per folder |
| `scripts/capture-fixture.js` | Captures a live page to HTML fixture |
| `scripts/validate-fixtures.js` | Runs fixture validation for all sources |
| `data/<id>/sample.html` | Saved HTML for offline parser testing |
| `data/<id>/sample.expected.json` | Expected parser output |
| `storage/<id>-cookies.json` | Login cookies per source |
| `.env` | Runtime credentials and target URLs |

---

## Source contract

Every source module must export these properties:

```js
module.exports = {
  id: 'source-id',            // unique, lowercase, kebab-case
  name: 'Human Name',
  loginRequired: true/false,
  loginUrl: 'https://...',    // only needed when loginRequired is true
  maxScrolls: 40,
  initialDelayMs: 6000,
  scrollDelayMs: 1500,
  scrollDistance: 800,
  normalizeTargetUrl(url),    // strips query params, returns clean URL
  getTargets({ urls, env }),  // returns array of target URLs
  extractListings(page),      // returns array of listing objects (see schema below)
  fixtures: {
    sampleHtmlPath,
    sampleExpectedPath,
  },
};
```

`extractListings` must return objects with at minimum:
```js
{
  id,            // "<source>_<externalId>" — stable across runs
  source,        // source module id string
  url,           // canonical listing URL or 'none'
  image_urls,    // string[] — may be empty []
  address_raw,   // full raw text (always set for unstructured sources)
  price,         // integer or null
  currency,      // 'CHF', 'EUR', etc.
  price_period,  // 'month' | 'week' | 'day' | 'total'
  rooms,         // numeric or null
  living_space_m2, // numeric or null
  floor,         // integer or null
  total_floors,  // integer or null
  street,        // string or null
  street_number, // string or null
  zip_code,      // string or null
  city,          // string or null
  country_code,  // 'CH', 'FR', etc.
  latitude,      // numeric or null
  longitude,     // numeric or null
  title,         // string or null
  description,   // string or null
  listing_type,  // 'rent' | 'buy' | 'share' | 'sublet' | 'unknown'
  property_type, // string or null
  available_from,// ISO date string or null
}
```

Fields `personal_status`, `snooze_until`, and `note` must NEVER appear in a
source's return value — the pipeline manages them separately.

---

## Cookie convention

Cookies for a source are stored at `storage/<source.id>-cookies.json`.
This is derived automatically by `getCookiesPath(source)` in `pipeline.js`.
Do not hardcode cookie paths anywhere.

To log in: `npm run login -- --source <id>`
To copy to VPS: `scp storage/<id>-cookies.json root@VPS:/root/immoflow-scraper/storage/`

---

## Env var convention

Each source reads its target URLs from an env variable named:
`<SOURCE_ID_UPPERCASE>_URLS`

Examples:
- `facebook-groups` → `FACEBOOK_GROUPS_URLS`
- `leboncoin` → `LEBONCOIN_URLS`
- `immoscout24` → `IMMOSCOUT24_URLS`

The source's `getTargets` function reads this variable from `env`.
Add new variables to `.env.example` when adding a source.

---

## Pipeline behaviour

- `npm run scrape` runs **all** registered sources in sequence.
- `npm run scrape -- --source <id>` runs a single source.
- If a source has `loginRequired: true` and no cookies file exists, that source
  is **skipped** and a warning is printed. Other sources continue.
- If a source throws during scraping, the error is logged and other sources
  continue. No single source can crash the whole run.
- The browser is launched once per run, shared across sources.
- Each source gets its own browser context (isolated cookies, state).

---

## Adding a new source

1. Read `docs/source-addition-playbook.md` for the full workflow.
2. Create `src/sources/<id>/index.js` using `docs/source-skeleton.md` as a template.
3. Capture a fixture: `npm run capture -- --source <id>`
4. Build the parser against the saved HTML.
5. Validate: `npm run validate -- --source <id>`
6. Add the env var to `.env.example`.
7. Add a one-line note to this file under "Registered sources" below.

---

## Registered sources

- `facebook-groups` — Facebook Groups feed. Requires login. Env: `FACEBOOK_GROUPS_URLS`.
  Reliably returns: `address_raw` (full post text), `price` (regex from text),
  `image_urls`. All other structured fields (rooms, surface, zip_code, city, …)
  are always null — free text is too unreliable to parse.
 - `facebook-marketplace` — Facebook Marketplace (property rentals). Requires login. Env: `FACEBOOK_MARKETPLACE_URLS`.
   Reliably returns: `address_raw`, `image_urls`, `price`. Structured fields (rooms, surface, zip_code, city)
   may be present but are often unavailable in marketplace listings.
- `petites-annonces` — Petitesannonces.ch location search results. No login required. Env: `PETITES_ANNONCES_URLS`.
  Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `street`, `street_number`, `zip_code`, `city`, `property_type`, `image_urls`.
- `immobilier-ch` — immobilier.ch Lausanne rental search results. No login required. Env: `IMMOBILIER_CH_URLS`.
  Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `street`, `street_number`, `zip_code`, `city`, `property_type`, `title`, `image_urls`.
- `room-estate` — Room Estate Lausanne room search results. No login required. Env: `ROOM_ESTATE_URLS`.
  Reliably returns: `address_raw`, `price`, `living_space_m2`, `floor`, `city`, `property_type`, `title`, `image_urls`.
- `regie-braun` — Régie Braun Lausanne rental search results. No login required. Env: `REGIE_BRAUN_URLS`.
  Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `street`, `street_number`, `city`, `property_type`, `title`, `image_urls`.
- `regie-duboux` — Régie Duboux rental listings (manual AJAX endpoint with card HTML payload). No login required. Env: `REGIE_DUBOUX_URLS`.
  Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `floor`, `city`, `property_type`, `title`, `image_urls`.
- `appartel` — Appartel Lausanne search results. No login required. Env: `APPARTEL_URLS`.
  Reliably returns: `address_raw`, `price`, `city`, `property_type`, `title`.
- `helvetia` — Helvetia Lausanne search results backed by Flatfox APIs. No login required. Env: `HELVETIA_URLS`.
  Prefer API data over rendered HTML; reliably returns `address_raw`, `price`, `rooms`, `living_space_m2`, `city`, `property_type`, `title`, `image_urls`, `available_from`.
- `derham` — Derham Lausanne rentals filtered by price and proximity. No login required. Env: `DERHAM_URLS`.
  Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `zip_code`, `city`, `property_type`.
- `myhomies` — myHOMIES Lausanne colocation search results. No login required. Env: `MYHOMIES_URLS`.
  Reliably returns: `address_raw`, `price`, `living_space_m2`, `zip_code`, `city`, `property_type`, `title`, `image_urls`, `available_from`.
- `flatfox` — Flatfox Lausanne rental search results. No login required. Env: `FLATFOX_URLS`.
  Uses Flatfox public APIs behind the search page; reliably returns `address_raw`, `price`, `rooms`, `living_space_m2`, `zip_code`, `city`, `property_type`, `title`, `image_urls`, `available_from`, `latitude`, `longitude`.
- `properstar` — Properstar Lausanne rental search results. No login required. Env: `PROPERSTAR_URLS`.
  Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `street`, `street_number`, `city`, `property_type`, `title`, `image_urls`.
- `acheter-louer` — Acheter-Louer Lausanne rental search results. No login required. Env: `ACHETER_LOUER_URLS`.
  Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `street`, `street_number`, `zip_code`, `city`, `property_type`, `title`, `description`.
- `dreamo` — Dreamo Lausanne rental search results. No login required. Env: `DREAMO_URLS`.
  Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `street`, `street_number`, `zip_code`, `city`, `property_type`, `title`, `description`, `image_urls`, `available_from`.
 - `naef` — Naef Immobilier Lausanne rental search results. No login required. Env: `NAEF_URLS`.
   Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `title`, `image_urls`.
 - `pbbg` — PBBG Lausanne rental search results. No login required. Env: `PBBG_URLS`.
   Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `title`, `image_urls`.
 - `regimo` — Regimo Lausanne rental listings. No login required. Env: `REGIMO_URLS`.
   Expected to return: `address_raw`, `price`, `rooms`, `living_space_m2`, `title`, `image_urls`.
   - `galland` — Galland 1889 selection (requires login). Env: `GALLAND_URLS`.
     Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `street`, `city`, `title`, `image_urls`.
   - `wg-gesucht` — WG-Gesucht Lausanne search results. No login required. Env: `WG_GESUCHT_URLS`.
     Reliably returns: `address_raw`, `price`, `rooms`, `living_space_m2`, `street`, `city`, `title`, `image_urls`.
