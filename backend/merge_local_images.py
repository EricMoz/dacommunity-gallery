"""
Copy daCommunity images from Used Pics into web/assets/nfts and patch gallery_data.json.

Matches OpenSea descriptions like "dacat.2years" to dacat.2years.png in Used Pics.
Run after fetch_gallery_data.py:
  python merge_local_images.py
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
USED_PICS = Path(r"C:\Users\ericm\OneDrive\Documents\dacat\Top and Used Pics\Used Pics")
DATA_PATH = ROOT / "web" / "data" / "gallery_data.json"
NFT_ASSETS = ROOT / "web" / "assets" / "nfts"


def extract_slug(description: str) -> str | None:
    if not description:
        return None
    first = description.strip().split("\n")[0].strip().lower()
    if first.startswith("dacat.") and re.match(r"^dacat\.[a-z0-9_-]+$", first):
        return first
    return None


def find_local_file(slug: str) -> Path | None:
    if not USED_PICS.exists():
        return None
    for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".PNG", ".JPG"):
        p = USED_PICS / f"{slug}{ext}"
        if p.exists():
            return p
    # subfolders (9 Block etc.)
    for p in USED_PICS.rglob(f"{slug}.*"):
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
            return p
    return None


def main() -> None:
    if not DATA_PATH.exists():
        raise FileNotFoundError(f"Run fetch first: {DATA_PATH}")

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    NFT_ASSETS.mkdir(parents=True, exist_ok=True)

    matched = 0
    for item in data.get("items", []):
        slug = extract_slug(item.get("description", ""))
        if not slug:
            continue
        src = find_local_file(slug)
        if not src:
            continue
        dest_name = f"{slug.replace('.', '_')}{src.suffix.lower()}"
        dest = NFT_ASSETS / dest_name
        if not dest.exists() or dest.stat().st_size != src.stat().st_size:
            shutil.copy2(src, dest)
        if not item.get("opensea_image_url") and item.get("image_url", "").startswith("http"):
            item["opensea_image_url"] = item["image_url"]
        item["local_slug"] = slug
        item["image_url"] = f"assets/nfts/{dest_name}"
        item["image_source"] = "local_used_pics"
        matched += 1

    data["local_images_merged"] = matched
    DATA_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Patched {matched}/{len(data.get('items', []))} items with local images from Used Pics")


if __name__ == "__main__":
    main()