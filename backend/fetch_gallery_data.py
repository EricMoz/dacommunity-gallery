"""
Fetch daCommunity NFT data from OpenSea and write web/data/gallery_data.json.

Usage (from backend/):
  python fetch_gallery_data.py
  python fetch_gallery_data.py --quick
  python fetch_gallery_data.py --skip-wallet-index
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

from config import (
    CHAIN,
    COLLECTION_NOTE,
    COLLECTION_SLUG,
    CONTRACT_ADDRESS,
    CREATOR_ENS,
    OPENSEA_COLLECTION_URL,
)
from opensea_client import OpenSeaClient
from title_utils import apply_item_titles, display_title, extract_slug

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = Path(__file__).resolve().parent / ".env"
OUTPUT_PATH = ROOT / "web" / "data" / "gallery_data.json"
WALLET_INDEX_PATH = ROOT / "web" / "data" / "wallet_index.json"


def load_api_key(create_if_missing: bool = False) -> str:
    """Load key from backend/.env. Auto-create only when create_if_missing=True (--create-key)."""
    load_dotenv(ENV_PATH)
    key = os.getenv("OPENSEA_API_KEY", "").strip()
    if key:
        return key
    if not create_if_missing:
        raise ValueError(
            "OPENSEA_API_KEY not set. Copy backend/.env.example to .env or run with --create-key (local dev only)."
        )
    print("No OpenSea key found — creating free instant key (expires ~30 days)...")
    client = OpenSeaClient(api_key="temp", delay=0)
    key = client.create_instant_api_key()
    ENV_PATH.write_text(f"OPENSEA_API_KEY={key}\n", encoding="utf-8")
    print(f"Saved key to {ENV_PATH}")
    return key


def wei_to_eth(value: str, decimals: int = 18) -> float:
    return int(value) / (10**decimals)


def parse_listing_price(listing: dict) -> dict | None:
    price = listing.get("price") or {}
    current = price.get("current") or {}
    raw = current.get("value")
    if raw is None:
        return None
    decimals = int(current.get("decimals", 18))
    currency = current.get("currency", "ETH")
    return {
        "amount_eth": wei_to_eth(str(raw), decimals),
        "currency": currency,
        "status": listing.get("status"),
    }


def clean_description(text: str | None) -> str:
    if not text:
        return ""
    text = text.replace("\r\n", "\n").strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def excerpt(text: str, max_len: int = 160) -> str:
    flat = re.sub(r"\s+", " ", text).strip()
    if len(flat) <= max_len:
        return flat
    return flat[: max_len - 1].rstrip() + "…"


def summarize_owners(owners: list[dict]) -> dict:
    total_copies = sum(int(o.get("quantity", 0)) for o in owners)
    return {
        "holder_count": len(owners),
        "circulating_copies": total_copies,
        "top_holders": [
            {
                "address": o.get("address"),
                "quantity": int(o.get("quantity", 0)),
            }
            for o in sorted(
                owners, key=lambda x: int(x.get("quantity", 0)), reverse=True
            )[:5]
        ],
    }


def build_item(nft: dict, listing: dict | None, owners: list[dict] | None) -> dict:
    token_id = str(nft.get("identifier", ""))
    description = clean_description(nft.get("description"))
    listing_info = parse_listing_price(listing) if listing else None
    owner_stats = summarize_owners(owners) if owners is not None else None

    raw_name = nft.get("name") or f"daCommunity #{token_id}"
    slug = extract_slug(description, raw_name)
    display = display_title(slug, raw_name, token_id)
    image_url = nft.get("display_image_url") or nft.get("image_url") or ""
    media_type = "video" if re.search(r"\.(mov|mp4|webm)(\?|$)", image_url, re.I) else "image"

    item = {
        "token_id": token_id,
        "name": display,
        "display_name": display,
        "local_slug": slug,
        "description": description,
        "excerpt": excerpt(description),
        "image_url": image_url,
        "media_type": media_type,
        "opensea_url": nft.get("opensea_url"),
        "metadata_url": nft.get("metadata_url"),
        "updated_at": nft.get("updated_at"),
        "traits": nft.get("traits") or [],
        "listed": listing_info is not None,
        "listing": listing_info,
        "owners": owner_stats,
    }
    if raw_name != display:
        item["opensea_name"] = raw_name
    return item


def build_holders_index(
    client: OpenSeaClient,
    items_by_id: dict[str, dict],
    *,
    resolve_ens: bool = True,
) -> dict:
    """Build wallet → holdings map for gallery lookup panel."""
    print("Building wallet lookup index from collection holders...")
    holders = client.iter_collection_holders()
    index: dict[str, dict] = {}
    ens_aliases: dict[str, str] = {}

    for i, holder in enumerate(holders, 1):
        address = holder.get("address", "").lower()
        if not address:
            continue
        print(f"  [holder {i}/{len(holders)}] {address[:10]}…", flush=True)

        ens_name = None
        username = None
        if resolve_ens:
            try:
                resolved = client.resolve_account(holder["address"])
                ens_name = resolved.get("ens_name")
                username = resolved.get("username")
            except requests.HTTPError:
                pass

        holdings = []
        try:
            account_nfts = client.get_account_collection_nfts(holder["address"])
            for nft in account_nfts:
                tid = str(nft.get("identifier", ""))
                ref = items_by_id.get(tid, {})
                holdings.append(
                    {
                        "token_id": tid,
                        "name": ref.get("display_name")
                        or ref.get("name")
                        or nft.get("name"),
                        "image_url": nft.get("display_image_url")
                        or nft.get("image_url")
                        or ref.get("image_url"),
                        "opensea_url": nft.get("opensea_url") or ref.get("opensea_url"),
                    }
                )
        except requests.HTTPError:
            holdings = []

        holdings.sort(key=lambda h: int(h["token_id"]), reverse=True)

        entry = {
            "address": holder["address"],
            "ens_name": ens_name,
            "username": username,
            "collection_quantity": int(holder.get("quantity", 0)),
            "ownership_pct": holder.get("percentage"),
            "holdings": holdings,
            "unique_pieces": len(holdings),
        }
        index[address] = entry
        if ens_name:
            ens_aliases[ens_name.lower()] = address

    return {"by_address": index, "ens_aliases": ens_aliases}


def main() -> int:
    parser = argparse.ArgumentParser(description="Build gallery_data.json from OpenSea")
    parser.add_argument("--quick", action="store_true", help="Skip listings/owners/index")
    parser.add_argument("--skip-wallet-index", action="store_true", help="Skip holder index")
    parser.add_argument("--max-items", type=int, default=0, help="Limit NFT count (0=all)")
    parser.add_argument(
        "--create-key",
        action="store_true",
        help="Create OpenSea instant API key if missing (local dev only; never in CI)",
    )
    args = parser.parse_args()

    api_key = load_api_key(create_if_missing=args.create_key)
    client = OpenSeaClient(api_key)

    print("Verifying contract on Base...")
    contract_meta = client.get_contract()
    print(f"  Contract: {CONTRACT_ADDRESS}")
    print(f"  OpenSea collection: {contract_meta.get('collection', COLLECTION_SLUG)}")
    print(f"  Name on-chain/OS: {contract_meta.get('name')}")

    print("Fetching collection stats...")
    stats_raw = client.get_collection_stats()
    total = stats_raw.get("total") or {}

    creator_wallet = None
    try:
        resolved_creator = client.resolve_account(CREATOR_ENS)
        if resolved_creator.get("address"):
            creator_wallet = resolved_creator
    except requests.HTTPError:
        creator_wallet = None

    print("Fetching NFT metadata...")
    nfts = client.iter_collection_nfts()
    nfts.sort(key=lambda n: int(n.get("identifier", 0)), reverse=True)
    if args.max_items > 0:
        nfts = nfts[: args.max_items]

    items = []
    items_by_id: dict[str, dict] = {}
    listed_count = 0

    for i, nft in enumerate(nfts, 1):
        token_id = str(nft.get("identifier"))
        print(f"  [{i}/{len(nfts)}] token #{token_id}", end="", flush=True)

        listing = None
        owners = None
        if not args.quick:
            try:
                listing = client.get_best_listing(token_id)
            except requests.HTTPError:
                listing = None
            try:
                owners = client.get_nft_owners(token_id)
            except Exception:
                owners = []

        item = build_item(nft, listing, owners)
        if item["listed"]:
            listed_count += 1
        items.append(item)
        items_by_id[token_id] = item
        print(" ✓")

    holders_index = None
    if not args.quick and not args.skip_wallet_index:
        holders_index = build_holders_index(client, items_by_id)

    # Slim holdings in wallet index (no duplicate image URLs)
    if holders_index:
        slim = {"ens_aliases": holders_index.get("ens_aliases", {}), "by_address": {}}
        for addr, entry in holders_index.get("by_address", {}).items():
            slim["by_address"][addr] = {
                "address": entry["address"],
                "ens_name": entry.get("ens_name"),
                "username": entry.get("username"),
                "collection_quantity": entry.get("collection_quantity"),
                "unique_pieces": entry.get("unique_pieces"),
                "holdings": [
                    {
                        "token_id": h["token_id"],
                        "name": h.get("name"),
                        "display_name": items_by_id.get(str(h["token_id"]), {}).get(
                            "display_name"
                        )
                        or h.get("name"),
                    }
                    for h in entry.get("holdings", [])
                ],
            }
        collectors = sorted(
            [
                {
                    "address": e["address"],
                    "ens_name": e.get("ens_name"),
                    "username": e.get("username"),
                    "unique_pieces": e.get("unique_pieces") or 0,
                    "collection_quantity": e.get("collection_quantity") or 0,
                }
                for e in slim["by_address"].values()
            ],
            key=lambda c: (-c["unique_pieces"], -c["collection_quantity"]),
        )
        slim["collectors"] = collectors
        WALLET_INDEX_PATH.write_text(
            json.dumps(
                {
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "holders_index": slim,
                },
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        print(f"Wrote {WALLET_INDEX_PATH}")

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "opensea_api_v2",
        "collection": {
            "slug": COLLECTION_SLUG,
            "name": "daCommunity",
            "display_name": "daCAT daCommunity",
            "contract": CONTRACT_ADDRESS,
            "chain": CHAIN,
            "opensea_url": OPENSEA_COLLECTION_URL,
            "note": COLLECTION_NOTE,
            "creator_ens": CREATOR_ENS,
            "creator_wallet": creator_wallet,
            "contract_name": contract_meta.get("name"),
            "floor_eth": total.get("floor_price"),
            "floor_symbol": total.get("floor_price_symbol", "ETH"),
            "num_owners": total.get("num_owners"),
            "total_sales": total.get("sales"),
            "total_volume": total.get("volume"),
            "piece_count": len(items),
            "listed_count": listed_count,
        },
        "items": items,
        "wallet_index_file": "wallet_index.json" if holders_index else None,
    }
    for item in payload["items"]:
        apply_item_titles(item)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(
        f"\nWrote {OUTPUT_PATH} — {len(items)} pieces, "
        f"{listed_count} listed, "
        f"{len((holders_index or {}).get('by_address', {}))} wallets indexed"
    )
    import build_catalog

    build_catalog.main()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)