# daCommunity Gallery

Static gallery for the [daCAT daCommunity](https://opensea.io/collection/rodeo-posts-12142) ERC-1155 collection on Base, plus a collections hub for upcoming **Badges** (Ethereum).

**Live site:** https://ericmoz.github.io/dacommunity-gallery/

Check the footer on any page for **Site build YYYYMMDD-N** (e.g. `20260605-8`). If yours is older after a deploy, hard-refresh (**Ctrl+Shift+R**) or try a private window.

| Route | Purpose |
|-------|---------|
| `/` | **Home** — Collections, film, analytics |
| `/collections/` | **Collections** — daCommunity + Badges picker |
| `/dacommunity/` | Gallery, search/filters, collector lookup, shareable `?wallet=` links |
| `/badges/` | **Badges** — cosmic coming-soon preview (Ethereum drop) |
| `/analytics/` | **MC race** — Flourish bar chart race + looping track cars in the background |
| `/film/` | **Films hub** — sticky search/filters, series grid, in-page player |
| `/film/mozvane/` | Mozvane — **Theatre mode** (immersive watch) |
| `/film/theatre/?v=` | Generic theatre route — **every catalog video on desktop** |

## Features

- **Browse archive** — Search by name, story, or token #; filter (all / for sale / not listed / recent moves); sort (token #, price, transfer date, name).
- **My daCATs** — Nav link on every page → `dacommunity/#wallet-panel` (collector lookup).
- **Collector lookup** — ENS or `0x` address, no wallet connect. **×** clears the field and result card.
- **Portfolio view** — Dark cinema grid for one wallet (`?wallet=0x…`); search/filter in compact panel; exit returns to lookup with field cleared.
- **NFT detail drawer** — Readable dark theme in portfolio mode; holder badge **this portfolio** vs **latest transfer** in full archive.
- **Shareable links** — `?wallet=0x…#wallet-panel` opens a portfolio aligned under the nav; `#wallet-panel` alone scrolls to the lookup hub.
- **PWA shell** — Offline-friendly shell; HTML/CSS/JS and `sw.js` cache names bump each deploy; gallery JSON is network-first.
- **Film hub** — Catalog from `data/videos.json`; search + series filters stay sticky under the top nav while browsing (`/film/`).
- **Nav hierarchy** — Collections + Film are primary hubs; one dashed-yellow `is-active` state; MC race demoted; My daCATs emphasized on home/gallery.
- **MC race** (`/analytics/`) — Flourish bar chart race; dashed track, checkered corners, and orbiting cars (dacat.drive + mascot) behind content. Mobile shows a slimmer panel gutter so cars peek at the edges; `prefers-reduced-motion` parks cars static.

## Mobile Experience (dacommunity Gallery)

**For everyone (users, contributors, anyone):**
The /dacommunity/ page is now much better on phones and small tablets (screens under 768px wide).
- In the normal light "archive" view: The top navigation and filter/search bar stay nicely at the top (using safe-area-inset for notches), the gallery grid and cards have good spacing and big enough tap targets, and everything scrolls cleanly without huge empty gaps or overlapping text.
- In the dark "collector/portfolio" view (when you click a wallet or "My daCATs"): A slim fixed top bar (the collector name, rank, piece count, share/copy buttons) stays at the very top of the screen even on notched phones. No giant "banner" or profile card eats up the screen. The filters and 2-column grid are compact but easy to use. Text doesn't collide. The dark cinema look stays premium but clean.

All the hard work for mobile was done in 3 small batches so desktop (PC) looks and works exactly the same as before (no complaints on big screens).

**For engineers / next person reading this:**
- Everything mobile is in css/styles.css under @media (max-width: 768px) and a nested <480px for the tiniest phones.
- Key techniques: position: fixed + top: env(safe-area-inset-top, 0) for the collector escape-bar (so it is "at the very top"), padding-top compensation on the theater-frame so content doesn't hide under the fixed bar, display: none !important for the large .collector-profile-card in mobile portfolio (so it doesn't act as a "huge banner" covering the screen — the slim escape-bar is the designed header), clamp() for fonts and gaps so it adapts, reduced padding/gap values only in the collector blocks, and :not(.is-portfolio-browse) for the light view filter bar sticky.
- The 640px block had some old collector rules — cleaned the dupe ones in this pass and consolidated into the 768px block with clear "Batch 1-3" comments.
- All collector mobile is scoped with body.has-collector-view so light archive view is not accidentally affected.
- See the big "=== dacommunity Mobile Responsiveness (Batches 1-3, <768px only) ===" comment at the top of the collector styles for the full story and "next engineer" tips.
- Test with browser dev tools device toolbar (320px, 360px, 375px, 414px, 480px, 768px) + real phones. Check safe-area, no overlaps, 44px+ tap targets, good rhythm, no huge empty space or collisions.
- Desktop rules are completely untouched.

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
| **`collections_registry.py`** | Load `web/data/collections_registry.json` — multi-collection manifest |
| **`fetch_gallery_data.py`** | Full refresh → `gallery_data.json`, `wallet_index.json` |
| **`build_catalog.py`** | Slim `gallery_catalog.json` for fast first paint |
| **`gallery_meta.json`** | Refresh status / staleness banner |
| **`app.js`** | Catalog → full merge → wallet index; browse + portfolio + detail drawer |

**Contract:** `0x64c30f84ed17e45e349b25c9dc02d7d2fd8081b1` (Base) · Steward: `dacatdreams.base.eth`

### Frontend (`web/`)

| File | Role |
|------|------|
| `dacommunity/index.html` | Gallery shell: hero, `#wallet-panel` anchor + `#wallet-lookup`, browse, grid, detail drawer |
| `css/styles.css` | Layout; `body.has-collector-view` = dark portfolio + detail theme |
| `js/app.js` | Data load, search/filter/sort, wallet URL sync, grid + detail UI |
| `js/film.js` | Film catalog, sticky header-height sync, modal player, up-next |
| `js/theatre.js` | Theatre mode (desktop): YT API player, lights down/up, up-next |
| `data/theatre_registry.json` | Per-film theatre theme + future `extras` hooks |
| `docs/THEATRE.md` | Theatre QA, lights-down chrome layout, data contract |
| `analytics/index.html` | MC race page — Flourish embed + `.analytics-race-scene` background |
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

### Theatre mode (`theatre.js`) — desktop only (769px+)

1. Hub modal links **🍿 Theatre mode** for every video; mobile uses hub player only.
2. **Lights down:** video stays bright; dim up-next chip **bottom-left**; **Lights up** pill **top-right** (see `docs/THEATRE.md` — do not stretch up-next full width).
3. **Lights up:** Random/Series up-next under player; flying popcorn background (niche easter egg).
4. **Back:** watch stack + `history.pushState` — previous film in session, else film hub with `?v=` entry.
5. Shares `dacat-film-upnext-mode` in `sessionStorage` with `film.js`.

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
docs/             MAINTENANCE.md, COLLECTIONS.md, THEATRE.md
web/data/collections_registry.json   Live + upcoming collection manifest
```

## CI

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `deploy-pages.yml` | Push to `main`, manual | Bump build, cache LFS assets, publish `web/` |
| `refresh-data.yml` | Daily cron, manual | Fetch OpenSea → commit JSON (`lfs: false`) |

NFT images live in Git LFS under `web/assets/`. **Refresh** never downloads LFS. **Deploy** restores a cached copy and only runs `git lfs pull` on cache miss or when `web/assets/` changes — daily JSON updates should not re-download the full image set.