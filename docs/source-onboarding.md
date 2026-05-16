# Source Onboarding

Use this workflow when adding a new source from a prompt like: `Add this source <url>`.

## Required inputs

- Base URL or example listing URL.
- Whether login is required.
- If login is required, what page the browser should open for manual auth.
- A sample listing page or saved HTML fixture.

## Implementation steps

1. Create a new source folder under `src/sources/<source>/`.
2. Export the source object from `src/sources/<source>/index.js`.
3. Define the source metadata and URL matching rule.
4. Implement `getTargets`, `normalizeTargetUrl`, and `extractListings`.
5. Add fixture HTML and expected JSON under `data/<source>/`.
6. Do not edit the registry when adding a source; the loader discovers folders automatically.
7. Keep the root entrypoint untouched; new sources should only extend the source folder set.
8. Add source-specific npm aliases in `package.json` when you want a quick repeatable run path, e.g. `scrape:<source>`, `capture:<source>`, `validate:<source>`.
9. Add a short note to `docs/ai-context.md` or a source-specific doc if the site has unusual rules.

## Login rule

- If login is needed, set `loginRequired: true` and define `loginUrl`.
- If login is not needed, leave `loginRequired: false` and do not require `storage/state.json`.

## Supabase rule

- Keep the database contract stable.
- The source should normalize into the existing listing shape rather than inventing new tables.

## Validation rule

- Every new source should have at least one saved fixture and one expected JSON file.
- Run `npm run validate` after parser changes.

## When starting fresh

- Read `docs/repo-map.md` for the file layout.
- Read `docs/source-addition-playbook.md` for the full add-source workflow.
- Read `docs/source-skeleton.md` for the starting module template.
