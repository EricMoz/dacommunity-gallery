"""
Add owners.latest_change from existing recent_activity (no OpenSea call).

Run after fetch or when only the frontend model changed:
  python enrich_gallery_json.py
"""

from __future__ import annotations

import json
from pathlib import Path

from owner_stats import enrich_owner_stats

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "web" / "data" / "gallery_data.json"
CATALOG_PATH = ROOT / "web" / "data" / "gallery_catalog.json"


def patch_items(items: list[dict]) -> int:
    n = 0
    for item in items:
        owners = item.get("owners")
        activity = item.get("recent_activity")
        if not owners:
            continue
        new_owners = enrich_owner_stats(owners, activity)
        if new_owners != owners:
            item["owners"] = new_owners
            n += 1
    return n


def main() -> None:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    updated = patch_items(data.get("items") or [])
    DATA_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Updated latest_change on {updated} items in gallery_data.json")

    if CATALOG_PATH.is_file():
        cat = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        cat_updated = patch_items(cat.get("items") or [])
        CATALOG_PATH.write_text(
            json.dumps(cat, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"Updated latest_change on {cat_updated} items in gallery_catalog.json")


if __name__ == "__main__":
    main()