# daCommunity Gallery

Browse **daCAT daCommunity** NFTs on Base — stories, OpenSea listings, and wallet lookup.

## How to view the site (important)

**Do not double-click `index.html`.** Browsers block data loading that way (infinite spinner).

**Do this instead:**

1. Double-click **`start-gallery.bat`** in this folder  
2. Open **http://localhost:8080** in Chrome or Edge  

## What “full refresh” means

One command that updates everything from OpenSea:

```powershell
cd backend
pip install -r requirements.txt
python fetch_gallery_data.py
python merge_local_images.py
```

| Step | What it does |
|------|----------------|
| `fetch_gallery_data.py` | Pulls all 65 NFTs, descriptions, listings, holder stats, wallet index (~5–8 min) |
| `merge_local_images.py` | Copies your **Used Pics** artwork into the site (`dacat.2years.png` → token with that story) |

`--quick` skips listings and wallet index (faster, incomplete).

## GitHub (public share link)

1. Install GitHub CLI: `winget install GitHub.cli`  
2. Login: `gh auth login`  
3. Run: `.\scripts\create-github-repo.ps1`  
4. On GitHub: **Settings → Pages → Build: GitHub Actions**  
5. Add secret **`OPENSEA_API_KEY`** (from `backend\.env`)  

Live URL: `https://ericmoz.github.io/dacommunity-gallery/`

## Contract

`0x64c30f84ed17e45e349b25c9dc02d7d2fd8081b1` on Base — same after Rodeo migration.  
OpenSea: [rodeo-posts-12142](https://opensea.io/collection/rodeo-posts-12142)

## Wallet lookup

Try `mozvane.eth` after a full refresh. Uses pre-built index + [ensdata.net](https://ensdata.net) for other ENS names.