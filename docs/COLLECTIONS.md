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
| daCommunity | `/dacommunity/` | `app.js` + `gallery_*.json` |
| Badges | `/badges/` | Static coming-soon + `badges-soon.js` starfield |

Do **not** duplicate gallery logic for preview pages — use `preview_only` + themed static HTML until data exists.

---

## QA — Badges coming soon

- [ ] Mobile: starfield visible (gold twinkle, not empty yellow).
- [ ] Desktop: card layout unchanged in spirit; cosmos behind panel.
- [ ] `prefers-reduced-motion`: stars static, no orbit animation.
- [ ] Footer build id current after deploy.