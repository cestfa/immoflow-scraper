# Hosting & Automation Guide

---

## How authentication works

Login sessions are stored as cookie files — one per source:

```
storage/<source-id>-cookies.json
```

The login command must be run on a machine with a graphical desktop
(Windows or macOS). Once cookies are saved, copy them to the VPS.
The VPS runs headless and reads the cookie file on every scrape.

```
1. Local machine:
   npm run login -- --source facebook-groups

2. Copy to VPS:
   scp storage/facebook-cookies.json root@VPS_IP:/root/immoflow-scraper/storage/

3. VPS:
   npm run scrape
```

Cookies expire after ~30 days. Repeat steps 1–2 to refresh.

---

## VPS setup (Ubuntu 22.04 / 24.04)

### 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v20.x.x
```

### 2. Clone and install

```bash
git clone https://github.com/guclusefa/immoflow-scraper.git
cd immoflow-scraper
npm install
npm run install:browsers   # installs Chromium + all required Linux libraries
```

`npm run install:browsers` = `npx playwright install chromium --with-deps`.
Run it once after cloning, and again after any Playwright version upgrade.

### 3. Create `.env`

```bash
cp .env.example .env
nano .env
```

Fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `FACEBOOK_GROUPS_URLS`.

### 4. Copy cookies

On your local machine (after `npm run login -- --source facebook-groups`):

```bash
scp storage/facebook-cookies.json root@YOUR_VPS_IP:/root/immoflow-scraper/storage/
```

### 5. Test

```bash
cd /root/immoflow-scraper
npm run scrape
```

### 6. Cron job

```bash
crontab -e
```

Add (find your npm path with `which npm`):

```
0 */6 * * * cd /root/immoflow-scraper && /usr/bin/npm run scrape >> /root/immoflow-scraper/scrape.log 2>&1
```

Check it's set: `crontab -l`
View logs: `tail -f /root/immoflow-scraper/scrape.log`

### 7. Discord alerts (optional)

Add these to `.env` on the VPS:

```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_ALERT_ON_SUCCESS=false
```

Behavior:

- The scraper always continues to run remaining sources even if one source fails.
- If any source fails, the overall command exits with a non-zero code after the run ends.
- A Discord alert is sent on failed runs (and on successful runs only if `DISCORD_ALERT_ON_SUCCESS=true`).
- Alert message includes per-source status (`OK`, `FAILED`, `SKIPPED`) plus new/updated counts.

---

## Cross-platform behaviour

The pipeline detects the environment automatically:

| Platform | Headless | Chrome flags |
|----------|----------|-------------|
| Windows / macOS | No* | None |
| Linux (no DISPLAY) | Yes | `--no-sandbox --disable-gpu …` |

\* Use `npm run scrape -- --headful` to force a visible window for debugging.

No conditional scripts or separate configs needed — the same code runs everywhere.

---

## Session refresh (every ~30 days)

When cookies expire, the scraper prints:

```
❌ [facebook-groups] Redirected to login — session expired.
   Run: npm run login -- --source facebook-groups
```

To fix:
1. On local machine: `npm run login -- --source facebook-groups`
2. Copy cookies: `scp storage/facebook-cookies.json root@VPS_IP:/root/immoflow-scraper/storage/`

Other sources continue running during a Facebook login outage.

---

## Adding a second source

When you add a new source:
1. Follow `docs/source-addition-playbook.md`.
2. Add the new `<ID>_URLS` env var to `.env` on the VPS.
3. If it requires login, run `npm run login -- --source <id>` locally and scp the cookies.
4. `npm run scrape` will pick it up automatically — no changes needed to cron or pipeline.

---

## Troubleshooting

**Scraper hangs after `📄 Page created`**
→ Chromium dependencies missing. Run: `npm run install:browsers`

**`npm: command not found` in cron**
→ Use full path. Find it: `which npm`. Update crontab accordingly.

**`Error: browserType.launch: Executable doesn't exist`**
→ Run: `npm run install:browsers`

**`SUPABASE_URL and SUPABASE_ANON_KEY must be set`**
→ Cron must `cd` into the project root so dotenv finds `.env`.

**Source skipped — no cookies**
→ Run login locally, scp the cookie file to the VPS.

**Source skipped — no target URLs**
→ Check `.env` — the variable name must be `<SOURCE_ID_UPPERCASE>_URLS`.
