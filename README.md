# daCommunity Gallery

Static gallery for the [daCAT daCommunity](https://opensea.io/collection/rodeo-posts-12142) ERC-1155 collection on Base, plus a collections hub for upcoming **Badges** (Ethereum).

**Live site:** https://ericmoz.github.io/dacommunity-gallery/

| Route | Purpose |
|-------|---------|
| `/` | Collection picker (daCommunity + Badges) |
| `/dacommunity/` | Full gallery, collector lookup, OpenSea data |
| `/badges/` | Badges coming-soon placeholder |

## Architecture (for reviewers)

This is a **static site** — no backend server in production. GitHub Pages serves `web/`; chain/market data is **pre-fetched** into JSON.

```
OpenSea API v2  ──►  Python (backend/)  ──►  web/data/*.json
                                              │
                                              ▼
                                    GitHub Pages (web/)
```

| Piece | Role |
|-------|------|
| **OpenSea API v2** | NFT metadata, per-token owners, listings, collection stats, holder list |
| **`fetch_gallery_data.py`** | Full refresh → `gallery_data.json` + `wallet_index.json` |
| **`build_catalog.py`** | Slim `gallery_catalog.json` for fast first paint (~85 KB) |
| **`merge_local_images.py`** | Optional: copy local artwork into `web/assets/nfts/` |
| **`app.js`** | Catalog first, full JSON merge in background; wallet index lazy; path-aware under `/dacommunity/` |

**Contract:** `0x64c30f84ed17e45e349b25c9dc02d7d2fd8081b1` (Base) · Steward: `dacatdreams.base.eth`

**CI:** Daily workflow refreshes JSON (repo secret `OPENSEA_API_KEY`). Pages deploy publishes `web/` with Git LFS for images.

## Local preview

Browsers block `fetch()` on `file://` URLs — run any static server from `web/`:

```powershell
cd web
python -m http.server 8080
```

Then open http://localhost:8080/ (picker) or http://localhost:8080/dacommunity/ (gallery).

On Windows, `start-gallery.bat` in the repo root is an optional shortcut that runs the same command.

## Refresh data from OpenSea

```powershell
cd backend
pip install -r requirements.txt
copy .env.example .env   # add OPENSEA_API_KEY from https://docs.opensea.io/reference/api-keys
python fetch_gallery_data.py
python merge_local_images.py   # optional; needs local art folder
```

Or: `.\scripts\refresh.ps1` (fetch + merge + local server).

`--quick` skips listings, owners, and wallet index. Full run takes ~5–8 minutes.

## Security

- **Never commit** `backend/.env` (gitignored). Use GitHub Actions secret `OPENSEA_API_KEY` for CI only.
- API keys are not used in the browser; the public site only reads static JSON.
- `fetch_gallery_data.py --create-key` can mint a dev key locally — do not use in shared/CI environments.

## Repo layout

```
backend/          OpenSea fetch + title normalization + catalog build
web/              Static site (HTML, CSS, JS, data, assets)
  index.html      Collections hub
  dacommunity/    daCommunity gallery (app.js expects ../data paths)
  badges/         Badges placeholder
.github/workflows Deploy Pages + daily data refresh
scripts/          PowerShell helpers
```