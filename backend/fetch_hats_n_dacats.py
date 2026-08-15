"""
Fetch HATS n' daCATs from OpenSea (Ethereum) → web/data/hats_n_dacats_data.json.

True 1:1s on a single Ethereum collection (wave releases up to max supply 333).
Each daily run re-lists every NFT currently on the collection slug — new mints
in later batches appear automatically without code changes.

Display names: exact OpenSea title (e.g. "#020 - Cosmic Commander Helmet").
No steward exclusion — every holder counts.

Usage (from backend/):
  python fetch_hats_n_dacats.py
  python fetch_hats_n_dacats.py --create-key
  python fetch_hats_n_dacats.py --quick
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
OUTPUT_PATH = ROOT / "web" / "data" / "hats_n_dacats_data.json"
CATALOG_PATH = ROOT / "web" / "data" / "hats_n_dacats_catalog.json"

COLLECTION_ID = "hats-n-dacats"
CREATOR_ENS = "hatsndacats.eth"
# Project / mint wallet — excluded from holder stats until a collector receives the piece
# (same pattern as BIG KIX steward). NFTs still appear in browse with empty community owners.
CREATOR_ADDRESS = "0xd23ace74f9749eb5040311e5d8654bce88d0cfb8"

MAX_SUPPLY = 333
# Match Agency-quality history; 1:1s stay small (≤333) so a deeper trail is fine
MAX_ACTIVITY_PER_TOKEN = 40

OFFICIAL_SUMMARY = (
    "HATS n' daCATs is a collection of 333 unique daCATs, each defined by a "
    "legendary hat from across the daCAT universe. Every NFT is individually "
    "named and numbered, allowing collectors to choose the legend they connect "
    "with most. There are no rarity tiers—every hat stands on its own. "
    "Every hat has a story. Legends Wear Hats."
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
    """Parse listing price as per-unit ETH (ERC-721 1:1 → qty 1)."""
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


_EMPTY_TRAIT_VALUES = frozenset({"", "none", "n/a", "null", "-", "—", "–"})


def is_empty_trait_value(val: object) -> bool:
    if val is None:
        return True
    return str(val).strip().lower() in _EMPTY_TRAIT_VALUES


def normalize_traits(raw: list | None) -> list[dict]:
    """Stable trait rows for UI + search. Drop None / N/A placeholders."""
    out: list[dict] = []
    for t in raw or []:
        if not isinstance(t, dict):
            continue
        tt = str(t.get("trait_type") or t.get("traitType") or "").strip()
        val = t.get("value")
        if is_empty_trait_value(val):
            continue
        sv = str(val).strip()
        if not tt and not sv:
            continue
        row: dict = {"trait_type": tt or "Trait", "value": sv}
        if t.get("display_type"):
            row["display_type"] = t["display_type"]
        if t.get("max_value") is not None:
            row["max_value"] = t["max_value"]
        out.append(row)
    return out


def format_traits_blurb(traits: list[dict], *, max_pairs: int = 6) -> str:
    """Short trait line for description enrichment (not a rarity invent)."""
    parts: list[str] = []
    # Prefer wave / hat / theme first in the blurb
    preferred = ("Production", "Headwear Type", "Theme")
    by_type = {
        str(t.get("trait_type") or "").strip(): t for t in (traits or []) if t
    }
    ordered: list[dict] = []
    for p in preferred:
        if p in by_type:
            ordered.append(by_type[p])
    for t in traits or []:
        tt = str(t.get("trait_type") or "").strip()
        if tt in preferred:
            continue
        ordered.append(t)
    for t in ordered:
        if len(parts) >= max_pairs:
            break
        tt = (t.get("trait_type") or "").strip()
        tv = str(t.get("value") or "").strip()
        if is_empty_trait_value(tv):
            continue
        # Skip noisy pure ids
        if re.search(r"(_id|id)$", tt, re.I) and re.fullmatch(r"\d+", tv):
            continue
        if tt:
            parts.append(f"{tt}: {tv}")
        else:
            parts.append(tv)
    return " · ".join(parts)


def enrich_description(description: str, traits: list[dict], title: str) -> str:
    """Keep OpenSea lore; append a compact trait line when it adds signal."""
    desc = clean_description(description)
    blurb = format_traits_blurb(traits)
    if not blurb:
        return desc
    # Avoid duplicating if traits already appear in the body
    if blurb.lower() in desc.lower():
        return desc
    if not desc or desc.strip().lower() == title.strip().lower():
        return blurb if not desc else f"{desc}\n\n{blurb}"
    return f"{desc}\n\nTraits — {blurb}"


def excerpt(text: str, max_len: int = 160) -> str:
    if not text:
        return ""
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").split("\n") if ln.strip()]
    # Drop a pure title line if present
    if lines and re.match(r"^#\s*\d+\s*[-–—]", lines[0]):
        if len(lines) > 1:
            lines = lines[1:]
    body = " ".join(lines).strip() if lines else re.sub(r"\s+", " ", text).strip()
    flat = re.sub(r"\s+", " ", body).strip()
    if len(flat) <= max_len:
        return flat
    return flat[: max_len - 1].rstrip() + "…"


def _trait_value(traits: list[dict] | None, *names: str) -> str | None:
    want = {n.lower() for n in names}
    for t in traits or []:
        tt = str(t.get("trait_type") or "").strip().lower()
        if tt in want:
            val = str(t.get("value") or "").strip()
            if val and val.lower() not in ("none", "n/a", "null", "-"):
                return val
    return None


def normalize_display_title(
    raw_name: str | None,
    token_id: str,
    traits: list[dict] | None = None,
) -> tuple[str, str | None]:
    """Canonical display: ``#NNN - Name`` (series number always first).

    OpenSea sometimes stores mid-batch titles as ``HATS n' daCATs #015`` (number
    at the end). We keep the original as ``opensea_name`` and show number-first.
    Prefer trait ``Gear Name`` / ``Headwear Type`` when the raw title is only
    the collection name + number.
    """
    raw = (raw_name or "").strip()
    traits = traits or []

    def _fmt(num: str, rest: str) -> str:
        try:
            n = str(int(num)).zfill(3)
        except ValueError:
            n = num.zfill(3) if num.isdigit() else num
        rest = re.sub(r"\s+", " ", (rest or "").strip())
        return f"#{n} - {rest}" if rest else f"#{n}"

    # Already number-first: "#020 - Cosmic Commander Helmet"
    m = re.match(r"^#\s*(\d+)\s*[-–—:]\s*(.+)$", raw)
    if m:
        display = _fmt(m.group(1), m.group(2))
        return display, raw if raw != display else None

    # Number at end: "HATS n' daCATs #015" or "Something Cool #7"
    m2 = re.match(r"^(.+?)\s*#\s*(\d+)\s*$", raw)
    if m2:
        prefix = m2.group(1).strip()
        num = m2.group(2)
        gear = _trait_value(traits, "Gear Name", "Hat", "Name", "Title")
        head = _trait_value(traits, "Headwear Type")
        if gear:
            rest = gear
        elif prefix and not re.match(r"^hats\s*n['’]?\s*dacats$", prefix, re.I):
            rest = prefix
        elif head:
            rest = head
        else:
            rest = prefix if prefix else ""
        display = _fmt(num, rest)
        return display, raw if raw != display else None

    # Bare "#15" / "15"
    m3 = re.match(r"^#?\s*(\d+)\s*$", raw)
    if m3:
        gear = _trait_value(traits, "Gear Name", "Hat", "Name", "Title")
        head = _trait_value(traits, "Headwear Type")
        display = _fmt(m3.group(1), gear or head or "")
        return display, raw if raw != display else None

    # Fallback: no parseable number — still surface token id first
    try:
        num = str(int(token_id)).zfill(3)
    except ValueError:
        num = str(token_id)
    display = _fmt(num, raw) if raw else f"#{num}"
    return display, raw if raw and raw != display else None


def slug_from_title(name: str, token_id: str) -> str:
    """Stable local_slug for share URLs — not used as display name."""
    raw = (name or "").strip()
    m = re.match(r"#\s*(\d+)\s*[-–—]\s*(.+)$", raw)
    if m:
        num = m.group(1).zfill(3)
        rest = re.sub(r"[^a-z0-9]+", "-", m.group(2).lower()).strip("-")
        return f"hat-{num}-{rest}" if rest else f"hat-{num}"
    m2 = re.match(r"^(.+?)\s*#\s*(\d+)\s*$", raw)
    if m2:
        num = m2.group(2).zfill(3)
        rest = re.sub(r"[^a-z0-9]+", "-", m2.group(1).lower()).strip("-")
        return f"hat-{num}-{rest}" if rest else f"hat-{num}"
    try:
        num = str(int(token_id)).zfill(3)
    except ValueError:
        num = str(token_id)
    slug_body = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")
    return f"hat-{num}-{slug_body}" if slug_body else f"hat-{num}"


def summarize_owners(
    owners: list[dict] | None,
    *,
    exclude_addresses: set[str] | None = None,
) -> dict | None:
    """Community holders only — project mint wallet omitted until a transfer/sale out."""
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
        price_eth = None
        payment = event.get("payment") or {}
        if payment.get("quantity") is not None:
            try:
                decimals = int(payment.get("decimals") or 18)
                price_eth = int(payment["quantity"]) / (10**decimals)
            except (TypeError, ValueError):
                price_eth = None
        return {
            "type": "sale",
            "at": at,
            "from": event.get("seller") or event.get("from_address"),
            "to": event.get("buyer") or event.get("to_address"),
            "quantity": qty,
            "price_eth": price_eth,
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
    max_activity_per_token: int = MAX_ACTIVITY_PER_TOKEN,
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
    contract: str,
    exclude_creator: set[str] | None = None,
) -> dict:
    token_id = str(nft.get("identifier", ""))
    raw_name = (nft.get("name") or "").strip()
    if not raw_name:
        raw_name = f"#{token_id}"

    traits = normalize_traits(nft.get("traits") or [])
    # Number-first display (#NNN - Name). Preserve raw OpenSea string when reformatted.
    display_name, opensea_name = normalize_display_title(raw_name, token_id, traits)
    description = enrich_description(
        clean_description(nft.get("description")), traits, display_name
    )
    listing_info = parse_listing_price(listing) if listing else None
    owner_stats = summarize_owners(owners, exclude_addresses=exclude_creator)
    owner_stats = enrich_owner_stats(owner_stats, recent_activity)

    image_url = nft.get("display_image_url") or nft.get("image_url") or ""
    media_type = (
        "video" if re.search(r"\.(mov|mp4|webm)(\?|$)", image_url, re.I) else "image"
    )
    slug = slug_from_title(display_name, token_id)

    item = {
        "token_id": token_id,
        "name": display_name,
        "display_name": display_name,
        "local_slug": slug,
        "description": description,
        "excerpt": excerpt(description) if description else display_name,
        "image_url": image_url,
        "opensea_image_url": image_url if str(image_url).startswith("http") else None,
        "media_type": media_type,
        "opensea_url": nft.get("opensea_url"),
        "metadata_url": nft.get("metadata_url"),
        "updated_at": nft.get("updated_at"),
        "traits": traits,
        "listed": listing_info is not None,
        "listing": listing_info,
        "owners": owner_stats,
        "collection_id": COLLECTION_ID,
        "contract": contract,
        "chain": "ethereum",
        # True 1:1 — no editions, no rarity tiers
        "is_1_of_1": True,
        "edition_size": 1,
        "max_supply": MAX_SUPPLY,
    }
    if opensea_name:
        item["opensea_name"] = opensea_name
    # Mint date drives default "Newest" sort. Prefer OpenSea events; if missing,
    # use NFT updated_at so Batch 01 still floats above older archive pieces.
    if minted_at:
        item["minted_at"] = minted_at
    else:
        upd = nft.get("updated_at")
        if upd:
            try:
                # OpenSea may return ISO or unix
                if isinstance(upd, (int, float)):
                    item["minted_at"] = datetime.fromtimestamp(
                        int(upd), tz=timezone.utc
                    ).isoformat()
                else:
                    item["minted_at"] = str(upd)
            except (TypeError, ValueError, OSError):
                pass
    if recent_activity:
        item["recent_activity"] = recent_activity
    return item


def slim_item(item: dict) -> dict:
    """Catalog keeps activity + traits so first paint / filters work without full JSON."""
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
        "contract": item.get("contract"),
        "traits": item.get("traits") or [],
        "is_1_of_1": True,
        "edition_size": 1,
    }
    activity = item.get("recent_activity") or []
    if activity:
        out["recent_activity"] = activity[:12]
    return out


def write_catalog(payload: dict) -> None:
    items = [slim_item(it) for it in payload.get("items") or []]
    catalog = {
        "generated_at": payload.get("generated_at"),
        "source": "hats_n_dacats_catalog",
        "collection": payload.get("collection"),
        "items": items,
    }
    CATALOG_PATH.write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Wrote {CATALOG_PATH} ({len(items)} items)")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch HATS n' daCATs → hats_n_dacats_data.json"
    )
    parser.add_argument("--quick", action="store_true", help="Skip listings/owners/events")
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

    slug = reg.get("opensea_slug") or "hats-n-dacats"
    chain = reg.get("chain") or "ethereum"
    contract = (reg.get("contract") or "").lower()
    if not contract:
        raise RuntimeError("HATS n' daCATs contract missing from registry")

    api_key = load_api_key(create_if_missing=args.create_key)
    client = OpenSeaClient(
        api_key,
        chain=chain,
        contract=contract,
        collection_slug=slug,
    )

    print(f"HATS n' daCATs — {chain} / {slug} / {contract[:10]}…")
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

    exclude = {CREATOR_ADDRESS.lower()}
    if creator_wallet and creator_wallet.get("address"):
        exclude.add(str(creator_wallet["address"]).lower())

    print("Fetching NFT metadata (all minted pieces — future waves auto-included)...")
    nfts = client.iter_collection_nfts()
    # Prefer higher token numbers first (newest waves), then numeric order for stability
    nfts.sort(key=lambda n: int(n.get("identifier", 0) or 0), reverse=True)
    if args.max_items > 0:
        nfts = nfts[: args.max_items]
    print(f"  {len(nfts)} NFTs (max supply {MAX_SUPPLY})")

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
            contract=contract,
            exclude_creator=exclude,
        )
        if item["listed"]:
            listed_count += 1
        items.append(item)
        print(" ✓")

    community_holders: set[str] = set()
    for it in items:
        for h in (it.get("owners") or {}).get("holders") or []:
            a = (h.get("address") or "").lower()
            if a and a not in exclude:
                community_holders.add(a)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "opensea_api_v2",
        "collection": {
            "id": COLLECTION_ID,
            "slug": slug,
            "name": "HATS n' daCATs",
            "display_name": "HATS n' daCATs",
            "contract": contract,
            "chain": chain,
            "opensea_url": f"https://opensea.io/collection/{slug}",
            "note": (
                f"True 1:1 hats on Ethereum. Max supply {MAX_SUPPLY}; "
                f"released in waves (currently {len(items)} minted). "
                "No rarity tiers — every hat stands on its own. "
                "Stewarded by hatsndacats.eth. Project mint wallet excluded "
                "from holder counts until a collector receives the piece."
            ),
            "description": OFFICIAL_SUMMARY,
            "max_supply": MAX_SUPPLY,
            "batch_label": "Batch 01" if len(items) <= 33 else None,
            "creator_ens": CREATOR_ENS,
            "creator_wallet": creator_wallet
            or {"address": CREATOR_ADDRESS, "ens_name": CREATOR_ENS},
            "creator_excluded_from_stats": True,
            "contract_name": contract_meta.get("name"),
            "floor_eth": total.get("floor_price"),
            "floor_symbol": total.get("floor_price_symbol", "ETH"),
            "num_owners": len(community_holders),
            "total_sales": total.get("sales"),
            "total_volume": total.get("volume"),
            "piece_count": len(items),
            "listed_count": listed_count,
            "one_of_ones": len(items),
        },
        "items": items,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"\nWrote {OUTPUT_PATH} — {len(items)} pieces, {listed_count} listed")
    write_catalog(payload)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)
    except Exception as e:
        print(f"HATS n' daCATs fetch failed: {e}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        sys.exit(1)
