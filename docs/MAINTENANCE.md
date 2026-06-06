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
| Mozvane | `web/film/mozvane/index.html` |
| Analytics | `web/analytics/index.html` |
| Badges | `web/badges/index.html` |

### Visual hierarchy (2026-06)

| Tier | Items | Style |
|------|-------|-------|
| Hubs | Collections, Film | Slightly larger; yellow hover border |
| Contextual | My daCATs | Yellow text on Home + gallery when inactive |
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
| Deep-link scroll | `?wallet=` URLs pin to top before JS, then `scrollToElementBelowHeader` on escape bar |

### Wallet deep-link QA (`?wallet=0x…#wallet-panel`)

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
3. Spot-check `/film/`, `/dacommunity/?wallet=0x…`, `/`.

---

## Multi-collection prep

Registry-driven collections (`web/data/collections_registry.json`) — see **`docs/COLLECTIONS.md`** for adding live drops, per-community themes, and feature flags. Hub cards are still manual until a registry-driven hub ships.

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