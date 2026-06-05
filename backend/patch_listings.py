"""
Fast refresh of listed / listing fields only (~seconds).

Use when a new OpenSea listing should show before the next full daily fetch:
  cd backend && python patch_listings.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from fetch_gallery_data import (
    build_active_listings_map,
    load_api_key,
    parse_listing_price,
)
from opensea_client import OpenSeaClient

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "web" / "data" / "gallery_data.json"


def main() -> int:
    api_key = load_api_key()
    client = OpenSeaClient(api_key)
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    listings_map = build_active_listings_map(client)
    listed_count = 0
    for item in data.get("items") or []:
        token_id = str(item.get("token_id"))
        raw = listings_map.get(token_id)
        info = parse_listing_price(raw) if raw else None
        item["listed"] = info is not None
        item["listing"] = info
        if item["listed"]:
            listed_count += 1
    data["generated_at"] = datetime.now(timezone.utc).isoformat()
    coll = data.get("collection") or {}
    coll["listed_count"] = listed_count
    data["collection"] = coll
    DATA_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Updated listings: {listed_count} active — tokens: {', '.join(sorted(listings_map.keys(), key=int))}")
    import enrich_gallery_json

    enrich_gallery_json.main()
    import build_catalog

    build_catalog.main()
    import gallery_meta

    gallery_meta.record_success(
        listed_count=listed_count,
        piece_count=len(data.get("items") or []),
        source="patch_listings",
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)