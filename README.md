# daCommunity Gallery

Static gallery for the [daCAT daCommunity](https://opensea.io/collection/rodeo-posts-12142) ERC-1155 collection on Base, plus a collections hub for upcoming **Badges** (Ethereum).

**Live site:** https://ericmoz.github.io/dacommunity-gallery/

| Route | Purpose |
|-------|---------|
| `/` | **Home** — Collections, film, analytics |
| `/collections/` | **Collections** — daCommunity + Badges picker |
| `/dacommunity/` | Full gallery, search/filters, collector lookup, shareable `?wallet=` links |
| `/badges/` | Badges coming-soon placeholder |
| `/analytics/` | Cat Coin market cap bar chart race (Flourish embed) |
| `/film/` | Films hub |
| `/film/mozvane/` | Mozvane community film (YouTube) |

## Features

- **Browse archive** — Search by name, story, or token #; filter (all / for sale / not listed / recent moves); sort (token #, price, transfer date, name).
- **Collector lookup** — Enter ENS or `0x` address (no wallet connect). Clear (×) on the lookup field if the UI gets stuck.
- **Portfolio view** — Dark “cinema” grid for one collector’s holdings; compact filter/sort panel; exit chip returns to full archive.
- **Shareable links** — `?wallet=0x…` opens a collector portfolio; `#wallet-panel` scrolls to lookup.
- **Detail drawer** — Holders, transfers, OpenSea link; background merge fills activity after first paint.
- **PWA shell** — Light offline cache for HTML/CSS/JS; gallery JSON is network-first.

Footer on the home page shows **Site build YYYYMMDD-N**. If the live site looks stale, hard-refresh (Ctrl+Shift+R) or check that build id against the latest deploy.

## Architecture

Static-first: no app server in production. GitHub Pages serves `web/`; chain data is pre-fetched into JSON.

```
OpenSea API v2  ──►  Python (backend/)  ──►  web/data/*.json
                                              │
                                              ▼
                                    GitHub Pages (web/)
```

| Piece | Role |
|-------|------|
| **`fetch_gallery_data.py`** | Full refresh → `gallery_data.json`, `wallet_index.json` |
| **`build_catalog.py`** | Slim `gallery_catalog.json` for fast first paint |
| **`gallery_meta.json`** | Refresh status / staleness banner |
| **`app.js`** | Catalog → full merge → wallet index; browse state; collector view; dark mode via `body.has-collector-view` |

**Contract:** `0x64c30f84ed17e45e349b25c9dc02d7d2fd8081b1` (Base) · Steward: `dacatdreams.base.eth`

### Frontend map (`web/`)

| File | Role |
|------|------|
| `dacommunity/index.html` | Gallery shell: hero, `#wallet-panel`, `#browse-controls`, grid, detail drawer |
| `css/styles.css` | Layout, browse/search, collector portfolio (dark), modals |
| `js/app.js` | Data load, search/filter/sort, wallet lookup, URL sync |
| `js/pwa-register.js` | Service worker registration |
| `sw.js` | Cache shell; `CACHE` name tied to deploy build id |

## Local preview

Browsers block `fetch()` on `file://` — serve `web/`:

```powershell
cd web
python -m http.server 8080
```

Open http://localhost:8080/dacommunity/ for the gallery. On Windows, `start-gallery.bat` at the repo root is a shortcut.

## Refresh data from OpenSea

```powershell
cd backend
pip install -r requirements.txt
copy .env.example .env   # OPENSEA_API_KEY from https://docs.opensea.io/reference/api-keys
python fetch_gallery_data.py
python merge_local_images.py   # optional
```

Or: `.\scripts\refresh.ps1` (fetch + merge + local server).

- `--quick` skips listings, owners, and wallet index (~faster).
- Full run ~5–8 minutes.

After a transfer, run a full fetch so `recent_activity` and holders update. QA one token:

```powershell
cd backend
python ../scripts/verify_piece_activity.py --token 47 --expect-from mozvane.eth --expect-to 0x3e43287a26acf9e5206f4551ccda29c7d9bea93e
```

## Deploy & cache busting

GitHub Pages and browsers can cache HTML/CSS/JS. Every **Deploy gallery to GitHub Pages** run executes `scripts/bump_deploy_version.py`, which:

1. Increments `web/VERSION.txt` (e.g. `20260604-3`)
2. Writes `web/BUILD.json` with timestamp
3. Updates `?v=` on CSS/JS in HTML pages
4. Bumps `sw.js` `CACHE` name
5. Updates **Site build …** in footers

**Manual bump before push (optional):**

```powershell
.\scripts\bump-deploy.ps1
git add web/
git commit -m "chore: bump deploy build"
git push
```

Push to `main` triggers deploy. **Actions** also runs a daily data refresh when `OPENSEA_API_KEY` is set.

## Security

- **Never commit** `backend/.env` (gitignored). Use GitHub secret `OPENSEA_API_KEY` for CI.
- [Repository secrets](https://github.com/EricMoz/dacommunity-gallery/settings/secrets/actions) — missing/expired keys fail refresh in ~2s; the site shows a staleness banner from `gallery_meta.json`.
- **New listing today?** `cd backend && python patch_listings.py` until the nightly job runs.
- API keys are not used in the browser; the public site only reads static JSON.

## Repo layout

```
backend/          OpenSea fetch, catalog build, enrich helpers
web/              Static site (HTML, CSS, JS, data, assets)
  dacommunity/    Main gallery (app.js uses ../data paths)
.github/workflows Deploy Pages + daily data refresh
scripts/          bump_deploy_version.py, refresh.ps1, verify_piece_activity.py
```

## CI

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `deploy-pages.yml` | Push to `main`, manual | Bump build stamp, verify files, publish `web/` |
| `refresh-data.yml` | Daily cron, manual | Fetch OpenSea → commit JSON |

Requires Git LFS for NFT images under `web/assets/`.