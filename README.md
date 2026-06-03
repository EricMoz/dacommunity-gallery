# daCommunity Gallery

Read-only gallery for **daCAT daCommunity** NFTs on Base (OpenSea: [rodeo-posts-12142](https://opensea.io/collection/rodeo-posts-12142)).

Contract `0x64c30f84ed17e45e349b25c9dc02d7d2fd8081b1` is unchanged after the Rodeo migration; collection is stewarded via **dacatdreams.eth**.

## Quick start

```powershell
cd backend
pip install -r requirements.txt
python fetch_gallery_data.py
cd ..\web
python -m http.server 8080
```

Open **http://localhost:8080**

- `--quick` — metadata only (~10s)
- Full run — listings, per-piece holder stats, wallet lookup index (~5–8 min)

## OpenSea API key

Stored in `backend/.env` (gitignored). First run can auto-create a free instant key. For GitHub Actions, add repo secret **`OPENSEA_API_KEY`**.

## Share publicly (GitHub Pages)

1. Create repo `dacommunity-gallery` on GitHub (see below).
2. Push this folder.
3. Repo **Settings → Pages → Build type: GitHub Actions**.
4. After deploy, share `https://<user>.github.io/dacommunity-gallery/`

## Wallet lookup

Full refresh builds `holders_index` in `gallery_data.json`. The site resolves ENS via [ensdata.net](https://ensdata.net) when a name isn’t pre-indexed.

Try: `mozvane.eth`

## Project layout

```
backend/     OpenSea fetch scripts
web/         Static gallery UI + data/gallery_data.json
scripts/     refresh.ps1 helper
```