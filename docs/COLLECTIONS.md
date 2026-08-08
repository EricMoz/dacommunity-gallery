# Multi-collection architecture

The daCAT site is moving from a single hard-coded gallery (daCommunity on Base) toward a **registry-driven** model: each community collection can have its own chain, route, data pipeline, theme, and feature set.

Nothing on the public hub auto-lists every future collection yet — the registry is the contract engineers extend when a drop is ready.

---

## Registry (`web/data/collections_registry.json`)

| Field | Purpose |
|-------|---------|
| `id` | Stable slug (`dacommunity`, `badges`, future community ids) |
| `status` | `live` \| `coming_soon` \| `archived` |
| `chain` | `base`, `ethereum`, … |
| `contract` / `opensea_slug` | OpenSea v2 fetch targets (null until live) |
| `route` | GitHub Pages path (`/dacommunity/`, `/badges/`, …) |
| `data` | JSON filenames under `web/data/` (null for preview-only) |
| `features` | Capability flags — see below |
| `theme` | Per-collection accent/surface tokens for CSS or future JS boot |

### Feature flags (convention)

| Flag | Meaning |
|------|---------|
| `gallery` | Full browse grid + detail drawer |
| `wallet_lookup` | ENS/0x collector search |
| `collector_view` | Dark portfolio grid + share URL |
| `opensea_sync` | Backend fetch from OpenSea |
| `preview_only` | Static coming-soon / teaser page |
| `share_wallet_url` | `?wallet=` deep links |

New collections can mix flags — e.g. a live gallery without wallet index, or a mint page with no grid.

---

## Backend (`backend/`)

| Module | Role |
|--------|------|
| `collections_registry.py` | Load registry; `get_collection(id)`, `get_primary_live()` |
| `config.py` | Primary live slug/contract/chain (backward compatible) |
| `fetch_gallery_data.py` | Today: daCommunity only — pass `collection_id` when adding fetchers |
| `build_catalog.py` | Slim catalog per collection data file |

### Adding a live collection (checklist)

1. Add entry to `collections_registry.json` with `status: "live"`, contract, slug, `data` paths.
2. Create fetch script or extend `fetch_gallery_data.py` with `--collection <id>`.
3. Add `web/<route>/index.html` (or reuse a template) with `body[data-collection="<id>"]`.
4. Wire `app.js` or a dedicated `*-gallery.js` to read registry / data paths from `data-collection`.
5. Add hub card in `collections/index.html` (manual until hub is registry-driven).
6. Document theme tokens in registry `theme` and CSS under `body[data-collection="…"]`.

### Theme customization (decentralized communities)

Keep presentation data in the registry, not scattered in HTML:

```json
"theme": {
  "accent": "#ffcc00",
  "accent_glow": "#ffd633",
  "surface": "cosmic_soon",
  "starfield": true
}
```

CSS maps `surface` to body classes (e.g. `badges-page` ↔ `cosmic_soon`). Future: small boot script reads registry JSON and sets `document.body.dataset`.

---

## Frontend patterns today

| Collection | Route | Experience |
|------------|-------|------------|
| daCommunity | `/dacommunity/` | `app.js` + `gallery_*.json` (OpenSea slug `dacommunity-archive`, contract on Base) |
| BIG KIX | `/dacommunity/?collection=bigkix` | `app.js` + `bigkix_*.json` (Ethereum, single-slug fetch) |
| daGATO Detective Agency | `/dacommunity/?collection=dagato-agency` | `app.js` + `dagato_agency_*.json` (Ethereum, rarity tags) |
| Badges | `/dacommunity/?collection=badges` | `app.js` + `badges_*.json` |

### BIG KIX pipeline

```bash
cd backend
python fetch_bigkix.py          # writes web/data/bigkix_data.json + catalog
# Daily: refresh-data.yml runs after daCommunity fetch
```

- Creator `dacatworld.eth` / `0xa6d5…` excluded from holder counts
- Titles normalized to `BIG KIX #014 · EAGLE 250` (`opensea_name` keeps full OpenSea title)
- Activity + listings via same collection-events + best-listings pattern as daCommunity

### daGATO Detective Agency (multi-volume) pipeline

```bash
cd backend
python fetch_dagato_agency.py          # all registry volumes → dagato_agency_*.json
python fetch_dagato_agency.py --volume 2   # single volume only (still full rewrite)
# Daily: refresh-data.yml runs after BIG KIX fetch
```

| Surface | Detail |
|---------|--------|
| Hub / home tile | Eyebrow **`Agency · Vol 1–2`**; cool ice-blue premium dark card |
| Route | `/dacommunity/?collection=dagato-agency` (one site collection for all volumes) |
| Steward | `dagato.eth` · no creator-wallet exclusion |
| OpenSea | Separate collection per volume (`…-volume-1`, `…-volume-2`); listed in registry `volumes[]` |
| Browse titles | **`{Rarity} Case File · Vol N`** e.g. `Legendary Case File · Vol 2` |
| Wallet titles | **`{Rarity} Case File #NN · Vol N`** e.g. `Common Case File #33 · Vol 1` |
| Browse grid | **5 rarity series per volume** (10 cards for Vol 1+2); pills **#1–#5**; sort Vol then rank |
| Pieces stat | Count of rarity series rows (not raw case-file count) |
| Rarity tags | Common / Uncommon / Epic / Legendary / 1:1 on grid, holdings, detail |
| Detail | Aggregated holders + copies; transfer/sale history merged from case files |
| Collector wallet | Real case-file token #s (editions), namespaced by volume so #s don’t collide |
| Data | `web/data/dagato_agency_data.json` + `dagato_agency_catalog.json` |
| Fetch | `backend/fetch_dagato_agency.py` (also in `refresh-data.yml`) |

Hub cards remain manual (home + `collections/index.html`) until the hub is fully registry-driven.

### Collector names (daily + weekly)

| Job | Frequency | What |
|-----|-----------|------|
| `refresh-data.yml` | Daily | ENS + OpenSea username → `wallet_index.json` |
| `enrich-base-names.yml` | Weekly (Sunday) | Base names (`.base.eth`) → `name_index.json` + patch wallet |

Display: **ENS → Base name → OpenSea username → short 0x**.

Do **not** duplicate gallery logic for preview pages — use `preview_only` + themed static HTML until data exists.

---

## QA — Badges coming soon

- [ ] Mobile: starfield visible (gold twinkle, not empty yellow).
- [ ] Desktop: card layout unchanged in spirit; cosmos behind panel.
- [ ] `prefers-reduced-motion`: stars static, no orbit animation.
- [ ] Footer build id current after deploy.