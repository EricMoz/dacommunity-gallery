# Maintenance & QA Guide

Engineering notes for the daCommunity Gallery static site (`web/`). Read this before changing layout, nav, or sticky behavior.

**Live:** https://ericmoz.github.io/dacommunity-gallery/  
**Build id:** footer `Site build YYYYMMDD-N` on every page (also `<meta name="site-build">`).

---

## Film hub (`/film/`) — sticky search bar

### Expected behavior

1. **Site header** (black nav) stays pinned at `top: 0` while scrolling.
2. **Search + filter deck** (`.film-sticky-deck`) stays pinned directly under the header at `top: var(--site-header-h)`.
3. **Hero + catalog** scroll underneath; users can search/filter from anywhere on the page.

### DOM order (`web/film/index.html`)

```
.site-header
.film-sticky-deck          ← must be a sibling BEFORE main, not inside main
.film-hub-main             ← hero + catalog scroll away
```

Do **not** wrap header + deck in a single sticky container unless both must move as one unit. Users expect only the deck to “follow” after the hero scrolls past; the header uses its own `position: sticky`.

### CSS contract (`web/css/styles.css`)

| Selector | `position` | `top` | Notes |
|----------|------------|-------|-------|
| `.site-header` | `sticky` | `0` | Global rule |
| `.film-hub-page .film-sticky-deck` | `sticky` | `var(--site-header-h)` | `z-index: 90` |
| `.film-hub-page .site-header` | *(inherit sticky)* | `0` | `z-index: 100` only — **never** `position: relative` here |

### Critical pitfall — `position: relative` overrides sticky

A rule like `.film-theater .site-header { position: relative }` **silently disables** sticky positioning (higher specificity than `.site-header`). Same for `.film-sticky-deck`.

The vignette layer uses `position: fixed; z-index: 0`. Only assign `position: relative` to **scrolling content** (`.film-hub-main`, `.site-footer`), not to sticky chrome.

### JavaScript — header height sync

`--site-header-h` must match the rendered header height (including the 4px yellow border and wrapped nav rows). Set in:

- `web/js/film.js` — `syncSiteHeaderHeight()` + `ResizeObserver` on `.site-header`
- `web/js/app.js` — same pattern for gallery collector escape bar (`.collector-escape-bar`)

```js
const h = Math.ceil(header.getBoundingClientRect().height);
document.documentElement.style.setProperty("--site-header-h", h + "px");
```

If this function is missing but still called, the deck offset falls back to `4.35rem` and a visible gap appears on desktop.

### Manual QA checklist — film

- [ ] Hard-refresh `/film/`; footer build id is current.
- [ ] At top: header → search → hero (no extra slit between header and search).
- [ ] Scroll deep into catalog: search bar remains visible and flush under nav.
- [ ] Resize window / narrow nav wrap: no gap after resize (ResizeObserver).
- [ ] Mobile: filter chips wrap; deck still sticks; hint line hidden per CSS.
- [ ] `?v=` deep link opens modal; page scroll position sensible.
- [ ] DevTools console: no `syncSiteHeaderHeight is not defined`.
- [ ] Modal → **Play random** while a video plays: always loads a different title (not the same preview stuck).
- [ ] End-of-video countdown → **Play now** honors the previewed title.

---

## Top navigation

Nav markup is **duplicated** in each `web/**/index.html` (no shared partial yet). Any nav change must be applied to every page:

| Page | Path |
|------|------|
| Home | `web/index.html` |
| Collections | `web/collections/index.html` |
| Gallery | `web/dacommunity/index.html` |
| Film hub | `web/film/index.html` |
| Theatre mode | `web/film/theatre/index.html` (+ legacy redirect `web/film/mozvane/`) |
| Analytics | `web/analytics/index.html` |
| Badges | `web/badges/index.html` |

### Visual hierarchy (2026-07)

