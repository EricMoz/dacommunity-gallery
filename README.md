# daCAT Universe Hub

This is a static site that serves as the interactive hub for the daCAT community. You can browse the full NFT archive, look up any collector's pieces by wallet or ENS, watch films in an immersive player, and follow live market cap races — all without connecting a wallet or talking to a server from your browser.

**Live production:** [universe.dacat.fun](https://universe.dacat.fun)  
Source of truth + GitHub Pages: [ericmoz.github.io/dacommunity-gallery](https://ericmoz.github.io/dacommunity-gallery)

Everything runs on GitHub Pages. The site pulls data once a day through automated scripts, turns it into small JSON files, and serves a polished experience that feels dynamic even though it's just files. It exists because the community has real stories, films, and collectibles spread across chains, and we wanted one reliable place to explore them that doesn't require setup or cost anything to keep running.

## What makes this different

- It's completely static. No backend, no database, no server costs after deployment.
- Data updates are fully automated and happen daily in CI. You don't babysit anything.
- We avoid the usual security headaches around API keys by generating fresh temporary ones for every data pull instead of storing long-lived secrets.
- The whole thing is deliberately lightweight so it stays fast, cheap, and low-risk.
- **Video size & format are first-class design inputs.** Shorts stay on an external rail (YouTube Shorts). The main catalog + Theatre Mode are optimized for proper landscape viewing and the lights-down immersive experience. This is intentional, not an afterthought.

## Key features

- Full archive of the main daCommunity collection with search, filters, sorting, and price info.
- Collector lookup: type an ENS or address and instantly see their portfolio (with shareable links).
- Theatre Mode for desktop: lights-down immersive video player with up-next.
- Film hub with series filters, in-page modal player, and a dedicated Shorts rail.
- Live market cap race chart.
- PWA support for install and basic offline use.
- Clean mobile experience with the important navigation always available.

## How it works (high level)

A daily GitHub Action fetches the latest data from OpenSea, builds a few JSON files, and commits them. When anything changes on main, another workflow deploys the `web/` folder to GitHub Pages and bumps version stamps so browsers and the service worker pick up fresh content.

On the client, a small catalog file loads immediately for the first view. Richer data comes in afterward. All the UI logic (search, portfolios, player controls, filters) is vanilla JavaScript. No frameworks, no live API calls from the browser.

## Security model

The standout part is how we handle OpenSea access.

Most projects store a permanent API key in their repo or CI secrets. We don't. Every data refresh calls a public endpoint to get a short-lived key for that run only. The key is used once in the Action and then gone.

All the fetching and processing happens exclusively in GitHub Actions. The published site contains only static files — HTML, CSS, JS, and pre-built JSON. No keys, no secrets, and no external calls ever reach the user's browser.

This removes whole categories of risk: no key rotation problems, no chance of a leaked long-lived token, and a very small attack surface on the live site. Data freshness issues are clearly surfaced with banners so people know what they're looking at.

## Technical details

- Hosting: GitHub Pages with CDN (production fronted at universe.dacat.fun).
- Data pipeline: Daily CI job produces a tiny catalog for instant paint plus richer data files.
- Cache busting: Every deploy updates `?v=` on assets, service worker cache name, version files, and meta tags.
- Client code: Vanilla JS + CSS. No build step required for the frontend itself.
- Adding collections: Mostly a registry entry in `collections_registry.json` plus data. Live ones appear automatically in filters.
- See the `docs/` folder for maintenance notes, collection setup, and Theatre specifics.

## Local development

Serve from the web directory (file:// won't work for fetches):

```bash
cd web
python -m http.server 8080
# or npx serve
```

Open http://localhost:8080.

For backend data work (the real pipeline runs in CI):

```bash
cd backend
pip install -r requirements.txt
python fetch_gallery_data.py
```

## Contributing

PRs for polish, accessibility, new live collections (via the registry), film features, or docs are welcome.

Keep the focus on static-first, low ongoing cost, and nice details. Run the bump script locally before pushing changes that touch assets.

## Credits

Made for the daCAT community.

Art, stories, and films by Randy Chavez, DaKingsi, and everyone who's contributed to the universe.

The real home is at dacat.fun, along with the films and the community itself.

**dacat.fun · dacatworld · dacat.store · universe.dacat.fun**

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
  film/           Community theater (modal player + Theatre Mode)
  VERSION.txt     Deploy build id (auto-bumped in CI)
.github/workflows deploy-pages.yml, refresh-data.yml
scripts/          bump_deploy_version.py, refresh.ps1, verify_piece_activity.py
docs/             MAINTENANCE.md, COLLECTIONS.md, THEATRE.md
web/data/collections_registry.json   Live + upcoming collection manifest
web/data/videos.json                 Film catalog (shorts stay external)
```

## CI

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `deploy-pages.yml` | Push to `main`, manual | Bump build, cache LFS assets, publish `web/` |
| `refresh-data.yml` | Daily cron, manual | Fetch OpenSea → commit JSON (`lfs: false`) |

NFT images live in Git LFS under `web/assets/`. **Refresh** never downloads LFS. **Deploy** restores a cached copy and only runs `git lfs pull` on cache miss or when `web/assets/` changes — daily JSON updates should not re-download the full image set.
