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

def resolve_local_badge_image(item: dict, root: Path) -> str:
    """Prefer local series/rep PNG asset for clean search grid (avoids 1:1 spam).
    Falls back to recorded url. All current badges have matching png in assets/badges/.
    """
    slug = (item.get("local_slug") or "").strip()
    if slug:
        candidate = root / "web" / "assets" / "badges" / f"{slug}.png"
        if candidate.exists():
            return f"assets/badges/{slug}.png"
    return item.get("image_url") or ""


def is_multi_custom_series_rep(item: dict) -> bool:
    """Trillion/billion club series card (not the personal 1:1 editions)."""
    if not item.get("is_series_rep") or item.get("edition_club"):
        return False
    slug = (item.get("source_created_collection") or "").lower()
    return "trillion" in slug or "billion" in slug


def slim_item(item: dict, root: Path) -> dict:
    # Mirror main slim + keep unique badge fields + subcats/tags for light filters/grouping
    img = resolve_local_badge_image(item, root)
    multi_rep = is_multi_custom_series_rep(item)
    # Series cards: generic local art only. Personalized OpenSea art stays on edition rows.
    if multi_rep and img.startswith("assets/badges/"):
        opensea_img = None
        media_type = "image"
    else:
        orig_img = item.get("image_url") or item.get("opensea_image_url") or ""
        # Personal 1:1 rows: keep remote art. If image_url was already local, keep remote separately.
        if orig_img.startswith("http"):
            opensea_img = orig_img
        elif (item.get("opensea_image_url") or "").startswith("http"):
            opensea_img = item.get("opensea_image_url")
        else:
            opensea_img = None
        # Force image for local PNG assets (generic view). Video badges keep remote via opensea_image_url.
        media_type = (
            "image" if img.startswith("assets/badges/") else item.get("media_type", "image")
        )
    return {
        "token_id": item.get("token_id"),
        "name": item.get("name"),
        "display_name": item.get("display_name"),
        "local_slug": item.get("local_slug"),
        "excerpt": item.get("excerpt", ""),
        "image_url": img,
        "media_type": media_type,
        "opensea_url": item.get("opensea_url"),
        "opensea_image_url": opensea_img,
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
        "is_series_rep": item.get("is_series_rep", False),
        "edition_club": item.get("edition_club", False),
        # For sub-category grouping (Trillion Club etc) and tags in light search / badges page
        "sub_category": item.get("sub_category"),
        "tags": item.get("tags", []),
    }

def main() -> None:
    if not DATA_PATH.exists():
        print(f"Missing {DATA_PATH} — run fetch_badges.py first and promote approved data.")
        return

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    items = [slim_item(item, ROOT) for item in data.get("items", [])]

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
