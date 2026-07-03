# daCAT Gallery & World

**Zero-cost, zero-friction, premium-feel static experience for the daCAT universe.**

A fully static GitHub Pages site delivering a rich NFT gallery, collector portfolio view, immersive Theatre Mode, film hub, and live analytics — all without a backend at runtime or any wallet connect.

- **Global archive** of the daCAT daCommunity (Base) + coming attractions (Badges on Ethereum)
- **Find your daCATs** instantly via ENS or 0x (shareable `?wallet=` links)
- **Theatre Mode** — lights-down immersive player for desktop
- **Fully automated daily data** — fresh OpenSea key generated on every run (no secrets), pre-fetched into JSON, aggressive cache-busting on deploy.

**Live:** https://ericmoz.github.io/dacommunity-gallery/ (or the official mirror once promoted)

> Check any page footer for the **Site build** stamp (e.g. `20260613-6`). After a deploy, hard-refresh (`Ctrl+Shift+R` / `Cmd+Shift+R`) or use a private window if you see stale content.

## Why this project stands out

- **Fully automated OpenSea data pipeline** — No secrets to rotate. Every run auto-generates a fresh temporary API key via the public endpoint (`/auth/keys`). Daily refresh (`.github/workflows/refresh-data.yml`) + badges + meta update → commit → deploy. Zero manual key management.
- **True static hosting** — GitHub Pages + CDN. $0 ongoing cost, instant deploys, no server runtime ever. All OpenSea work happens in CI only.
- **Pre-fetched + bulletproof cache-busting** — Backend pulls OpenSea into JSON once per day. Every deploy runs `scripts/bump_deploy_version.py` to touch `?v=`, SW `CACHE`, `VERSION.txt`, `<meta name="site-build">`, and footers. Browsers/SW/CDN get fresh content reliably.
- **Vanilla JS doing "impossible" UX** — Rich gallery, collector portfolios, sticky Theatre player, share links, multi-collection filters — all client-side with no frameworks or build step. Instant first paint from tiny `gallery_catalog.json`.
- **Zero-friction collector experience** — ENS or 0x lookup, beautiful shareable `?wallet=` links, no wallet connect or gas. Works everywhere.
- **Thoughtful details & polish** — Theatre "lights down" mode, flying popcorn, safe-area handling, pride bars, price badges, smooth grids, network-first SW for JSON.
- **Registry-driven & multi-collection ready** — `collections_registry.json` + `backend/collections_registry.py` make new live collections light up automatically in filters and links. Badges use the same archive patterns.
- **What makes the architecture notable** — Pre-computed static JSON from daily CI + vanilla frontend = premium feel with zero ongoing cost or live dependencies in the browser. Great model for other community archives.

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
- **Collector Portfolio** — Dark cinema grid scoped to one wallet. Same filters work inside it. Clean "Back to Archive" escape in profile card + pride bar (works for direct ?wallet= links from NFTs too).
- **Wallet deep links** — `?wallet=0x...#wallet-panel` or `?ens=...` — opens lookup + portfolio instantly. Share buttons copy the full URL. Mobile nav on collection pages includes Collections for easy navigation.
- **Multi-collection filter** (new) — Dropdown in the archive (only shows `status: "live"` entries from `collections_registry.json`). Pre-filter links from `/collections/` (`?collection=dacommunity`). "Find your daCATs" + share links respect the active collection.
- **Theatre Mode** — Lights-down experience, up-next, full controls when lights up, persistent preferences via sessionStorage. Mobile gracefully falls back to hub player.
- **Strong data freshness** — Daily OpenSea sync (see backend). Visible "last pull" + staleness banners. Network-first for JSON in SW.
- **PWA** — Installable, offline shell, versioned cache.

## Honest limitations

- **Not live data** — Everything is pre-fetched daily via GitHub Action (see `.github/workflows/refresh-data.yml`). Premium static feel with aggressive staleness banners. Not a real-time explorer.
- **Single primary collection today** — daCommunity (Base) is fully live. Badges (Ethereum) and future drops use `collections_registry.json` + "coming soon" so the UI lights them up cleanly.
- **No wallet signing** — By design. Pure read-only community archive.
- **Desktop-heavy Theatre** — Full "lights down" experience is 769px+. Mobile falls back gracefully to the hub player.

## Architecture at a glance

```
OpenSea (public /auth/keys + data) 
  ↓ (auto-generated fresh key every run)
GitHub Action (refresh-data.yml)
  → backend/*.py (fetch + enrich + badges)
  → web/data/*.json (catalog + full + wallet + meta + badges)
  → git commit + bump_deploy_version.py
  ↓
GitHub Pages (pure static: HTML + vanilla JS + CSS + SW)
```

**Key strengths that make this repo stand out to devs**:
- **Zero secret maintenance** — Daily pipeline auto-creates a short-lived OpenSea key via public endpoint. No long-lived tokens in repo or Actions.
- **Registry-driven** (`collections_registry.json`) — Adding a new live collection is mostly data + registry entry; UI lights up automatically.
- **Two-tier data + aggressive cache-busting** — Tiny catalog for instant paint, rich data loaded in background. Every deploy invalidates caches at browser/SW/CDN level.
- **Vanilla everything on the client** — No frameworks, no server, no live API calls. Complex UX (portfolios, Theatre, filters) all in small JS files.
- **Pre-computed static wins** — Daily CI does the heavy lifting. Site is fast, cheap, and delightful with almost zero runtime dependencies.
- See `docs/MAINTENANCE.md` for deeper notes, `docs/COLLECTIONS.md` for adding collections.

See `docs/MAINTENANCE.md` (especially the automated data pipeline section), `docs/COLLECTIONS.md`, `docs/THEATRE.md` for deeper maintainer notes.

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
# The real daily path is fully automated in .github/workflows/refresh-data.yml
# (no secrets needed — key is generated fresh each run)
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

## Refresh data from OpenSea (fully automated)

The daily data pipeline is **completely hands-off**:

- GitHub Actions auto-generates a fresh temporary OpenSea key every run (public `/auth/keys` endpoint).
- No repository secrets to create or rotate.
- Runs on schedule + manual dispatch.
- Updates all `web/data/*.json` (gallery + badges + meta).

Local dev (for testing changes):

```powershell
cd backend
pip install -r requirements.txt
python fetch_gallery_data.py
# (badges, etc. optional)
```

Use `.\scripts\refresh.ps1` for convenience.

- `--quick` skips listings/owners/wallet (~faster for iteration).
- Full run usually 5–15 min depending on collection size.

After a transfer or new drop, a full fetch populates `recent_activity`, holders, etc.

QA a specific change:

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

## Security & API Keys

- **No long-lived secrets required.** The CI workflow (`refresh-data.yml`) auto-generates a fresh temporary OpenSea key on every run using the public endpoint.
- `.env` (if used locally) is gitignored — never commit.
- All OpenSea calls happen only in the backend during the daily job. The live site is pure static JSON + vanilla JS — zero API keys or secrets ever reach the browser.
- Stale data or refresh problems surface clearly in `gallery_meta.json` (visible banner on site) and GitHub Actions logs.

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