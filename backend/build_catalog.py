"""
Build lean gallery_catalog.json for fast first paint (no full descriptions).

Run after fetch/merge/patch:
  python build_catalog.py
"""

from __future__ import annotations

import json
from pathlib import Path

from title_utils import apply_item_titles

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "web" / "data" / "gallery_data.json"
CATALOG_PATH = ROOT / "web" / "data" / "gallery_catalog.json"


def slim_item(item: dict) -> dict:
    return {
        "token_id": item.get("token_id"),
        "name": item.get("name"),
        "display_name": item.get("display_name"),
        "local_slug": item.get("local_slug"),
        "excerpt": item.get("excerpt", ""),
        "image_url": item.get("image_url"),
        "media_type": item.get("media_type", "image"),
        "opensea_url": item.get("opensea_url"),
        "opensea_image_url": item.get("opensea_image_url"),
        "listed": item.get("listed", False),
        "listing": item.get("listing"),
        "owners": item.get("owners"),
        "minted_at": item.get("minted_at"),
    }


def main() -> None:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    items = []
    for item in data.get("items", []):
        apply_item_titles(item)
        items.append(slim_item(item))

    catalog = {
        "generated_at": data.get("generated_at"),
        "source": "gallery_catalog",
        "collection": data.get("collection"),
        "wallet_index_file": data.get("wallet_index_file"),
        "items": items,
    }
    CATALOG_PATH.write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Wrote {CATALOG_PATH} ({CATALOG_PATH.stat().st_size // 1024} KB, {len(items)} items)")


if __name__ == "__main__":
    main()