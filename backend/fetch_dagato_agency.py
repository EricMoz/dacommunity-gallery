"""
Fetch daGATO Detective Agency: Volume 1 from OpenSea (Ethereum)
→ web/data/dagato_agency_data.json + catalog.

Complete limited drop (33 case files). Mirrors BIG KIX pipeline:
  - collection NFTs + best listings + events (transfers/sales/mints)
  - per-token owners
  - rarity trait extracted for UI tags (Common / Uncommon / Epic / Legendary / 1:1)

No creator-wallet exclusion — every holder counts (no steward stash of extras).

Usage (from backend/):
  python fetch_dagato_agency.py
  python fetch_dagato_agency.py --create-key
  python fetch_dagato_agency.py --quick
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

from collections_registry import get_collection
from owner_stats import dedupe_activity_rows, enrich_owner_stats
from opensea_client import OpenSeaClient

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = Path(__file__).resolve().parent / ".env"
OUTPUT_PATH = ROOT / "web" / "data" / "dagato_agency_data.json"
CATALOG_PATH = ROOT / "web" / "data" / "dagato_agency_catalog.json"

COLLECTION_ID = "dagato-agency"
CREATOR_ENS = "dagato.eth"
# OpenSea collection owner (steward); NOT excluded from holder stats
CREATOR_ADDRESS = "0xa5dcf683b5092cd9df2f6c15ecb8d7fc355b8dea"

# daGATO Case File #27
TITLE_RE = re.compile(
    r"daGATO\s+Case\s+File\s*#\s*(\d+)",
    re.I,
)

# Normalize OpenSea trait values → display labels
RARITY_DISPLAY = {
    "common": "Common",
    "uncommon": "Uncommon",
    "epic": "Epic",
    "legendary": "Legendary",
    "1 of 1": "1:1",
    "1:1": "1:1",
    "1of1": "1:1",
    "one of one": "1:1",
}


def load_api_key(create_if_missing: bool = False) -> str:
    load_dotenv(ENV_PATH)
    key = os.getenv("OPENSEA_API_KEY", "").strip()
    if key:
        return key
    if not create_if_missing:
        raise ValueError(
            "OPENSEA_API_KEY not set. Use CI env or run with --create-key (local)."
        )
    print("No OpenSea key — creating free instant key...")
    client = OpenSeaClient(api_key="temp", delay=0)
    key = client.create_instant_api_key()
    ENV_PATH.write_text(f"OPENSEA_API_KEY={key}\n", encoding="utf-8")
    print(f"Saved key to {ENV_PATH}")
    return key


def wei_to_eth(value: str, decimals: int = 18) -> float:
    return int(value) / (10**decimals)


def token_id_from_listing(listing: dict) -> str | None:
    asset = listing.get("asset") or {}
    if asset.get("identifier") is not None:
        return str(asset["identifier"])
    params = (listing.get("protocol_data") or {}).get("parameters") or {}
    offer = params.get("offer") or []
    if offer and offer[0].get("identifierOrCriteria") is not None:
        return str(offer[0]["identifierOrCriteria"])
    return None


def build_active_listings_map(client: OpenSeaClient) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for row in client.iter_collection_best_listings():
        if (row.get("status") or "").upper() != "ACTIVE":
            continue
        token_id = token_id_from_listing(row)
        if token_id:
            out[token_id] = row
    return out


def parse_listing_price(listing: dict) -> dict | None:
    """Parse listing price as per-unit ETH (ERC-1155 batch-aware)."""
    price = listing.get("price") or {}
    current = price.get("current") or {}
    raw = current.get("value")
    if raw is None:
        return None
    decimals = int(current.get("decimals", 18))
    currency = current.get("currency", "ETH")
    total_eth = wei_to_eth(str(raw), decimals)

    qty = 1
    rem = listing.get("remaining_quantity")
    if rem is not None:
        try:
            qty = max(1, int(rem))
        except (TypeError, ValueError):
            qty = 1
    if qty <= 1:
        params = (listing.get("protocol_data") or {}).get("parameters") or {}
        offer = params.get("offer") or []
        if offer:
            try:
                sa = int(offer[0].get("startAmount") or 1)
                if sa > 1:
                    qty = sa
            except (TypeError, ValueError):
                pass

    unit_eth = total_eth / qty if qty > 1 else total_eth
    out = {
        "amount_eth": unit_eth,
        "currency": currency,
        "status": listing.get("status"),
    }
    if qty > 1:
        out["quantity"] = qty
        out["total_eth"] = total_eth
    return out


def clean_description(text: str | None) -> str:
    if not text:
        return ""
    text = text.replace("\r\n", "\n").strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def excerpt(text: str, max_len: int = 160) -> str:
    if not text:
        return ""
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").split("\n") if ln.strip()]
    # Skip a title-like first line if present
    if lines and re.match(r"^daGATO\s+Case\s+File\s*#\s*\d+", lines[0], re.I):
        lines = lines[1:]
    body = " ".join(lines).strip() if lines else re.sub(r"\s+", " ", text).strip()
    flat = re.sub(r"\s+", " ", body).strip()
    if not flat:
        flat = re.sub(r"\s+", " ", text).strip()
    if len(flat) <= max_len:
        return flat
    return flat[: max_len - 1].rstrip() + "…"


def extract_rarity(traits: list | None) -> str | None:
    """Pull Rarity trait and normalize to display label."""
    for t in traits or []:
        tt = (t.get("trait_type") or "").strip().lower()
        if tt != "rarity":
            continue
        raw = str(t.get("value") or "").strip()
        if not raw:
            return None
        key = raw.lower()
        return RARITY_DISPLAY.get(key, raw)
    return None


def parse_case_title(name: str | None, token_id: str) -> tuple[str, str, str | None]:
    """Return (display_name, local_slug, opensea_name_if_different)."""
    raw = (name or "").strip()
    m = TITLE_RE.search(raw) if raw else None
    if m:
        num = m.group(1).zfill(2)
        display = f"daGATO Case File #{num}"
        slug = f"dagato-case-file-{num}"
        return display, slug, raw if raw != display else None
    try:
        num = str(int(token_id)).zfill(2)
    except ValueError:
        num = str(token_id)
    display = f"daGATO Case File #{num}"
    return display, f"dagato-case-file-{num}", raw or None


def summarize_owners(
    owners: list[dict] | None,
    *,
    exclude_addresses: set[str] | None = None,
) -> dict | None:
    if owners is None:
        return None
    exclude = {a.lower() for a in (exclude_addresses or set())}
    sorted_owners = sorted(
        owners, key=lambda x: int(x.get("quantity", 0)), reverse=True
    )
    holder_rows = []
    for o in sorted_owners:
        addr = (o.get("address") or "").lower()
        if not addr or addr in exclude:
            continue
        holder_rows.append(
            {
                "address": o.get("address"),
                "quantity": int(o.get("quantity", 0)),
            }
        )
    total_copies = sum(h["quantity"] for h in holder_rows)
    return {
        "holder_count": len(holder_rows),
        "circulating_copies": total_copies,
        "top_holders": holder_rows[:5],
        "holders": holder_rows,
        "creator_excluded": bool(exclude),
    }


ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


def parse_activity_event(event: dict) -> dict | None:
    ts = event.get("event_timestamp")
    if ts is None:
        return None
    at = datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
    event_type = (event.get("event_type") or "").lower()
    qty = int(event.get("quantity") or 1)

    if event_type == "transfer":
        transfer_type = (event.get("transfer_type") or "").lower()
        from_addr = (event.get("from_address") or "").lower()
        to_addr = event.get("to_address") or ""
        if transfer_type in ("mint", "create") or from_addr in (ZERO_ADDRESS, ""):
            kind = "mint"
        else:
            kind = "transfer"
        return {
            "type": kind,
            "at": at,
            "from": event.get("from_address") if kind == "transfer" else None,
            "to": to_addr or None,
            "quantity": qty,
        }

    if event_type == "sale":
        return {
            "type": "sale",
            "at": at,
            "from": event.get("seller") or event.get("from_address"),
            "to": event.get("buyer") or event.get("to_address"),
            "quantity": qty,
            "price_eth": None,
        }

    if event_type == "mint":
        return {
            "type": "mint",
            "at": at,
            "from": None,
            "to": event.get("to_address") or event.get("buyer"),
            "quantity": qty,
        }

    return None


def process_collection_events(
    client: OpenSeaClient,
    *,
    max_activity_per_token: int = 12,
) -> tuple[dict[str, str], dict[str, list[dict]]]:
    earliest: dict[str, int] = {}
    activity: dict[str, list[dict]] = {}

    print("Fetching collection events (mints + transfers + sales)...")
    for event in client.iter_collection_events(
        event_types=["mint", "transfer", "sale"]
    ):
        nft = event.get("nft") or event.get("asset") or {}
        token_id = str(nft.get("identifier", ""))
        ts = event.get("event_timestamp")
        if not token_id or ts is None:
            continue
        ts = int(ts)

        event_type = (event.get("event_type") or "").lower()
        if event_type == "transfer":
            transfer_type = (event.get("transfer_type") or "").lower()
            from_addr = (event.get("from_address") or "").lower()
            if transfer_type in ("mint", "create") or from_addr in (ZERO_ADDRESS, ""):
                prev = earliest.get(token_id)
                if prev is None or ts < prev:
                    earliest[token_id] = ts
        elif event_type == "mint":
            prev = earliest.get(token_id)
            if prev is None or ts < prev:
                earliest[token_id] = ts

        row = parse_activity_event(event)
        if row:
            activity.setdefault(token_id, []).append(row)

    mint_dates = {
        tid: datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        for tid, ts in earliest.items()
    }
    trimmed: dict[str, list[dict]] = {}
    for tid, rows in activity.items():
        rows = dedupe_activity_rows(rows)
        rows.sort(key=lambda r: r["at"], reverse=True)
        trimmed[tid] = rows[:max_activity_per_token]

    print(f"  Activity rows for {len(trimmed)} tokens; mints for {len(mint_dates)}")
    return mint_dates, trimmed


def build_item(
    nft: dict,
    listing: dict | None,
    owners: list[dict] | None,
    *,
    minted_at: str | None = None,
    recent_activity: list[dict] | None = None,
) -> dict:
    token_id = str(nft.get("identifier", ""))
    description = clean_description(nft.get("description"))
    listing_info = parse_listing_price(listing) if listing else None
    # No creator exclusion for this collection
    owner_stats = summarize_owners(owners, exclude_addresses=None)
    owner_stats = enrich_owner_stats(owner_stats, recent_activity)

    raw_name = nft.get("name") or f"daGATO Case File #{token_id}"
    display, slug, opensea_name = parse_case_title(raw_name, token_id)
    image_url = nft.get("display_image_url") or nft.get("image_url") or ""
    media_type = (
        "video" if re.search(r"\.(mov|mp4|webm)(\?|$)", image_url, re.I) else "image"
    )
    traits = nft.get("traits") or []
    rarity = extract_rarity(traits)

    item = {
        "token_id": token_id,
        "name": display,
        "display_name": display,
        "local_slug": slug,
        "description": description,
        "excerpt": excerpt(description) if description else display,
        "image_url": image_url,
        "media_type": media_type,
        "opensea_url": nft.get("opensea_url"),
        "metadata_url": nft.get("metadata_url"),
        "updated_at": nft.get("updated_at"),
        "traits": traits,
        "rarity": rarity,
        "listed": listing_info is not None,
        "listing": listing_info,
        "owners": owner_stats,
        "collection_id": COLLECTION_ID,
    }
    if minted_at:
        item["minted_at"] = minted_at
    if recent_activity:
        item["recent_activity"] = recent_activity
    if opensea_name:
        item["opensea_name"] = opensea_name
    return item


def slim_item(item: dict) -> dict:
    # Keep activity + rarity in catalog: small collection (~33) and modal needs activity
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
        "collection_id": COLLECTION_ID,
        "opensea_name": item.get("opensea_name"),
        "rarity": item.get("rarity"),
        "traits": item.get("traits") or [],
    }
    activity = item.get("recent_activity") or []
    if activity:
        out["recent_activity"] = activity[:12]
    return out


def write_catalog(payload: dict) -> None:
    items = [slim_item(it) for it in payload.get("items") or []]
    catalog = {
        "generated_at": payload.get("generated_at"),
        "source": "dagato_agency_catalog",
        "collection": payload.get("collection"),
        "items": items,
    }
    CATALOG_PATH.write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Wrote {CATALOG_PATH} ({len(items)} items)")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch daGATO Detective Agency → dagato_agency_data.json"
    )
    parser.add_argument(
        "--quick", action="store_true", help="Skip listings/owners/events"
    )
    parser.add_argument("--max-items", type=int, default=0, help="Limit (0=all)")
    parser.add_argument(
        "--create-key",
        action="store_true",
        help="Create OpenSea instant API key if missing (local only)",
    )
    args = parser.parse_args()

    reg = get_collection(COLLECTION_ID)
    if not reg:
        raise RuntimeError(f"Collection '{COLLECTION_ID}' missing from registry")

    slug = reg.get("opensea_slug") or "dagato-detective-agency-volume-1"
    chain = reg.get("chain") or "ethereum"
    contract = (reg.get("contract") or "").lower()
    if not contract:
        raise RuntimeError("daGATO Agency contract missing from registry")

    api_key = load_api_key(create_if_missing=args.create_key)
    client = OpenSeaClient(
        api_key,
        chain=chain,
        contract=contract,
        collection_slug=slug,
    )

    print(f"daGATO Detective Agency — {chain} / {slug} / {contract[:10]}…")
    contract_meta = client.get_contract()
    print(f"  Contract name: {contract_meta.get('name')}")

    print("Fetching collection stats...")
    stats_raw = client.get_collection_stats()
    total = stats_raw.get("total") or {}

    creator_wallet = None
    try:
        resolved = client.resolve_account(CREATOR_ENS)
        if resolved.get("address"):
            creator_wallet = resolved
    except requests.HTTPError:
        creator_wallet = {"address": CREATOR_ADDRESS, "ens_name": CREATOR_ENS}

    print("Fetching NFT metadata...")
    nfts = client.iter_collection_nfts()
    nfts.sort(key=lambda n: int(n.get("identifier", 0) or 0), reverse=True)
    if args.max_items > 0:
        nfts = nfts[: args.max_items]
    print(f"  {len(nfts)} NFTs")

    mint_dates: dict[str, str] = {}
    activity_by_token: dict[str, list[dict]] = {}
    if not args.quick:
        try:
            mint_dates, activity_by_token = process_collection_events(client)
        except Exception as exc:
            print(f"  Warning: collection events failed ({exc})")

    listings_by_token: dict[str, dict] = {}
    if not args.quick:
        print("Fetching active listings…")
        try:
            listings_by_token = build_active_listings_map(client)
            print(f"  {len(listings_by_token)} listed")
        except Exception as exc:
            print(f"  Warning: listings failed ({exc})")

    items = []
    listed_count = 0
    rarity_counts: dict[str, int] = {}
    for i, nft in enumerate(nfts, 1):
        token_id = str(nft.get("identifier"))
        print(f"  [{i}/{len(nfts)}] token #{token_id}", end="", flush=True)
        listing = None
        owners = None
        if not args.quick:
            listing = listings_by_token.get(token_id)
            if listing is None:
                try:
                    listing = client.get_best_listing(token_id)
                except requests.HTTPError:
                    listing = None
            try:
                owners = client.get_nft_owners(token_id)
            except Exception:
                owners = []
        item = build_item(
            nft,
            listing,
            owners,
            minted_at=mint_dates.get(token_id),
            recent_activity=activity_by_token.get(token_id),
        )
        if item["listed"]:
            listed_count += 1
        r = item.get("rarity") or "Unknown"
        rarity_counts[r] = rarity_counts.get(r, 0) + 1
        items.append(item)
        print(f" ✓ [{r}]")

    # Unique holders across pieces (no creator exclude)
    all_holders: set[str] = set()
    for it in items:
        for h in (it.get("owners") or {}).get("holders") or []:
            a = (h.get("address") or "").lower()
            if a:
                all_holders.add(a)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "opensea_api_v2",
        "collection": {
            "id": COLLECTION_ID,
            "slug": slug,
            "name": "daGATO Detective Agency: Volume 1",
            "display_name": "daGATO Detective Agency: Volume 1",
            "contract": contract,
            "chain": chain,
            "opensea_url": f"https://opensea.io/collection/{slug}",
            "note": (
                "Limited cyber-noir detective case files on Ethereum. "
                "Stewarded by dagato.eth. Complete collection — all holders counted."
            ),
            "creator_ens": CREATOR_ENS,
            "creator_wallet": creator_wallet
            or {"address": CREATOR_ADDRESS, "ens_name": CREATOR_ENS},
            "creator_excluded_from_stats": False,
            "contract_name": contract_meta.get("name"),
            "floor_eth": total.get("floor_price"),
            "floor_symbol": total.get("floor_price_symbol", "ETH"),
            "num_owners": len(all_holders),
            "total_sales": total.get("sales"),
            "total_volume": total.get("volume"),
            "piece_count": len(items),
            "listed_count": listed_count,
            "rarity_counts": rarity_counts,
            "image_url": (
                "https://i2c.seadn.io/collection/dagato-detective-agency-volume-1/"
                "image_type_logo/6dcbf6a0f830a10ef45731c2e11f2b/"
                "e96dcbf6a0f830a10ef45731c2e11f2b.png"
            ),
        },
        "items": items,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(
        f"\nWrote {OUTPUT_PATH} — {len(items)} pieces, {listed_count} listed, "
        f"{len(all_holders)} collectors"
    )
    print(f"  Rarity: {rarity_counts}")
    write_catalog(payload)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)
    except Exception as e:
        print(f"daGATO Agency fetch failed: {e}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        sys.exit(1)