| Tier | Items | Style |
|------|-------|-------|
| Hubs | Collections, Film | Slightly larger; yellow hover border |
| Universe | Label for this site hub (`nav-btn-home`); brand logo → dacat.fun | Quiet entry (like former Home) |
| Contextual | My daCATs | Yellow text on gallery when inactive (not on Universe home) |
| Current page | One item only | `is-active` → dashed yellow border (not solid fill) |
| Demoted | MC race | Small, muted; omitted on `/film/` pages |
| Utility | OpenSea (home/gallery), TG | Quiet gray pills |

`app.js` toggles `.nav-btn-wallet.is-active` when collector portfolio view is open.

---

## Gallery collector view (`/dacommunity/`)

| Concern | Detail |
|---------|--------|
| Body class | `has-collector-view` |
| Hash anchor | `#wallet-panel` — zero-height anchor at top of `.collector-theater-frame` (share links) |
| Lookup form | `#wallet-lookup` — the collector hub section (was also `#wallet-panel`) |
| Sticky escape bar | `.collector-escape-bar` at `top: var(--site-header-h)` |
| Overflow | Do not set `overflow: hidden` on `.collector-theater-frame` — breaks sticky |
| Share URL | `syncWalletShareUrl()` keeps `?wallet=…#wallet-panel` canonical |
| Deep-link scroll | `?wallet=` URLs pin to top (inline + `applyWalletFromUrl`); portfolio mode uses `scrollTo(0)` after hero hides |

### Wallet deep-link QA (`?wallet=0x…#wallet-panel`)

**Scroll pitfall:** opening a portfolio from a scrolled archive leaves the old `scrollY` while the hero collapses — looks like a sticky-header offset. Fix: `scrollToCollectorTheaterTop` resets to `top: 0` when `galleryCollectorView` is active (refresh worked because inline `pinTop` already had `scrollY=0`).

- [ ] Hard-refresh share URL; escape bar flush under nav (no gap, no overscroll).
- [ ] “Your collection” + grid visible; hero hidden.
- [ ] No double-scroll jitter after catalog loads.
- [ ] Console: no errors; `syncSiteHeaderHeight` / `--site-header-h` reasonable in DevTools.
- [ ] “My daCATs” while in portfolio re-scrolls to theater top, not lookup form.
- [ ] Exit portfolio → scrolls to `#wallet-lookup` hub, field cleared.

### Scroll pitfalls (collector)

| Mistake | Symptom |
|---------|---------|
| `scrollIntoView` on sticky escape bar | Gap under nav or bar hidden behind header |
| Hash on lookup section while portfolio open | Browser jumps mid-page before JS runs |
| Hardcoded `88px` offset | Misalignment when nav wraps to two rows |
| Duplicate scroll calls in `renderWalletLookup` + `setGalleryCollectorView` | Jitter / wrong final position |

---

## MC race (`/analytics/`)

Static Flourish embed plus a **CSS-only** race-track layer (no extra JS). Markup lives in `web/analytics/index.html`; styles in `web/css/styles.css` under `body.analytics-page`.

### Layer stack

| z-index | Layer |
|---------|-------|
| `0` | `.analytics-race-scene` — fixed track, speed lines, cars (`pointer-events: none`) |
| `2` | Header, `.analytics-main` panels, footer |

Cars use `offset-path: inset(… round …)` + `offset-rotate: auto` and loop via `@keyframes analytics-race-lap`. Six cars in HTML (dacat.drive image, mascot car, four CSS comic cars); mobile hides the two smallest (`nth-child(5)` / `(6)`).

### Mobile visibility

Panels are full-width white blocks — cars only show in the **side gutters** and in **gaps** between header, intro, chart, and footer. Below `719px`:

- Narrower panels: `width: calc(100% - 1.5rem)` centered in `.analytics-main`
- Tighter track inset + higher car/track opacity
- Do not raise race scene `z-index` above panels (chart readability)

### Reduced motion

`@media (prefers-reduced-motion: reduce)` — animation off; cars parked at staggered `offset-distance` values.

### Manual QA checklist — MC race

