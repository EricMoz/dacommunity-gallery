# daCAT Universe Hub

This is a static site that serves as the interactive hub for the daCAT community. You can browse the full NFT archive, look up any collector's pieces by wallet or ENS, watch films in an immersive player, and follow live market cap races â€” all without connecting a wallet or talking to a server from your browser.

**Live production:** [universe.dacat.fun](https://universe.dacat.fun)  
Source of truth + GitHub Pages: [ericmoz.github.io/dacommunity-gallery](https://ericmoz.github.io/dacommunity-gallery)

Everything runs on GitHub Pages. The site pulls data once a day through automated scripts, turns it into small JSON files, and serves a polished experience that feels dynamic even though it's just files. It exists because the community has real stories, films, and collectibles spread across chains, and we wanted one reliable place to explore them that doesn't require setup or cost anything to keep running.

## What makes this different

- It's completely static. No backend, no database, no server costs after deployment.
- Data updates are fully automated and happen daily in CI. You don't babysit anything.
- OpenSea access is automated in CI: mint a short-lived key once, **store** it, **reuse** it on later runs, and **replace** it only when a new mint succeeds (no monthly manual rotation).
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

OpenSea keys never reach the browser. The daily Action (`refresh-data.yml`) keeps a short-lived instant key in **GitHub Actions cache** (not in the repo):

1. **Restore** the last successful key from cache
2. **Reuse** it while it still has life left (avoids OpenSea's ~2 mints/day/IP limit on shared runners)
3. When it is near expiry (or missing), **mint** a new key via `POST /api/v2/auth/keys`
4. On a successful mint, **replace** the stored key; after a successful API probe, save it back to cache

No monthly hand-rotation. Optional repo secret `OPENSEA_API_KEY` is only an emergency override.

All fetching happens in GitHub Actions. The published site is static HTML/CSS/JS/JSON only — no keys and no OpenSea calls from the browser. Staleness is surfaced via `gallery_meta.json` banners.

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

**dacat.fun Â· dacatworld Â· dacat.store Â· universe.dacat.fun**

## Deploy & cache busting

GitHub Pages and browsers can cache assets. Each push to `main` runs **Deploy gallery to GitHub Pages**, which executes `scripts/bump_deploy_version.py` before upload:

| Updated | Purpose |
|---------|---------|
| `web/VERSION.txt` | Canonical build id |
| `web/BUILD.json` | Build id + UTC timestamp |
| `?v=` on CSS/JS in HTML | Browser cache bust |
| `sw.js` `CACHE` constant | Service worker invalidation |
| `Site build â€¦` + `<meta name="site-build">` | Visible version on all pages |

**Manual bump before push:**

```powershell
.\scripts\bump-deploy.ps1
git add web/
git commit -m "chore: bump deploy build"
git push origin main
```

**If the site looks stale:** Compare footer build id to [latest commit](https://github.com/EricMoz/dacommunity-gallery). Hard-refresh, or DevTools â†’ Application â†’ clear site data once. CI may bump the id again on deploy (e.g. local `20260605-8` â†’ live `20260605-9`); any id higher than yours is current.

## Security & API Keys

- **Store / reuse / replace** — see `scripts/ci_resolve_opensea_key.sh` and the Security model section above. Instant keys last ~7 days; CI renews them without you.
- Key material lives only in Actions cache (`.ci/opensea_instant_key.json`, gitignored) and masked job logs — never committed.
- `.env` (local only) is gitignored — never commit.
- Live site: pure static JSON + vanilla JS; zero OpenSea keys in the browser.
- Stale data surfaces in `gallery_meta.json` (banner) and Actions logs.

## Repo layout

```
backend/          OpenSea fetch, catalog build, enrich helpers
web/              Static site (HTML, CSS, JS, data, assets)
  dacommunity/    Main gallery (app.js uses ../data paths)
  film/           Community theater (modal player + Theatre Mode)
  VERSION.txt     Deploy build id (auto-bumped in CI)
.github/workflows deploy-pages.yml, refresh-data.yml
scripts/          bump_deploy_version.py, ci_resolve_opensea_key.sh, refresh.ps1, verify_piece_activity.py
docs/             MAINTENANCE.md, COLLECTIONS.md, THEATRE.md
web/data/collections_registry.json   Live + upcoming collection manifest
web/data/videos.json                 Film catalog (shorts stay external)
```

## CI

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `deploy-pages.yml` | Push to `main`, manual | Bump build, cache LFS assets, publish `web/` |
| `refresh-data.yml` | Daily cron, manual | Fetch OpenSea â†’ commit JSON (`lfs: false`) |

NFT images live in Git LFS under `web/assets/`. **Refresh** never downloads LFS. **Deploy** restores a cached copy and only runs `git lfs pull` on cache miss or when `web/assets/` changes â€” daily JSON updates should not re-download the full image set.
