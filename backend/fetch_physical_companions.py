"""
Fetch daCAT World Physical Companions from OpenSea (Ethereum)
→ web/data/physical_companions_data.json + catalog.

Umbrella collection for physical + NFT pairs. First series:
  DACAT WORLD Founders Edition 3D Printed Collectible Figures
  slug: dacatworldfoundersedition · max 20 · tokens 1–20.

Browse shows one series_rep card (generic image); wallets/detail show
real numbered editions. Future physical series append under the same
collection_id with a distinct physical_series key.

Usage (from backend/):
  python fetch_physical_companions.py
  python fetch_physical_companions.py --create-key
  python fetch_physical_companions.py --quick
  python fetch_physical_companions.py --from-scrape path/to/scrape.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

from collections_registry import get_collection
from owner_stats import dedupe_activity_rows, enrich_owner_stats
from opensea_client import OpenSeaClient

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = Path(__file__).resolve().parent / ".env"
OUTPUT_PATH = ROOT / "web" / "data" / "physical_companions_data.json"
CATALOG_PATH = ROOT / "web" / "data" / "physical_companions_catalog.json"

COLLECTION_ID = "physical-companions"
SERIES_ID = "founders-edition"
SERIES_LABEL = "Founders Edition"
MAX_TOKEN_ID = 20

# Steward wallet (also BIG KIX). Counts as a collector for Physical Companions.
CREATOR_ADDRESS = "0xa6d5c9602a49afddff9873cf51db2991dec2c9ee"
CREATOR_ENS = "dacatworld.eth"

GENERIC_IMAGE = (
    "assets/physical-companions/dacat-world-founders-edition-collectible-figure.png"
)

TITLE_RE = re.compile(
    r"DACAT\s*WORLD\s*#\s*(\d+)\s*of\s*20\s*FOUNDERS\s*EDITION",
    re.I,
)

SERIES_DESCRIPTION = (
    "DACAT WORLD Founders Edition — 3D Printed Collectible Figures.\n\n"
    "Step into DACAT WORLD with the Founders Edition physical + NFT pair. "
    "Created by Russell Corey, each NFT is the digital companion to a numbered "
    "physical figure (1 of 20 through 20 of 20). Artwork shows the carded figure "
    "and packaging with Founders Edition branding."
)

SERIES_EXCERPT = (
    "Physical companion · Founders Edition 1–20 · "
    "3D printed collectible figure with matching NFT."
)


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
    if lines and TITLE_RE.match(lines[0]):
        lines = lines[1:]
    body = " ".join(lines).strip() if lines else re.sub(r"\s+", " ", text).strip()
    body = re.sub(
        r"^DACAT\s*WORLD\s*#\s*\d+\s*of\s*20\s*FOUNDERS\s*EDITION\s*",
        "",
        body,
        flags=re.I,
    ).strip()
    flat = re.sub(r"\s+", " ", body).strip()
    if not flat:
        flat = re.sub(r"\s+", " ", text).strip()
    if len(flat) <= max_len:
        return flat
    return flat[: max_len - 1].rstrip() + "…"


def parse_founders_title(name: str | None, token_id: str) -> tuple[str, str, str | None]:
    """Return (display_name, local_slug, opensea_name_if_different)."""
    raw = (name or "").strip()
    m = TITLE_RE.search(raw) if raw else None
    if m:
        num = m.group(1)
    else:
        try:
            num = str(int(token_id))
        except ValueError:
            num = str(token_id)
    try:
        num_int = int(num)
        num_disp = str(num_int)
    except ValueError:
        num_disp = num
    display = f"DACAT WORLD Founders Edition #{num_disp}"
    slug = f"founders-edition-{num_disp}"
    return display, slug, raw if raw and raw != display else None


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
        row = {
            "address": o.get("address"),
            "quantity": int(o.get("quantity", 0)),
        }
        if o.get("ens_name"):
            row["ens_name"] = o["ens_name"]
        if o.get("username"):
            row["username"] = o["username"]
        holder_rows.append(row)
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
        try:
            tid_int = int(token_id)
        except ValueError:
            continue
        if tid_int < 1 or tid_int > MAX_TOKEN_ID:
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
    # Include steward in owners — they rank as a real Physical Companions collector
    owner_stats_full = summarize_owners(owners, exclude_addresses=None)
    owner_stats = enrich_owner_stats(owner_stats_full, recent_activity)

    raw_name = nft.get("name") or f"DACAT WORLD #{token_id} of 20 FOUNDERS EDITION"
    display, slug, opensea_name = parse_founders_title(raw_name, token_id)
    image_url = nft.get("display_image_url") or nft.get("image_url") or ""
    media_type = (
        "video" if re.search(r"\.(mov|mp4|webm)(\?|$)", image_url, re.I) else "image"
    )

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
        "traits": nft.get("traits") or [
            {"trait_type": "Edition", "value": f"{token_id} of 20"},
            {"trait_type": "Series", "value": SERIES_LABEL},
        ],
        "rarity": "Physical",
        "physical_series": SERIES_ID,
        "physical_series_label": SERIES_LABEL,
        "listed": listing_info is not None,
        "listing": listing_info,
        "owners": owner_stats,
        "collection_id": COLLECTION_ID,
        "is_edition_token": True,
        "is_series_rep": False,
        "physical_series_rep": False,
        "max_supply": MAX_TOKEN_ID,
    }
    if minted_at:
        item["minted_at"] = minted_at
    if recent_activity:
        item["recent_activity"] = recent_activity
    if opensea_name:
        item["opensea_name"] = opensea_name
    if image_url.startswith("http"):
        item["opensea_image_url"] = image_url
    return item


def build_series_rep(edition_items: list[dict], *, slug: str) -> dict:
    """One browse card for the Founders Edition series (generic art)."""
    members = sorted(
        edition_items,
        key=lambda m: int(m.get("token_id") or 0),
    )
    editions = []
    holder_qty: dict[str, dict] = {}
    for m in members:
        holders = (m.get("owners") or {}).get("holders") or []
        primary = holders[0] if holders else None
        editions.append(
            {
                "token_id": m.get("token_id"),
                "name": m.get("display_name") or m.get("name"),
                "image_url": m.get("image_url"),
                "opensea_url": m.get("opensea_url"),
                "listed": m.get("listed", False),
                "minted_at": m.get("minted_at"),
                "owner_address": (primary or {}).get("address"),
                "owner_ens": (primary or {}).get("ens_name"),
                "owner_username": (primary or {}).get("username"),
                "physical_series": SERIES_ID,
            }
        )
        for h in holders:
            addr = (h.get("address") or "").lower()
            if not addr:
                continue
            qty = int(h.get("quantity") or 1)
            if addr not in holder_qty:
                holder_qty[addr] = {
                    "address": h.get("address") or addr,
                    "quantity": 0,
                    "ens_name": h.get("ens_name"),
                    "username": h.get("username"),
                }
            holder_qty[addr]["quantity"] += qty
            if h.get("ens_name") and not holder_qty[addr].get("ens_name"):
                holder_qty[addr]["ens_name"] = h["ens_name"]
            if h.get("username") and not holder_qty[addr].get("username"):
                holder_qty[addr]["username"] = h["username"]

    holders = sorted(holder_qty.values(), key=lambda x: x["quantity"], reverse=True)
    total_copies = sum(h["quantity"] for h in holders)
    minted_count = len(members)

    activity_rows: list[dict] = []
    for m in members:
        for row in m.get("recent_activity") or []:
            if isinstance(row, dict):
                activity_rows.append(dict(row))
    if activity_rows:
        activity_rows = dedupe_activity_rows(activity_rows)
        activity_rows.sort(key=lambda r: r.get("at") or "", reverse=True)
        activity_rows = activity_rows[:12]

    minted_candidates = [m.get("minted_at") for m in members if m.get("minted_at")]
    first_minted = min(minted_candidates) if minted_candidates else None
    if not first_minted and activity_rows:
        mint_acts = [
            r.get("at")
            for r in activity_rows
            if r.get("type") == "mint" and r.get("at")
        ]
        if mint_acts:
            first_minted = min(mint_acts)

    owners_payload = {
        "holder_count": len(holders),
        "circulating_copies": total_copies,
        "top_holders": holders[:8],
        "holders": holders,
        "creator_excluded": False,
    }
    owners_payload = enrich_owner_stats(owners_payload, activity_rows)

    series_item: dict = {
        "token_id": f"series-{SERIES_ID}",
        "name": "DACAT WORLD Founders Edition",
        "display_name": "DACAT WORLD Founders Edition",
        "local_slug": f"physical-{SERIES_ID}",
        "description": SERIES_DESCRIPTION,
        "excerpt": (
            f"Physical companion · {minted_count} of {MAX_TOKEN_ID} minted · "
            f"{len(holders)} holder{'s' if len(holders) != 1 else ''}"
        ),
        "image_url": GENERIC_IMAGE,
        "shared_series_image": GENERIC_IMAGE,
        "media_type": "image",
        "opensea_url": f"https://opensea.io/collection/{slug}",
        "traits": [
            {"trait_type": "Series", "value": SERIES_LABEL},
            {"trait_type": "Type", "value": "Physical Companion"},
            {"trait_type": "Max Supply", "value": str(MAX_TOKEN_ID)},
        ],
        "rarity": "Physical",
        "physical_series": SERIES_ID,
        "physical_series_label": SERIES_LABEL,
        "listed": False,
        "listing": None,
        "owners": owners_payload,
        "collection_id": COLLECTION_ID,
        "is_series_rep": True,
        "physical_series_rep": True,
        "is_edition_token": False,
        "edition_count": minted_count,
        "max_supply": MAX_TOKEN_ID,
        "editions": editions,
        "member_token_ids": [m.get("token_id") for m in members],
    }
    if first_minted:
        series_item["minted_at"] = first_minted
    if activity_rows:
        series_item["recent_activity"] = activity_rows
    return series_item


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
        "collection_id": COLLECTION_ID,
        "opensea_name": item.get("opensea_name"),
        "rarity": item.get("rarity"),
        "traits": item.get("traits") or [],
        "physical_series": item.get("physical_series"),
        "physical_series_label": item.get("physical_series_label"),
        "is_series_rep": bool(item.get("is_series_rep")),
        "physical_series_rep": bool(item.get("physical_series_rep")),
        "is_edition_token": bool(item.get("is_edition_token")),
        "max_supply": item.get("max_supply"),
    }
    if item.get("shared_series_image"):
        out["shared_series_image"] = item["shared_series_image"]
    if item.get("edition_count") is not None:
        out["edition_count"] = item.get("edition_count")
    if item.get("editions"):
        out["editions"] = item.get("editions")
    if item.get("member_token_ids"):
        out["member_token_ids"] = item.get("member_token_ids")
    if item.get("physical_series_rep") and item.get("description"):
        out["description"] = item.get("description")
    activity = item.get("recent_activity") or []
    if activity:
        out["recent_activity"] = activity[:12]
    return out


def write_catalog(payload: dict) -> None:
    items = [slim_item(it) for it in payload.get("items") or []]
    catalog = {
        "generated_at": payload.get("generated_at"),
        "source": "physical_companions_catalog",
        "collection": payload.get("collection"),
        "items": items,
    }
    CATALOG_PATH.write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Wrote {CATALOG_PATH} ({len(items)} items)")


def relative_to_iso(relative: str | None, scraped_at: str | None) -> str | None:
    """Best-effort convert OpenSea '3d ago' strings using scrape timestamp."""
    if not relative:
        return None
    base = datetime.now(timezone.utc)
    if scraped_at:
        try:
            base = datetime.fromisoformat(scraped_at.replace("Z", "+00:00"))
        except ValueError:
            pass
    m = re.match(r"(\d+)\s*(d|h|m|s)\s*ago", relative.strip(), re.I)
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2).lower()
    delta = {
        "d": timedelta(days=n),
        "h": timedelta(hours=n),
        "m": timedelta(minutes=n),
        "s": timedelta(seconds=n),
    }.get(unit)
    if not delta:
        return None
    return (base - delta).isoformat()


def build_from_scrape(scrape_path: Path) -> dict:
    """Bootstrap data JSON from a Playwright/public scrape when API key is unavailable."""
    raw = json.loads(scrape_path.read_text(encoding="utf-8"))
    scraped_at = raw.get("scraped_at")
    contract = (raw.get("contract") or "").lower()
    items: list[dict] = []

    for row in raw.get("items") or []:
        tid = str(row.get("token_id") or "")
        try:
            tid_int = int(tid)
        except ValueError:
            continue
        if tid_int < 1 or tid_int > MAX_TOKEN_ID:
            continue

        addr = (row.get("owner_address") or "").strip()
        username = row.get("owner_username")
        # Skip OpenSea shortened 0x display as username
        if username and re.match(r"^0x[0-9a-fA-F]{0,6}\.\.\.[0-9a-fA-F]{0,4}$", username):
            username = None
        owners_list = []
        if addr:
            o: dict = {"address": addr, "quantity": 1}
            if username and not username.lower().startswith("0x"):
                o["username"] = username
            owners_list.append(o)

        nft = {
            "identifier": tid,
            "name": row.get("name"),
            "description": row.get("description") or "",
            "image_url": row.get("image_url") or "",
            "display_image_url": row.get("image_url") or "",
            "opensea_url": row.get("opensea_url")
            or f"https://opensea.io/item/ethereum/{contract}/{tid}",
            "traits": [
                {"trait_type": "Edition", "value": f"{tid} of 20"},
                {"trait_type": "Series", "value": SERIES_LABEL},
            ],
        }
        minted_at = relative_to_iso(row.get("minted_relative"), scraped_at)
        item = build_item(
            nft,
            None,
            owners_list,
            minted_at=minted_at,
            recent_activity=None,
        )
        items.append(item)

    items.sort(key=lambda it: int(it.get("token_id") or 0))
    series = build_series_rep(items, slug="dacatworldfoundersedition")
    return assemble_payload(items, series, contract=contract, slug="dacatworldfoundersedition")


def assemble_payload(
    edition_items: list[dict],
    series: dict,
    *,
    contract: str,
    slug: str,
    stats_total: dict | None = None,
    creator_wallet: dict | None = None,
    contract_name: str | None = None,
) -> dict:
    listed_count = sum(1 for it in edition_items if it.get("listed"))
    community_holders: set[str] = set()
    for it in edition_items:
        for h in (it.get("owners") or {}).get("holders") or []:
            a = (h.get("address") or "").lower()
            if a:
                community_holders.add(a)

    total = stats_total or {}
    first_minted = series.get("minted_at")
    all_items = [series] + edition_items

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "opensea_api_v2",
        "collection": {
            "id": COLLECTION_ID,
            "slug": slug,
            "name": "daCAT World Physical Companions",
            "display_name": "daCAT World Physical Companions",
            "contract": contract,
            "chain": "ethereum",
            "opensea_url": f"https://opensea.io/collection/{slug}",
            "note": (
                "Umbrella for physical + NFT pairs. Founders Edition is the first "
                "series (max 20). Stewarded by dacatworld.eth."
            ),
            "creator_ens": CREATOR_ENS,
            "creator_wallet": creator_wallet
            or {"address": CREATOR_ADDRESS, "ens_name": CREATOR_ENS},
            "creator_excluded_from_stats": False,
            "contract_name": contract_name or "DACAT WORLD Founders Edition",
            "floor_eth": total.get("floor_price"),
            "floor_symbol": total.get("floor_price_symbol", "ETH"),
            "num_owners": len(community_holders),
            "total_sales": total.get("sales"),
            "total_volume": total.get("volume"),
            "piece_count": len(edition_items),
            "listed_count": listed_count,
            "max_supply": MAX_TOKEN_ID,
            "first_minted_at": first_minted,
            "series": [
                {
                    "id": SERIES_ID,
                    "label": SERIES_LABEL,
                    "opensea_slug": slug,
                    "contract": contract,
                    "max_supply": MAX_TOKEN_ID,
                    "minted_count": len(edition_items),
                    "generic_image": GENERIC_IMAGE,
                    "first_minted_at": first_minted,
                }
            ],
            "generic_image": GENERIC_IMAGE,
        },
        "items": all_items,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch Physical Companions → physical_companions_data.json"
    )
    parser.add_argument("--quick", action="store_true", help="Skip listings/owners/events")
    parser.add_argument(
        "--max-items",
        type=int,
        default=MAX_TOKEN_ID,
        help=f"Cap token fetch (default {MAX_TOKEN_ID})",
    )
    parser.add_argument(
        "--create-key",
        action="store_true",
        help="Create OpenSea instant API key if missing (local only)",
    )
    parser.add_argument(
        "--from-scrape",
        type=str,
        default="",
        help="Bootstrap from a scrape JSON instead of the OpenSea API",
    )
    args = parser.parse_args()

    if args.from_scrape:
        scrape_path = Path(args.from_scrape)
        if not scrape_path.is_file():
            raise FileNotFoundError(f"Scrape file not found: {scrape_path}")
        print(f"Bootstrapping from scrape: {scrape_path}")
        payload = build_from_scrape(scrape_path)
        payload["source"] = "opensea_page_scrape"
        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_PATH.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        n_ed = sum(1 for it in payload["items"] if it.get("is_edition_token"))
        print(f"\nWrote {OUTPUT_PATH} — {n_ed} editions + series_rep")
        write_catalog(payload)
        return 0

    reg = get_collection(COLLECTION_ID)
    if not reg:
        raise RuntimeError(f"Collection '{COLLECTION_ID}' missing from registry")

    slug = reg.get("opensea_slug") or "dacatworldfoundersedition"
    chain = reg.get("chain") or "ethereum"
    contract = (reg.get("contract") or "").lower()
    if not contract:
        raise RuntimeError("Physical Companions contract missing from registry")

    api_key = load_api_key(create_if_missing=args.create_key)
    client = OpenSeaClient(
        api_key,
        chain=chain,
        contract=contract,
        collection_slug=slug,
    )

    print(f"Physical Companions / Founders Edition — {chain} / {slug} / {contract[:10]}…")
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
    # Cap at tokens 1..MAX_TOKEN_ID so future mints auto-include up to 20
    filtered = []
    for n in nfts:
        try:
            tid = int(n.get("identifier", 0) or 0)
        except (TypeError, ValueError):
            continue
        if 1 <= tid <= MAX_TOKEN_ID:
            filtered.append(n)
    filtered.sort(key=lambda n: int(n.get("identifier", 0) or 0))
    cap = args.max_items if args.max_items > 0 else MAX_TOKEN_ID
    if cap < MAX_TOKEN_ID:
        filtered = filtered[:cap]
    print(f"  {len(filtered)} NFTs (capped at {MAX_TOKEN_ID})")

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
    for i, nft in enumerate(filtered, 1):
        token_id = str(nft.get("identifier"))
        print(f"  [{i}/{len(filtered)}] token #{token_id}", end="", flush=True)
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
        items.append(item)
        print(" ✓")

    series = build_series_rep(items, slug=slug)
    payload = assemble_payload(
        items,
        series,
        contract=contract,
        slug=slug,
        stats_total=total,
        creator_wallet=creator_wallet,
        contract_name=contract_meta.get("name"),
    )

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"\nWrote {OUTPUT_PATH} — {len(items)} editions + series_rep")
    write_catalog(payload)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)
    except Exception as e:
        print(f"Physical Companions fetch failed: {e}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        sys.exit(1)
