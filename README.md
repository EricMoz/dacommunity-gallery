# daCommunity Gallery

Static gallery for the [daCAT daCommunity](https://opensea.io/collection/rodeo-posts-12142) ERC-1155 collection on Base, plus a collections hub for upcoming **Badges** (Ethereum).

**Live site:** https://ericmoz.github.io/dacommunity-gallery/

Check the footer on any page for **Site build YYYYMMDD-N** (e.g. `20260605-8`). If yours is older after a deploy, hard-refresh (**Ctrl+Shift+R**) or try a private window.

| Route | Purpose |
|-------|---------|
| `/` | **Home** — Collections, film, analytics |
| `/collections/` | **Collections** — daCommunity + Badges picker |
| `/dacommunity/` | Gallery, search/filters, collector lookup, shareable `?wallet=` links |
| `/badges/` | Badges coming-soon placeholder |
| `/analytics/` | Cat Coin market cap bar chart race (Flourish embed) |
| `/film/` | **Films hub** — sticky search/filters, series grid, in-page player |
| `/film/mozvane/` | Mozvane community film (YouTube) |

## Features

- **Browse archive** — Search by name, story, or token #; filter (all / for sale / not listed / recent moves); sort (token #, price, transfer date, name).
- **My daCATs** — Nav link on every page → `dacommunity/#wallet-panel` (collector lookup).
- **Collector lookup** — ENS or `0x` address, no wallet connect. **×** clears the field and result card.
- **Portfolio view** — Dark cinema grid for one wallet (`?wallet=0x…`); search/filter in compact panel; exit returns to lookup with field cleared.
- **NFT detail drawer** — Readable dark theme in portfolio mode; holder badge **this portfolio** vs **latest transfer** in full archive.
- **Shareable links** — `?wallet=0x…` opens a portfolio; `#wallet-panel` scrolls to lookup.
- **PWA shell** — Offline-friendly shell; HTML/CSS/JS and `sw.js` cache names bump each deploy; gallery JSON is network-first.
- **Film hub** — Catalog from `data/videos.json`; search + series filters stay sticky under the top nav while browsing (`/film/`).
- **Nav hierarchy** — Collections + Film are primary hubs; one dashed-yellow `is-active` state; MC race demoted; My daCATs emphasized on home/gallery.

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
| **`app.js`** | Catalog → full merge → wallet index; browse + portfolio + detail drawer |

**Contract:** `0x64c30f84ed17e45e349b25c9dc02d7d2fd8081b1` (Base) · Steward: `dacatdreams.base.eth`

### Frontend (`web/`)

| File | Role |
|------|------|
| `dacommunity/index.html` | Gallery shell: hero, `#wallet-panel`, browse, grid, detail drawer |
| `css/styles.css` | Layout; `body.has-collector-view` = dark portfolio + detail theme |
| `js/app.js` | Data load, search/filter/sort, wallet URL sync, grid + detail UI |
| `js/film.js` | Film catalog, sticky header-height sync, modal player, up-next |
| `js/home.js` | Home-only community highlights |
| `js/pwa-register.js` | Registers `sw.js` with `?v=` from `<meta name="site-build">` |
| `sw.js` | Network-first for HTML/CSS/JS; `CACHE` bumped per deploy |
| `docs/MAINTENANCE.md` | **QA checklist**, sticky/nav pitfalls, regression notes for maintainers |

### `app.js` flow (maintainers)

1. `init()` → `loadCatalogFirst()` → `bootGallery()` → `bindUi()` (once).
2. Background: `refreshFullDataInBackground()`, `loadWalletIndex()`, `applyWalletFromUrl()`.
3. Portfolio: `setGalleryCollectorView()` sets `galleryCollectorView.tokenIds`; grid filters via `getFilteredItems()`.
4. Clicks: delegated on `#gallery-list` (`data-token-id` → `openDetail()`).
5. Holders in detail: `resolveHoldersList()` → `sortHoldersForDisplay()`; highlight via `holderHighlightAddress()` only (uses `tokenIds` in portfolio mode — do not call `resolveHoldersList` from there).

### Film hub (`film.js`)

1. Header height → CSS variable `--site-header-h` via `syncSiteHeaderHeight()` (also `ResizeObserver` on nav wrap).
2. `.film-sticky-deck` uses `position: sticky; top: var(--site-header-h)` — **do not** set `position: relative` on film header/deck (breaks follow-scroll). See `docs/MAINTENANCE.md`.
3. Catalog from `../data/videos.json`; deep link `?v=<id>` opens modal player.

## Local preview

Browsers block `fetch()` on `file://` — serve `web/`:

```powershell
cd web
python -m http.server 8080
```

Open http://localhost:8080/dacommunity/ for the gallery, or http://localhost:8080/film/ to QA sticky search. `start-gallery.bat` at the repo root is a Windows shortcut.

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

GitHub Pages and browsers can cache assets. Each push to `main` runs **Deploy gallery to GitHub Pages**, which executes `scripts/bump_deploy_version.py` before upload:

| Updated | Purpose |
|---------|---------|
| `web/VERSION.txt` | Canonical build id |
| `web/BUILD.json` | Build id + UTC timestamp |
| `?v=` on CSS/JS in HTML | Browser cache bust |
| `sw.js` `CACHE` constant | Service worker invalidation |
| `Site build …` + `<meta name="site-build">` | Visible version on all pages |

**Manual bump before push:**

```powershell
.\scripts\bump-deploy.ps1
git add web/
git commit -m "chore: bump deploy build"
git push origin main
```

**If the site looks stale:** Compare footer build id to [latest commit](https://github.com/EricMoz/dacommunity-gallery). Hard-refresh, or DevTools → Application → clear site data once. CI may bump the id again on deploy (e.g. local `20260605-8` → live `20260605-9`); any id higher than yours is current.

## Security

- **Never commit** `backend/.env` (gitignored). Use GitHub secret `OPENSEA_API_KEY` for CI.
- [Repository secrets](https://github.com/EricMoz/dacommunity-gallery/settings/secrets/actions) — missing/expired keys fail refresh quickly; staleness shows in `gallery_meta.json` banner.
- **New listing today?** `cd backend && python patch_listings.py` until the nightly job runs.
- API keys are not used in the browser; the public site only reads static JSON.

## Repo layout

```
backend/          OpenSea fetch, catalog build, enrich helpers
web/              Static site (HTML, CSS, JS, data, assets)
  dacommunity/    Main gallery (app.js uses ../data paths)
  VERSION.txt     Deploy build id (auto-bumped in CI)
.github/workflows deploy-pages.yml, refresh-data.yml
scripts/          bump_deploy_version.py, refresh.ps1, verify_piece_activity.py
docs/             MAINTENANCE.md — QA, sticky layout, nav, regression notes
```

## CI

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `deploy-pages.yml` | Push to `main`, manual | Bump build, `node --check` app.js, publish `web/` |
| `refresh-data.yml` | Daily cron, manual | Fetch OpenSea → commit JSON |

Requires Git LFS for NFT images under `web/assets/`.