- [ ] Hard-refresh `/analytics/`; footer build id current.
- [ ] Desktop: cars orbit viewport; chart remains readable.
- [ ] Mobile (~390px): dashed track + checkers visible; at least dacat.drive or mascot peeks in side gutter while scrolling.
- [ ] `prefers-reduced-motion`: cars static, track still visible.
- [ ] Flourish embed loads; play button works.

---

## CI & Automated Data Pipeline (the standout part)

### OpenSea key store / reuse / replace (no monthly manual work)

Logic lives in \scripts/ci_resolve_opensea_key.sh\, used by efresh-data.yml\:

| Step | What happens |
|------|----------------|
| **Store** | After a key passes the lightweight OpenSea stats probe, the full mint payload (key + \expires_at\) is saved to **GitHub Actions cache** as \.ci/opensea_instant_key.json\ (gitignored — never committed). |
| **Reuse** | Later daily runs restore that file and reuse the key while ≥12h of life remains. **No mint** → avoids OpenSea’s **~2 keys/day/IP** limit on shared runners. |
| **Replace** | When the stored key is inside the renew window (or missing), CI mints a new instant key. On success the store file is **overwritten** and saved to cache under a new cache entry. |
| **Fallback** | If mint returns **429** but a stored key still has life, CI keeps using the store and re-warms the cache. |
| **Invalid store** | If the stats probe fails, the store file is deleted so the next good mint can replace it cleanly. |

Instant keys last **~7 days** (OpenSea free tier), not a month — renew is automatic when mint works.

#### If every run fails with mint HTTP 429 (empty store)

GitHub-hosted runners share IPs; OpenSea allows only **~2 instant keys/day/IP**, so the store may never get its first key.

**Best one-time fix (recommended):**

