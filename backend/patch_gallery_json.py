"""
Patch existing JSON without re-fetching OpenSea (titles, thrash video, catalog).

Use after manual edits or when Used Pics assets change locally.
"""

from __future__ import annotations

import json
from pathlib import Path

from title_utils import apply_item_titles, extract_slug

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "web" / "data" / "gallery_data.json"
WALLET_PATH = ROOT / "web" / "data" / "wallet_index.json"
THRASH_SRC = Path(r"C:\Users\ericm\OneDrive\Documents\dacat\Top and Used Pics\Used Pics\dacat.thrash.MP4")
THRASH_DEST = ROOT / "web" / "assets" / "nfts" / "dacat_thrash.mp4"


def patch_wallet_index(items_by_id: dict[str, dict]) -> None:
    if not WALLET_PATH.exists():
        return
    raw = json.loads(WALLET_PATH.read_text(encoding="utf-8"))
    idx = raw.get("holders_index") or raw
    by_address = idx.get("by_address") or {}
    for entry in by_address.values():
        for h in entry.get("holdings", []):
            tid = str(h.get("token_id", ""))
            ref = items_by_id.get(tid, {})
            dn = ref.get("display_name") or ref.get("name")
            if dn:
                h["display_name"] = dn
                h["name"] = dn
    collectors = sorted(
        [
            {
                "address": e["address"],
                "ens_name": e.get("ens_name"),
                "username": e.get("username"),
                "unique_pieces": e.get("unique_pieces") or 0,
                "collection_quantity": e.get("collection_quantity") or 0,
            }
            for e in by_address.values()
        ],
        key=lambda c: (-c["unique_pieces"], -c["collection_quantity"]),
    )
    idx["collectors"] = collectors
    raw["holders_index"] = idx
    WALLET_PATH.write_text(json.dumps(raw, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Patched wallet index — {len(collectors)} collectors")


def patch_thrash(items: list[dict]) -> None:
    for item in items:
        if item.get("token_id") != "6" and extract_slug(item.get("description"), item.get("name")) != "dacat.thrash":
            continue
        if not THRASH_SRC.exists():
            print("Warning: dacat.thrash.MP4 not found locally")
            return
        THRASH_DEST.parent.mkdir(parents=True, exist_ok=True)
        if not THRASH_DEST.exists() or THRASH_DEST.stat().st_size != THRASH_SRC.stat().st_size:
            THRASH_DEST.write_bytes(THRASH_SRC.read_bytes())
        if not item.get("opensea_image_url") and item.get("image_url", "").startswith("http"):
            item["opensea_image_url"] = item["image_url"]
        item["local_slug"] = "dacat.thrash"
        item["image_url"] = "assets/nfts/dacat_thrash.mp4"
        item["media_type"] = "video"
        item["image_source"] = "local_used_pics"
        if not item.get("description", "").lower().startswith("dacat."):
            item["description"] = "dacat.thrash\n\n" + (item.get("description") or "")
        apply_item_titles(item)
        print("Patched dacat.thrash with local MP4")
        return


def main() -> None:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    items_by_id: dict[str, dict] = {}
    for item in data.get("items", []):
        apply_item_titles(item)
        items_by_id[str(item["token_id"])] = item
    patch_thrash(data["items"])
    for item in data["items"]:
        apply_item_titles(item)
        items_by_id[str(item["token_id"])] = item
    DATA_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Patched titles on {len(data['items'])} items")
    patch_wallet_index(items_by_id)
    import build_catalog

    build_catalog.main()


if __name__ == "__main__":
    main()