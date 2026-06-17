"""
Build slim badges_catalog.json (for fast frontend first paint).

Modeled exactly on backend/build_catalog.py for the main archive.

Run after fetch + asset merge (when promoting approved data).

This ensures the badges collection can reuse the same gallery/catalog UI patterns
as the dacommunity archive (see mapping Excel sheet 1 for field correspondence).

Produces web/data/badges_catalog.json with slim items + collection summary.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "web" / "data" / "badges_data.json"
CATALOG_PATH = ROOT / "web" / "data" / "badges_catalog.json"

def slim_item(item: dict) -> dict:
    # Mirror main slim + keep unique badge fields needed for vibe
    return {
        "token_id": item.get("token_id"),
        "name": item.get("name"),
        "display_name": item.get("display_name"),
        "local_slug": item.get("local_slug"),
        "excerpt": item.get("excerpt", ""),
        "image_url": item.get("image_url"),
        "media_type": item.get("media_type", "image"),
        "opensea_url": item.get("opensea_url"),
        "listed": item.get("listed", False),
        "listing": item.get("listing"),
        "owners": item.get("owners"),
        "minted_at": item.get("minted_at"),
        # Unique badge fields for special display (1:1, award vibe, mystery, unclaimed)
        "is_1_of_1": item.get("is_1_of_1", False),
        "award_category": item.get("award_category"),
        "unclaimed_or_available": item.get("unclaimed_or_available", False),
        "mystery_status": item.get("mystery_status", "approved"),
        "ens_match_detected": item.get("ens_match_detected", False),
        "source_created_collection": item.get("source_created_collection"),
    }

def main() -> None:
    if not DATA_PATH.exists():
        print(f"Missing {DATA_PATH} — run fetch_badges.py first and promote approved data.")
        return

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    items = [slim_item(item) for item in data.get("items", [])]

    catalog = {
        "generated_at": data.get("generated_at"),
        "source": "badges_catalog",
        "collection": data.get("collection"),
        "items": items,
    }
    CATALOG_PATH.write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Wrote {CATALOG_PATH} ({CATALOG_PATH.stat().st_size // 1024} KB, {len(items)} items)")

if __name__ == "__main__":
    main()