1. On your machine (home/VPN — **not** Actions), mint or create a key:
   - Instant: curl -s -X POST https://api.opensea.io/api/v2/auth/keys → copy pi_key
   - Or create a normal key at [opensea.io/settings/developer](https://opensea.io/settings/developer) (longer-lived)
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: OPENSEA_API_KEY
   - Value: the key (never put keys in workflow_dispatch inputs — those can show in the UI)
3. Run **Refresh gallery data (daily)** once (manual dispatch).
4. The job uses the secret **and seeds Actions cache**. After a green run you can either:
   - **Leave the secret** (simplest; most reliable for daily cron), or
   - **Delete the secret** and rely on cache + future mints (re-seed if 429 returns with empty store)

Do **not** paste keys into public issues, PR comments, or workflow_dispatch text fields.

- Runs on cron + manual dispatch.
- Fetches main gallery + badges (+ other collection fetchers), commits JSONs, triggers deploy.
- On failure records \gallery_meta.json\ (staleness banner on the live site).

| Workflow | LFS | Notes |
|----------|-----|-------|
| efresh-data.yml\ | \lfs: false\ | JSON-only. Store → reuse → mint/replace. |
| \deploy-pages.yml\ | \lfs: false\ at checkout + smart cache + conditional \lfs pull\ | Reuses previous assets heavily. |

**Manual QA after workflow or key-related changes:**
- Trigger **Refresh gallery data (daily)** manually.
- Confirm **Resolve OpenSea API key** logs \source=cache|minted|cache_stale_fallback\ (or epo_secret\) and the key is masked.
- Confirm **Save stored OpenSea key** runs when \should_save=true\ after a green verify.
- Check \gallery_meta.json\ shows recent \data_generated_at\ and \status: ok\.

## Deploy & verification

```powershell
.\scripts\bump-deploy.ps1
git add web/ docs/
git commit -m "fix: describe change (build YYYYMMDD-N)"
git push origin main
```

After deploy (~1–2 min):

1. Footer build id on live site ≥ your commit.
2. `node --check web/js/app.js` and `web/js/film.js` before push.
3. Spot-check `/film/`, `/analytics/`, `/dacommunity/?wallet=0x…`, `/`.

---

## Multi-collection prep

Registry-driven collections (`web/data/collections_registry.json`) — see **`docs/COLLECTIONS.md`** for adding live drops, per-community themes, and feature flags. Hub cards are still manual until a registry-driven hub ships.

### Collector display names (ENS / OpenSea)

Built in the **daily** `refresh-data.yml` job during `fetch_gallery_data.py` → `wallet_index.json`.

| Priority (frontend) | Source |
|---------------------|--------|
| 1. ENS | `ensdata.net` then OpenSea account (`ens_name`) |
| 2. OpenSea profile | OpenSea `username` / `display_name` on account resolve |
| 3. Wallet | Shortened `0x…` |

**Speed:** addresses re-resolve at most every **~14 days** (`last_ens_resolved`). Cache hits reuse prior ENS **and** username (no extra API). Fresh resolves only when new or expired.

**Weekly identity job** (`enrich-base-names.yml`, Sundays + manual):

| Step | Script | Source |
|------|--------|--------|
| Base names | `enrich_base_names.py` | web3.bio → `name_index.json` + `base_name` on wallet |
| OpenSea usernames | `enrich_opensea_profiles.py` | OpenSea accounts API → `username` on wallet |

Does **not** run on the daily gallery refresh (keeps that path fast).  
Display priority: **ENS → Base name → OpenSea username → short 0x**.

One-time backfill: `cd backend && python enrich_opensea_profiles.py --force`

### OpenSea collection slug (daCommunity archive)

Primary Base archive slug is **`dacommunity-archive`** (was `rodeo-posts-12142`). Contract  
`0x64c30f84ed17e45e349b25c9dc02d7d2fd8081b1` is unchanged.

| What | Depends on slug? |
|------|------------------|
| Daily fetch / listings / events / stats | **Yes** — registry `opensea_slug` + CI key probe |
| Collection page link on OpenSea | **Yes** — `collection.opensea_url` |
| NFT images (`i2c.seadn.io/base/0x64c…`) | **No** — contract + asset hash |
| Per-token OpenSea links (`/assets/base/0x64c…/id`) | **No** — chain + contract + token id |

If the slug changes again: update `collections_registry.json`, `backend/config.py` fallbacks,  
`.github/workflows/refresh-data.yml` stats probe, and re-fetch so `gallery_*` collection meta matches.

Film **Theatre mode** (`web/data/theatre_registry.json`, `theatre.js`) — see **`docs/THEATRE.md`**. Desktop-only; YT API player. **Lights-down layout:** compact up-next chip bottom-left (`max-width: 15.5rem`), Lights up pill top-right — must not overlap (see THEATRE.md chrome table). No full-page overlay on the player.

---

## Known technical debt

| Item | Risk | Suggested follow-up |
|------|------|---------------------|
| Nav duplicated in 7 HTML files | Drift between pages | Extract `nav-partial.js` or build step |
| `syncSiteHeaderHeight` duplicated in `app.js` + `film.js` | Fix one, miss the other | Shared `web/js/layout.js` module |
| No automated visual/regression tests | Sticky regressions slip through | Playwright smoke test for film scroll |
| `film.js` called removed `syncSiteHeaderHeight` (build 11) | Runtime error after catalog load | Fixed in build 12 — watch console on QA |

---

## Regression history (film sticky)

| Build | Issue | Cause |
|-------|-------|-------|
| 20260606-10 | ~1" gap under nav on PC | `--site-header-h` mismatch vs wrapped header |
| 20260606-11 | Search does not follow scroll | `.film-sticky-deck { position: static }` inside `.site-top-stack`; `.film-theater .site-top-stack { position: relative }` overrode sticky |
| 20260606-12 | Restored follow-scroll + flush top | Dual sticky; removed `position: relative` on sticky chrome; restored `syncSiteHeaderHeight` + `ResizeObserver` |
| 20260606-13 | Wallet deep-link misalignment | `#wallet-panel` moved to theater-top anchor; `scrollToElementBelowHeader`; suppressed hash scroll jump on `?wallet=` |
| 20260606-20 | Wallet link offset on navigation (refresh OK) | Hero collapse left stale `scrollY`; portfolio scroll now `scrollTo(0)` + `pinWalletDeepLinkScroll` |