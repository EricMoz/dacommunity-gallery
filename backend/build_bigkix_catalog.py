"""
Build slim bigkix_catalog.json from bigkix_data.json.

  python build_bigkix_catalog.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "web" / "data" / "bigkix_data.json"
CATALOG_PATH = ROOT / "web" / "data" / "bigkix_catalog.json"


def slim_item(item: dict) -> dict:
    out = {
        "token_id": item.get("token_id"),
        "name": item.get("name"),
        "display_name": item.get("display_name"),
        "local_slug": item.get("local_slug"),
        "excerpt": item.get("excerpt", ""),
        "image_url": item.get("image_url"),
        "media_type": item.get("media_type", "image"),
        "opensea_url": item.get("opensea_url"),
        "opensea_image_url": item.get("opensea_image_url")
        or (
            item.get("image_url")
            if str(item.get("image_url") or "").startswith("http")
            else None
        ),
        "listed": item.get("listed", False),
        "listing": item.get("listing"),
        "owners": item.get("owners"),
        "minted_at": item.get("minted_at"),
        "collection_id": item.get("collection_id") or "bigkix",
        "opensea_name": item.get("opensea_name"),
    }
    activity = item.get("recent_activity") or []
    if activity:
        out["recent_activity"] = activity[:12]
    return out


def main() -> None:
    if not DATA_PATH.is_file():
        print(f"Missing {DATA_PATH} — run fetch_bigkix.py first.")
        return
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    items = [slim_item(it) for it in data.get("items") or []]
    catalog = {
        "generated_at": data.get("generated_at"),
        "source": "bigkix_catalog",
        "collection": data.get("collection"),
        "items": items,
    }
    CATALOG_PATH.write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Wrote {CATALOG_PATH} ({len(items)} items)")


if __name__ == "__main__":
    main()
