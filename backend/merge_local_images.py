"""
Copy daCommunity images from Used Pics into web/assets/nfts and patch gallery_data.json.

Matches OpenSea descriptions like "dacat.2years" to dacat.2years.png in Used Pics.
Run after fetch_gallery_data.py:
  python merge_local_images.py
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from title_utils import apply_item_titles, extract_slug

ROOT = Path(__file__).resolve().parent.parent
# Override with DACAT_USED_PICS_DIR in .env for non-default machines
_DEFAULT_USED_PICS = Path(
    r"C:\Users\ericm\OneDrive\Documents\dacat\Top and Used Pics\Used Pics"
)
USED_PICS = Path(os.getenv("DACAT_USED_PICS_DIR", _DEFAULT_USED_PICS))
DATA_PATH = ROOT / "web" / "data" / "gallery_data.json"
NFT_ASSETS = ROOT / "web" / "assets" / "nfts"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
VIDEO_EXTS = {".mp4", ".mov", ".webm"}


def find_local_file(slug: str) -> Path | None:
    if not USED_PICS.exists():
        return None
    base = slug.replace(".", ".")  # dacat.thrash
    for ext in list(IMAGE_EXTS) + list(VIDEO_EXTS):
        p = USED_PICS / f"{base}{ext}"
        if p.exists():
            return p
        p = USED_PICS / f"{base}{ext.upper()}"
        if p.exists():
            return p
    for p in USED_PICS.rglob(f"{base}.*"):
        if p.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS:
            return p
    return None


def main() -> None:
    if not DATA_PATH.exists():
        raise FileNotFoundError(f"Run fetch first: {DATA_PATH}")

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    NFT_ASSETS.mkdir(parents=True, exist_ok=True)

    matched = 0
    for item in data.get("items", []):
        apply_item_titles(item)
        slug = extract_slug(item.get("description", ""), item.get("name"))
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
        item["media_type"] = "video" if src.suffix.lower() in VIDEO_EXTS else "image"
        apply_item_titles(item)
        matched += 1

    data["local_images_merged"] = matched
    DATA_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Patched {matched}/{len(data.get('items', []))} items with local images from Used Pics")
    import build_catalog

    build_catalog.main()


if __name__ == "__main__":
    main()