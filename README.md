# daCAT Gallery & World

**Zero-cost, zero-friction, premium-feel static experience for the daCAT universe.**

A fully static GitHub Pages site delivering a rich NFT gallery, collector portfolio view, immersive Theatre Mode, film hub, and live analytics — all without a backend at runtime or any wallet connect.

- **Global archive** of the daCAT daCommunity (Base) + coming attractions (Badges on Ethereum)
- **Find your daCATs** instantly via ENS or 0x (shareable `?wallet=` links)
- **Theatre Mode** — lights-down immersive player for desktop
- **Daily fresh data** via pre-fetched OpenSea pipeline + aggressive cache-busting

**Live:** https://ericmoz.github.io/dacommunity-gallery/ (or the official mirror once promoted)

> Check any page footer for the **Site build** stamp (e.g. `20260613-6`). After a deploy, hard-refresh (`Ctrl+Shift+R` / `Cmd+Shift+R`) or use a private window if you see stale content.

## Why this project stands out

- **True static hosting** — GitHub Pages + CDN. $0 ongoing cost, instant deploys, no server to maintain.
- **Pre-fetched + bulletproof cache-busting** — Backend (Python) pulls OpenSea once per day into JSON. Every deploy bumps `?v=`, service worker `CACHE`, `<meta name="site-build">`, and all asset links so browsers/SW/CDN never serve old data or shell.
- **Vanilla JS doing "impossible" UX** — Complex gallery + dark cinema portfolio + sticky theatre player + share state + multi-collection awareness, all in a few small files. No frameworks, no build step for the frontend.
- **Zero-friction collector experience** — Look up any wallet, get a beautiful shareable link, no connect, no gas, works on mobile.
- **Thoughtful details everywhere** — Theatre lights, flying popcorn, precise safe-area padding, collector header that never gaps, price badges that never clip, smooth grid that respects min/max columns.
- **Registry-driven multi-collection ready** — `collections_registry.json` + status flags mean new live collections light up automatically in filters, pre-links, and share URLs (see Part 1 of recent updates).

## Routes

| Route                  | Experience |
|------------------------|------------|
| `/`                    | Home hub — quick cards to everything + subtle store promo |
| `/collections/`        | Collection picker (live gallery + coming-soon teasers) |
| `/dacommunity/`        | Main gallery + search/filters/sort + "Find your daCATs" wallet lookup + collector portfolio (`?wallet=...`) |
| `/badges/`             | Cosmic "Coming soon" teaser (static + starfield) |
| `/analytics/`          | MC race — Flourish bar chart + animated track cars |
| `/film/`               | Film hub — sticky search + series filters + in-page YT player + Theatre links |
| `/film/mozvane/`       | Dedicated Theatre Mode (desktop immersive) |
| `/film/theatre/?v=ID`  | Generic theatre route for any catalog video |

## Key Features (current)

- **Gallery** — Fast catalog first-paint, background full-data enrichment, live "for sale" / "recent transfers" filters, price sorting, search across name/story/token.
- **Collector Portfolio** — Dark cinema grid scoped to one wallet. Same filters work inside it. Clean exit back to lookup.
- **Wallet deep links** — `?wallet=0x...#wallet-panel` or `?ens=...` — opens lookup + portfolio instantly. Share buttons copy the full URL.
- **Multi-collection filter** (new) — Dropdown in the archive (only shows `status: "live"` entries from `collections_registry.json`). Pre-filter links from `/collections/` (`?collection=dacommunity`). "Find your daCATs" + share links respect the active collection.
- **Theatre Mode** — Lights-down experience, up-next, full controls when lights up, persistent preferences via sessionStorage. Mobile gracefully falls back to hub player.
- **Strong data freshness** — Daily OpenSea sync (see backend). Visible "last pull" + staleness banners. Network-first for JSON in SW.
- **PWA** — Installable, offline shell, versioned cache.

## Honest limitations

- **Not live data** — Gallery, ownership, listings, and transfers update once per day via GitHub Action (see `.github/workflows/refresh-data.yml`). Great for a premium static feel; not a real-time on-chain explorer.
- **Single primary collection today** — daCommunity is the only fully live gallery. Badges and future drops use the registry + "coming soon" pattern so nothing breaks when we flip the switch.
- **No wallet signing** — By design. This is a read-only community archive and discovery tool.
- **Desktop-heavy Theatre** — Full lights experience is 769px+. Mobile gets the excellent hub player instead.

## Architecture at a glance

```
OpenSea (daily)  →  backend/*.py  →  web/data/*.json  (catalog + full + wallet index + videos + registry)
                                                    ↓
                                          GitHub Pages (web/)
                                          (HTML + vanilla JS + CSS + SW)
```

- **Registry first** (`web/data/collections_registry.json` + `backend/collections_registry.py`) — single source for what is live vs preview.
- **Two-tier data** — `gallery_catalog.json` (tiny, instant paint) + `gallery_data.json` (rich, loaded in background).
- **Frontend** — `app.js` (gallery + collector), `film.js` + `theatre.js` (film), tiny page-specific scripts.
- **Cache discipline** — Every deploy runs `scripts/bump_deploy_version.py` which touches `?v=`, meta, SW `CACHE`, `VERSION.txt`, footers.
- **No build** for the web shell (pure static). Python only for data pipeline.

See `docs/MAINTENANCE.md`, `docs/COLLECTIONS.md`, `docs/THEATRE.md` for deeper maintainer notes.

## Local development

```bash
# Serve the web root (required — fetch() is blocked on file://)
cd web
python -m http.server 8080
# or
npx serve .
```

Open http://localhost:8080 (or the dacommunity subpath). Use `start-gallery.bat` on Windows for the same.

For data work:
```bash
cd backend
python -m pip install -r requirements.txt
# See refresh.ps1 / .github/workflows for the real daily path
```

## Contributing

PRs welcome for:
- Polish, accessibility, mobile edge cases
- New "live" entries in the registry + corresponding data
- Theatre / film enhancements
- Documentation

Please keep the "static first, zero ongoing cost, delightful details" spirit. Run the bump script locally before pushing if you changed shell assets so the build stamp advances.

## Credits

Built with love for the daCAT community by the same folks who bring you the comics, films, and chaos.

- Data pipeline & static discipline: the daCAT engineering crew
- Art & lore: Randy Chavez, DaKingsi, and the wider world
- Special thanks to everyone who minted, held, and created the stories that made an archive worth building.

Enjoy the gallery. Find your daCATs. Share the link. 

**dacat.fun · dacatworld · dacat.store**
```

Enjoy the gallery. Find your daCATs. Shop the store. Share the stories.

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