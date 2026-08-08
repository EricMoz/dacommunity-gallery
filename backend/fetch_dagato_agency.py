"""
Fetch daGATO Detective Agency volumes from OpenSea (Ethereum)
→ merge into web/data/dagato_agency_data.json + catalog.

One **site** collection (`dagato-agency`); each OpenSea drop is a volume
(Vol 1, Vol 2, …) with its own slug/contract. Browse still shows **5 rarity
series per volume**; collector wallets show real case-file token #s.

No creator-wallet exclusion — every holder counts.

Usage (from backend/):
  python fetch_dagato_agency.py              # all volumes in registry
  python fetch_dagato_agency.py --volume 2   # one volume only (rewrites full file)
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

# Fallback volume map if registry has no ``volumes`` array yet.
# Vol 2 contract from OpenSea collection page (distinct ERC drop from Vol 1).
DEFAULT_VOLUMES: list[dict] = [
    {
        "volume": 1,
        "opensea_slug": "dagato-detective-agency-volume-1",
        "contract": "0x716d87b0d348b715c423599c080ab426747bcf6e",
        "chain": "ethereum",
        "image_url": (
            "https://i2c.seadn.io/collection/dagato-detective-agency-volume-1/"
            "image_type_logo/6dcbf6a0f830a10ef45731c2e11f2b/"
            "e96dcbf6a0f830a10ef45731c2e11f2b.png"
        ),
    },
    {
        "volume": 2,
        "opensea_slug": "dagato-detective-agency-volume-2",
        "contract": "0xeac8fc9a9f4825a9bb7b4ee4b7e90e9c6c27542f",
        "chain": "ethereum",
        "image_url": None,
    },
]

# Mutated per-volume during fetch (build_item / series helpers).
VOLUME = 1
VOLUME_LABEL = f"Vol {VOLUME}"
VOLUME_OPENSEA_SLUG = DEFAULT_VOLUMES[0]["opensea_slug"]

# daGATO Case File #27 (OpenSea raw titles)
TITLE_RE = re.compile(
    r"(?:daGATO\s+)?Case\s+File\s*#\s*(\d+)",
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


def format_edition_title(
    rarity: str | None,
    token_id: str,
    *,
    volume_label: str = VOLUME_LABEL,
) -> str:
    """Site display: '{Rarity} Case File #NN · Vol N'."""
    r = rarity or "Common"
    try:
        num = str(int(token_id)).zfill(2)
    except ValueError:
        num = str(token_id)
    return f"{r} Case File #{num} · {volume_label}"


def format_series_title(
    rarity: str,
    *,
    volume_label: str = VOLUME_LABEL,
) -> str:
    """Browse tier: '{Rarity} Case File · Vol N'."""
    return f"{rarity} Case File · {volume_label}"


def parse_case_title(
    name: str | None,
    token_id: str,
    *,
    rarity: str | None = None,
    volume: int = VOLUME,
    volume_label: str | None = None,
) -> tuple[str, str, str | None]:
    """Return (display_name, local_slug, opensea_name_if_different)."""
    raw = (name or "").strip()
    label = volume_label or f"Vol {volume}"
    m = TITLE_RE.search(raw) if raw else None
    if m:
        num = m.group(1).zfill(2)
    else:
        try:
            num = str(int(token_id)).zfill(2)
        except ValueError:
            num = str(token_id)
    display = format_edition_title(rarity, num, volume_label=label)
    slug = f"case-file-v{volume}-{num}"
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

    traits = nft.get("traits") or []
    rarity = extract_rarity(traits)
    raw_name = nft.get("name") or f"daGATO Case File #{token_id}"
    display, slug, opensea_name = parse_case_title(
        raw_name, token_id, rarity=rarity, volume=VOLUME, volume_label=VOLUME_LABEL
    )
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
        "traits": traits,
        "rarity": rarity,
        "volume": VOLUME,
        "volume_label": VOLUME_LABEL,
        "opensea_slug": VOLUME_OPENSEA_SLUG,
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


# Browse shows 5 rarity tiers (token rank 1 = highest). Editions stay for wallet view.
RARITY_RANK_ORDER = ("1:1", "Legendary", "Epic", "Uncommon", "Common")
RARITY_TO_RANK = {label: i + 1 for i, label in enumerate(RARITY_RANK_ORDER)}


def build_rarity_series(
    edition_items: list[dict],
    *,
    volume: int,
    volume_label: str,
    opensea_slug: str,
) -> list[dict]:
    """Aggregate case files into 5 rarity series rows for the search grid.

    Edition tokens remain in the payload (collector wallet uses real token #s).
    Series rows carry aggregated holders / circulating copies for the detail panel.
    One set of 5 series **per volume** (token_id ``rank-v{{vol}}-{{rank}}`` so Vols don't collide).
    """
    by_rarity: dict[str, list[dict]] = {r: [] for r in RARITY_RANK_ORDER}
    for it in edition_items:
        r = it.get("rarity") or "Common"
        if r not in by_rarity:
            by_rarity.setdefault(r, [])
        by_rarity[r].append(it)

    series: list[dict] = []
    for label in RARITY_RANK_ORDER:
        members = by_rarity.get(label) or []
        if not members:
            continue
        rank = RARITY_TO_RANK[label]
        # Representative art: lowest case file # for stability
        members_sorted = sorted(
            members, key=lambda m: int(m.get("token_id") or 0)
        )
        rep = members_sorted[0]

        # Aggregate holders across all case files of this rarity
        holder_qty: dict[str, dict] = {}
        for m in members:
            for h in (m.get("owners") or {}).get("holders") or []:
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

        holders = sorted(
            holder_qty.values(), key=lambda x: x["quantity"], reverse=True
        )
        total_copies = sum(h["quantity"] for h in holders)
        file_count = len(members)

        # Best (lowest) active listing among members
        best_listing = None
        any_listed = False
        for m in members:
            if not m.get("listed") or not m.get("listing"):
                continue
            any_listed = True
            price = m["listing"].get("amount_eth")
            if price is None:
                continue
            if best_listing is None or float(price) < float(
                best_listing.get("amount_eth") or 1e18
            ):
                best_listing = m["listing"]

        case_files = [
            {
                "token_id": m.get("token_id"),
                "name": m.get("display_name") or m.get("name"),
                "image_url": m.get("image_url"),
                "opensea_url": m.get("opensea_url"),
                "listed": m.get("listed", False),
                "volume": volume,
                "volume_label": volume_label,
            }
            for m in members_sorted
        ]

        slug_key = "1of1" if label == "1:1" else label.lower()
        # Browse: '{Rarity} Case File · Vol N'; token pill shows #1–#5 (token_rank)
        display = format_series_title(label, volume_label=volume_label)
        excerpt = (
            f"Detective Agency {volume_label} · {file_count} case file"
            f"{'s' if file_count != 1 else ''} · "
            f"{len(holders)} holder{'s' if len(holders) != 1 else ''} · "
            f"{total_copies} cop{'ies' if total_copies != 1 else 'y'}"
        )
        def _case_file_id_label(m: dict) -> str:
            tid = m.get("token_id")
            try:
                return f"#{str(int(tid)).zfill(2)}"
            except (TypeError, ValueError):
                return f"#{tid}" if tid is not None else "#?"

        description = (
            f"daGATO Detective Agency: Volume {volume}.\n\n"
            f"{file_count} case file{'s' if file_count != 1 else ''} at {label} rarity. "
            f"Open holders and recent transfers below.\n\n"
            f"Case files: "
            + ", ".join(_case_file_id_label(m) for m in members_sorted)
            + "."
        )

        # Merge mint/transfer/sale history from member case files (same UX as BIG KIX)
        activity_rows: list[dict] = []
        for m in members_sorted:
            for row in m.get("recent_activity") or []:
                if not isinstance(row, dict):
                    continue
                activity_rows.append(dict(row))
        if activity_rows:
            activity_rows = dedupe_activity_rows(activity_rows)
            activity_rows.sort(key=lambda r: r.get("at") or "", reverse=True)
            activity_rows = activity_rows[:12]

        # First minted for the tier = earliest case-file mint (sort / detail parity)
        minted_candidates = [
            m.get("minted_at")
            for m in members_sorted
            if m.get("minted_at")
        ]
        tier_minted_at = min(minted_candidates) if minted_candidates else None
        # Fallback: earliest mint-type activity row
        if not tier_minted_at and activity_rows:
            mint_acts = [
                r.get("at")
                for r in activity_rows
                if r.get("type") == "mint" and r.get("at")
            ]
            if mint_acts:
                tier_minted_at = min(mint_acts)

        owners_payload = {
            "holder_count": len(holders),
            "circulating_copies": total_copies,
            "top_holders": holders[:8],
            "holders": holders,
            "creator_excluded": False,
        }
        owners_payload = enrich_owner_stats(owners_payload, activity_rows)

        rarity_q = "1%20of%201" if label == "1:1" else label
        series_item: dict = {
            # Unique across volumes (UI getItemKey + sort)
            "token_id": f"rank-v{volume}-{rank}",
            "token_rank": rank,
            "name": display,
            "display_name": display,
            "local_slug": f"agency-v{volume}-rarity-{slug_key}",
            "description": description,
            "excerpt": excerpt,
            "image_url": rep.get("image_url"),
            "opensea_image_url": rep.get("opensea_image_url")
            or (
                rep.get("image_url")
                if str(rep.get("image_url") or "").startswith("http")
                else None
            ),
            "media_type": rep.get("media_type") or "image",
            "opensea_url": (
                f"https://opensea.io/collection/{opensea_slug}"
                f"?search[stringTraits][0][name]=Rarity"
                f"&search[stringTraits][0][values][0]={rarity_q}"
            ),
            "traits": [{"trait_type": "Rarity", "value": label}],
            "rarity": label,
            "volume": volume,
            "volume_label": volume_label,
            "opensea_slug": opensea_slug,
            "listed": any_listed,
            "listing": best_listing,
            "owners": owners_payload,
            "recent_activity": activity_rows,
            "collection_id": COLLECTION_ID,
            "is_series_rep": True,
            "agency_rarity_series": True,
            "case_file_count": file_count,
            "case_files": case_files,
            "member_token_ids": [m.get("token_id") for m in members_sorted],
        }
        if tier_minted_at:
            series_item["minted_at"] = tier_minted_at
        series.append(series_item)

    # Mark editions so the UI can hide them from the light browse grid
    for it in edition_items:
        it["is_edition_token"] = True
        it["agency_rarity_series"] = False
        it["volume"] = it.get("volume") or volume
        it["volume_label"] = it.get("volume_label") or volume_label
        it["opensea_slug"] = it.get("opensea_slug") or opensea_slug
        r = it.get("rarity")
        if r in RARITY_TO_RANK:
            it["token_rank"] = RARITY_TO_RANK[r]  # wallet can still show rarity tier
        # Keep display titles on the {Rarity} Case File #NN · Vol N pattern
        it["name"] = format_edition_title(
            r, str(it.get("token_id") or ""), volume_label=volume_label
        )
        it["display_name"] = it["name"]

    return series


def slim_item(item: dict) -> dict:
    # Keep activity + rarity + series flags in catalog (small collection)
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
        "token_rank": item.get("token_rank"),
        "volume": item.get("volume"),
        "volume_label": item.get("volume_label"),
        "opensea_slug": item.get("opensea_slug"),
        "is_series_rep": bool(item.get("is_series_rep")),
        "agency_rarity_series": bool(item.get("agency_rarity_series")),
        "is_edition_token": bool(item.get("is_edition_token")),
    }
    if item.get("case_file_count") is not None:
        out["case_file_count"] = item.get("case_file_count")
    if item.get("case_files"):
        out["case_files"] = item.get("case_files")
    if item.get("member_token_ids"):
        out["member_token_ids"] = item.get("member_token_ids")
    # Series need description in catalog for first paint of detail drawer
    if item.get("agency_rarity_series") and item.get("description"):
        out["description"] = item.get("description")
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


def resolve_volumes(reg: dict, volume_filter: int | None) -> list[dict]:
    """Volume descriptors from registry ``volumes`` or DEFAULT_VOLUMES."""
    raw = reg.get("volumes") if reg else None
    if not raw:
        raw = DEFAULT_VOLUMES
    out: list[dict] = []
    for v in raw:
        if not isinstance(v, dict):
            continue
        try:
            num = int(v.get("volume") or 0)
        except (TypeError, ValueError):
            continue
        if num < 1:
            continue
        if volume_filter is not None and num != volume_filter:
            continue
        slug = (v.get("opensea_slug") or v.get("slug") or "").strip()
        contract = (v.get("contract") or "").strip().lower()
        if not slug or not contract:
            print(f"  Skip volume {num}: missing slug or contract")
            continue
        out.append(
            {
                "volume": num,
                "opensea_slug": slug,
                "contract": contract,
                "chain": (v.get("chain") or reg.get("chain") or "ethereum"),
                "image_url": v.get("image_url"),
            }
        )
    out.sort(key=lambda x: x["volume"])
    return out


def fetch_one_volume(
    api_key: str,
    vol: dict,
    *,
    quick: bool,
    max_items: int,
) -> tuple[list[dict], list[dict], dict]:
    """Fetch one OpenSea volume → (series_rows, edition_items, volume_meta)."""
    global VOLUME, VOLUME_LABEL, VOLUME_OPENSEA_SLUG
    volume = int(vol["volume"])
    volume_label = f"Vol {volume}"
    slug = vol["opensea_slug"]
    chain = vol.get("chain") or "ethereum"
    contract = vol["contract"]
    VOLUME = volume
    VOLUME_LABEL = volume_label
    VOLUME_OPENSEA_SLUG = slug

    client = OpenSeaClient(
        api_key,
        chain=chain,
        contract=contract,
        collection_slug=slug,
    )

    print(f"\n=== Volume {volume} — {chain} / {slug} / {contract[:12]}… ===")
    contract_meta = client.get_contract() or {}
    print(f"  Contract name: {contract_meta.get('name')}")

    print("  Fetching collection stats...")
    stats_raw = client.get_collection_stats() or {}
    total = stats_raw.get("total") or {}

    print("  Fetching NFT metadata...")
    nfts = client.iter_collection_nfts()
    nfts.sort(key=lambda n: int(n.get("identifier", 0) or 0), reverse=True)
    if max_items > 0:
        nfts = nfts[:max_items]
    print(f"  {len(nfts)} NFTs")

    mint_dates: dict[str, str] = {}
    activity_by_token: dict[str, list[dict]] = {}
    if not quick:
        try:
            mint_dates, activity_by_token = process_collection_events(client)
        except Exception as exc:
            print(f"  Warning: collection events failed ({exc})")

    listings_by_token: dict[str, dict] = {}
    if not quick:
        print("  Fetching active listings…")
        try:
            listings_by_token = build_active_listings_map(client)
            print(f"  {len(listings_by_token)} listed")
        except Exception as exc:
            print(f"  Warning: listings failed ({exc})")

    items: list[dict] = []
    listed_count = 0
    rarity_counts: dict[str, int] = {}
    for i, nft in enumerate(nfts, 1):
        token_id = str(nft.get("identifier"))
        print(f"  [{i}/{len(nfts)}] V{volume} token #{token_id}", end="", flush=True)
        listing = None
        owners = None
        if not quick:
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
        item["contract"] = contract
        if item["listed"]:
            listed_count += 1
        r = item.get("rarity") or "Unknown"
        rarity_counts[r] = rarity_counts.get(r, 0) + 1
        items.append(item)
        print(f" ✓ [{r}]")

    series = build_rarity_series(
        items,
        volume=volume,
        volume_label=volume_label,
        opensea_slug=slug,
    )
    meta = {
        "volume": volume,
        "volume_label": volume_label,
        "slug": slug,
        "contract": contract,
        "chain": chain,
        "contract_name": contract_meta.get("name"),
        "floor_eth": total.get("floor_price"),
        "floor_symbol": total.get("floor_price_symbol", "ETH"),
        "total_sales": total.get("sales"),
        "total_volume": total.get("volume"),
        "case_file_count": len(items),
        "piece_count": len(series),
        "listed_count": sum(1 for s in series if s.get("listed")) or listed_count,
        "rarity_counts": rarity_counts,
        "image_url": vol.get("image_url")
        or (
            items[0].get("image_url")
            if items
            else None
        ),
        "opensea_url": f"https://opensea.io/collection/{slug}",
    }
    print(
        f"  Volume {volume} done: {len(series)} tiers + {len(items)} case files "
        f"({listed_count} edition listings)"
    )
    return series, items, meta


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch daGATO Detective Agency (all volumes) → dagato_agency_data.json"
    )
    parser.add_argument(
        "--quick", action="store_true", help="Skip listings/owners/events"
    )
    parser.add_argument("--max-items", type=int, default=0, help="Limit per volume (0=all)")
    parser.add_argument(
        "--volume",
        type=int,
        default=0,
        help="Fetch only this volume (0 = all volumes in registry).",
    )
    parser.add_argument(
        "--create-key",
        action="store_true",
        help="Create OpenSea instant API key if missing (local only)",
    )
    args = parser.parse_args()

    reg = get_collection(COLLECTION_ID)
    if not reg:
        raise RuntimeError(f"Collection '{COLLECTION_ID}' missing from registry")

    volume_filter = int(args.volume) if args.volume and int(args.volume) > 0 else None
    volumes = resolve_volumes(reg, volume_filter)
    if not volumes:
        raise RuntimeError("No daGATO Agency volumes configured (registry volumes / DEFAULT_VOLUMES)")

    api_key = load_api_key(create_if_missing=args.create_key)

    creator_wallet = None
    try:
        probe = OpenSeaClient(
            api_key,
            chain=volumes[0].get("chain") or "ethereum",
            contract=volumes[0]["contract"],
            collection_slug=volumes[0]["opensea_slug"],
        )
        resolved = probe.resolve_account(CREATOR_ENS)
        if resolved.get("address"):
            creator_wallet = resolved
    except Exception:
        creator_wallet = {"address": CREATOR_ADDRESS, "ens_name": CREATOR_ENS}

    all_series: list[dict] = []
    all_editions: list[dict] = []
    volume_metas: list[dict] = []
    rarity_counts: dict[str, int] = {}
    floors: list[float] = []
    total_sales = 0
    total_volume_eth = 0.0

    for vol in volumes:
        series, editions, meta = fetch_one_volume(
            api_key,
            vol,
            quick=args.quick,
            max_items=args.max_items,
        )
        all_series.extend(series)
        all_editions.extend(editions)
        volume_metas.append(meta)
        for k, n in (meta.get("rarity_counts") or {}).items():
            rarity_counts[k] = rarity_counts.get(k, 0) + int(n or 0)
        fe = meta.get("floor_eth")
        if fe is not None:
            try:
                floors.append(float(fe))
            except (TypeError, ValueError):
                pass
        try:
            total_sales += int(meta.get("total_sales") or 0)
        except (TypeError, ValueError):
            pass
        try:
            total_volume_eth += float(meta.get("total_volume") or 0)
        except (TypeError, ValueError):
            pass

    # Unique holders across all volumes' edition case files
    all_holders: set[str] = set()
    for it in all_editions:
        for h in (it.get("owners") or {}).get("holders") or []:
            a = (h.get("address") or "").lower()
            if a:
                all_holders.add(a)

    # Stable browse order: Vol 1…N, each rarity rank 1→5
    all_series.sort(
        key=lambda s: (int(s.get("volume") or 0), int(s.get("token_rank") or 99))
    )
    combined = all_series + all_editions
    series_listed = sum(1 for s in all_series if s.get("listed"))
    primary = volume_metas[0] if volume_metas else {}
    vol_nums = [m["volume"] for m in volume_metas]
    if len(vol_nums) == 1:
        name = f"daGATO Detective Agency: Volume {vol_nums[0]}"
        note = (
            f"Limited cyber-noir detective case files on Ethereum (Volume {vol_nums[0]}). "
            "Stewarded by dagato.eth. All holders counted. "
            "Browse shows 5 rarity tiers per volume; collector wallets show each case file."
        )
    else:
        name = "daGATO Detective Agency"
        note = (
            f"Limited cyber-noir detective case files on Ethereum (Volumes "
            f"{', '.join(str(v) for v in vol_nums)}). "
            "Stewarded by dagato.eth. All holders counted. "
            "Browse shows 5 rarity tiers per volume; collector wallets show each case file."
        )

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "opensea_api_v2",
        "collection": {
            "id": COLLECTION_ID,
            "slug": primary.get("slug") or "dagato-detective-agency-volume-1",
            "name": name,
            "display_name": name,
            "contract": primary.get("contract"),
            "chain": primary.get("chain") or "ethereum",
            "opensea_url": primary.get("opensea_url")
            or "https://opensea.io/collection/dagato-detective-agency-volume-1",
            "note": note,
            "creator_ens": CREATOR_ENS,
            "creator_wallet": creator_wallet
            or {"address": CREATOR_ADDRESS, "ens_name": CREATOR_ENS},
            "creator_excluded_from_stats": False,
            "contract_name": primary.get("contract_name"),
            "floor_eth": min(floors) if floors else primary.get("floor_eth"),
            "floor_symbol": primary.get("floor_symbol") or "ETH",
            "num_owners": len(all_holders),
            "total_sales": total_sales or None,
            "total_volume": total_volume_eth or None,
            # Browse "Pieces" = rarity series across all volumes (5 × N)
            "piece_count": len(all_series),
            "edition_count": len(all_editions),
            "case_file_count": len(all_editions),
            "listed_count": series_listed,
            "rarity_counts": rarity_counts,
            "volume_count": len(volume_metas),
            "volumes": volume_metas,
            "image_url": primary.get("image_url")
            or (
                "https://i2c.seadn.io/collection/dagato-detective-agency-volume-1/"
                "image_type_logo/6dcbf6a0f830a10ef45731c2e11f2b/"
                "e96dcbf6a0f830a10ef45731c2e11f2b.png"
            ),
        },
        "items": combined,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(
        f"\nWrote {OUTPUT_PATH} — {len(all_series)} rarity tiers + "
        f"{len(all_editions)} case files across {len(volume_metas)} volume(s), "
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
