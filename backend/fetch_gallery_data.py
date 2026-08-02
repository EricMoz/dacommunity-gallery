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
import time
import traceback
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
    """Load key from env (CI) or backend/.env. Auto-create only when create_if_missing=True (--create-key)."""
    load_dotenv(ENV_PATH)
    key = os.getenv("OPENSEA_API_KEY", "").strip()
    if key:
        return key
    if not create_if_missing:
        if os.getenv("GITHUB_ACTIONS"):
            raise ValueError(
                "OPENSEA_API_KEY not available. The workflow attempts to auto-generate a fresh "
                "temporary key each run via the public OpenSea /auth/keys endpoint. "
                "If this fails, ensure a fallback repository secret OPENSEA_API_KEY exists. "
                "See recent Actions run for the generate-key step logs."
            )
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


def token_id_from_listing(listing: dict) -> str | None:
    """Extract ERC-1155 token id from a best-listing payload."""
    asset = listing.get("asset") or {}
    if asset.get("identifier") is not None:
        return str(asset["identifier"])
    params = (listing.get("protocol_data") or {}).get("parameters") or {}
    offer = params.get("offer") or []
    if offer and offer[0].get("identifierOrCriteria") is not None:
        return str(offer[0]["identifierOrCriteria"])
    return None


def build_active_listings_map(client: OpenSeaClient) -> dict[str, dict]:
    """Token id → raw ACTIVE listing from collection /best (all current listings)."""
    out: dict[str, dict] = {}
    for row in client.iter_collection_best_listings():
        if (row.get("status") or "").upper() != "ACTIVE":
            continue
        token_id = token_id_from_listing(row)
        if token_id:
            out[token_id] = row
    return out


def parse_listing_price(listing: dict) -> dict | None:
    """Parse listing price as **per-unit** ETH (ERC-1155 batch totals ÷ quantity)."""
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
    flat = re.sub(r"\s+", " ", text).strip()
    if len(flat) <= max_len:
        return flat
    return flat[: max_len - 1].rstrip() + "…"


def summarize_owners(owners: list[dict]) -> dict:
    sorted_owners = sorted(
        owners, key=lambda x: int(x.get("quantity", 0)), reverse=True
    )
    total_copies = sum(int(o.get("quantity", 0)) for o in sorted_owners)
    holder_rows = [
        {
            "address": o.get("address"),
            "quantity": int(o.get("quantity", 0)),
        }
        for o in sorted_owners
        if o.get("address")
    ]
    return {
        "holder_count": len(holder_rows),
        "circulating_copies": total_copies,
        "top_holders": holder_rows[:5],
        "holders": holder_rows,
    }


from owner_stats import dedupe_activity_rows, enrich_owner_stats


ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


def parse_activity_event(event: dict) -> dict | None:
    """Normalize mint / transfer / sale into a compact activity row."""
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
            from_addr = None
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
    """One pass: earliest mint per token + recent activity (incl. transfers)."""
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
            if transfer_type not in ("mint", "create") and from_addr not in (
                ZERO_ADDRESS,
                "",
            ):
                pass
            else:
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

    print(f"  Activity rows for {len(trimmed)} tokens")
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
    owner_stats = summarize_owners(owners) if owners is not None else None
    owner_stats = enrich_owner_stats(owner_stats, recent_activity)

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
    if minted_at:
        item["minted_at"] = minted_at
    if recent_activity:
        item["recent_activity"] = recent_activity
    if raw_name != display:
        item["opensea_name"] = raw_name
    return item


def build_holders_index(
    client: OpenSeaClient,
    items_by_id: dict[str, dict],
    *,
    resolve_ens: bool = True,
    holdings_by_addr: dict | None = None,
) -> dict:
    """Build wallet → holdings map for gallery lookup panel.

    Preserves historical ENS names per wallet address so old names continue to resolve
    after changes. Historical names are kept in ens_aliases and ens_history per address.
    If holdings_by_addr provided, use it to avoid per-holder get_account_collection_nfts calls.

    ENS resolution (new):
    - Uses client.resolve_ens_name() which prefers the free ensdata.net API first
      (https://ensdata.net/{addr} -> ens_primary or ens), then falls back to
      the existing client.resolve_account().
    - Caches via last_ens_resolved (unix seconds) stored per wallet entry.
      Only resolves addresses that are new OR last resolved > ~14 days ago.
      This keeps the daily pipeline fast/lightweight (target: minimal added time).
    - ALWAYS stores/returns ENS in lowercase. This permanently fixes the
      daforeman.eth / DAFOREMAN.ETH (and similar) issue. Normalization happens
      on every actual resolution; a one-time pass also lowercases prior entries.
    - History/aliases logic below is kept EXACTLY as before.
    """
    print("Building wallet lookup index from collection holders...")
    holders = client.iter_collection_holders()
    index: dict[str, dict] = {}
    ens_aliases: dict[str, str] = {}

    # Load previous to preserve past ENS names (keyed by wallet address)
    previous_by: dict[str, dict] = {}
    try:
        if WALLET_INDEX_PATH.exists():
            prev = json.loads(WALLET_INDEX_PATH.read_text(encoding="utf-8"))
            prev_hi = prev.get("holders_index", {})
            previous_by = {k.lower(): v for k, v in prev_hi.get("by_address", {}).items()}
    except Exception:
        previous_by = {}

    # One-time normalization pass: ensure any pre-existing ENS (including old ALL-CAPS)
    # are lowercased in memory before we build. This + new resolver guarantees
    # lowercase forever in wallet_index.json, aliases, and ens_history.
    for p in previous_by.values():
        if p.get("ens_name"):
            p["ens_name"] = str(p["ens_name"]).lower()
        if p.get("ens_history"):
            p["ens_history"] = [str(h).lower() for h in (p.get("ens_history") or []) if h]

    for i, holder in enumerate(holders, 1):
        address = holder.get("address", "").lower()
        if not address:
            continue
        print(f"  [holder {i}/{len(holders)}] {address[:10]}…", flush=True)

        ens_name = None
        username = None
        last_res_ts = None
        resolved_at = None
        if resolve_ens:
            p = previous_by.get(address, {})
            last_res_ts = p.get("last_ens_resolved")
            prev_ens = p.get("ens_name")
            prev_username = p.get("username")

            # Shared resolver: ensdata.net primary + OpenSea ENS fallback + 14d cache + lowercase.
            # Skip network if recently resolved; returns prev_ens on skip/failure.
            ens_name = client.resolve_ens_name(
                holder.get("address"),
                last_resolved=last_res_ts,
                cache_days=14,
                previous_ens=prev_ens,
            )

            # Fresh OpenSea account call only when cache expired — picks up username
            # (OpenSea profile) and any ENS ensdata missed. Display priority is applied
            # on the frontend: ens_name → username → short 0x.
            do_fresh_resolve = not last_res_ts or (time.time() - last_res_ts) >= (14 * 86400)
            if do_fresh_resolve:
                try:
                    resolved = client.resolve_account(holder["address"])
                    if not ens_name:
                        ens_name = resolved.get("ens_name")
                        if ens_name:
                            ens_name = str(ens_name).lower()
                    u = resolved.get("username") or resolved.get("display_name")
                    if u:
                        username = str(u).strip()
                except requests.HTTPError:
                    pass
                # Keep prior username if OpenSea returned nothing this run
                if not username and prev_username:
                    username = prev_username
                resolved_at = time.time()
            else:
                # Cache hit: never wipe prior OpenSea username
                username = prev_username
                resolved_at = last_res_ts

        # Use prebuilt holdings (from per-NFT owners data) instead of per-holder API call.
        # Same result, far fewer API requests.
        hmap = holdings_by_addr or {}
        holdings = hmap.get(address, [])
        holdings.sort(key=lambda h: int(h["token_id"]), reverse=True)

        entry = {
            "address": holder["address"],
            "ens_name": ens_name,
            "username": username,
            "collection_quantity": int(holder.get("quantity", 0)),
            "ownership_pct": holder.get("percentage"),
            "holdings": holdings,
            "unique_pieces": len(holdings),
            "last_ens_resolved": resolved_at,
        }

        # Preserve past ENS names (keyed by wallet address)
        # >>> THIS BLOCK IS UNCHANGED from original (exact history + aliases logic preserved) <<<
        if address in previous_by:
            p = previous_by[address]
            p_ens = p.get("ens_name")
            hist = list(p.get("ens_history") or [])
            if p_ens and p_ens != ens_name and p_ens not in hist:
                hist.append(p_ens)
            if hist:
                entry["ens_history"] = hist
            else:
                entry["ens_history"] = list(p.get("ens_history") or [])
            # ensure historical names remain resolvable
            for old in (entry.get("ens_history") or []):
                if old:
                    ens_aliases[old.lower()] = address
            if p_ens and p_ens != ens_name:
                ens_aliases[p_ens.lower()] = address

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

    mint_dates: dict[str, str] = {}
    activity_by_token: dict[str, list[dict]] = {}
    if not args.quick:
        try:
            mint_dates, activity_by_token = process_collection_events(client)
            print(f"  Mint dates for {len(mint_dates)} tokens")
        except Exception as exc:
            print(f"  Warning: could not load collection events ({exc})")

    items = []
    items_by_id: dict[str, dict] = {}
    listed_count = 0
    listings_by_token: dict[str, dict] = {}
    if not args.quick:
        print("Fetching active listings (collection best)…")
        try:
            listings_by_token = build_active_listings_map(client)
            print(f"  {len(listings_by_token)} pieces listed on OpenSea")
        except Exception as exc:
            print(f"  Warning: could not load collection listings ({exc})")

    # Pre-build holdings by address from owners we fetch anyway.
    # This avoids expensive per-holder get_account_collection_nfts calls later (major perf win).
    from collections import defaultdict
    holdings_by_addr: dict[str, list] = defaultdict(list)
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
        items.append(item)
        items_by_id[token_id] = item

        # Accumulate for holdings
        for h in (item.get("owners", {}) or {}).get("holders", []) or []:
            a = (h.get("address") or "").lower()
            if a:
                holdings_by_addr[a].append({
                    "token_id": token_id,
                    "name": item.get("display_name") or item.get("name"),
                    "image_url": item.get("image_url"),
                    "opensea_url": item.get("opensea_url"),
                })
        print(" ✓")

    holders_index = None
    if not args.quick and not args.skip_wallet_index:
        holders_index = build_holders_index(client, items_by_id, holdings_by_addr=holdings_by_addr)

    # Slim holdings in wallet index (no duplicate image URLs)
    if holders_index:
        slim = {"ens_aliases": holders_index.get("ens_aliases", {}), "by_address": {}}
        for addr, entry in holders_index.get("by_address", {}).items():
            slim["by_address"][addr] = {
                "address": entry["address"],
                "ens_name": entry.get("ens_name"),
                "ens_history": entry.get("ens_history") or [],
                "username": entry.get("username"),
                "collection_quantity": entry.get("collection_quantity"),
                "unique_pieces": entry.get("unique_pieces"),
                # Persist the last resolution timestamp so future runs can skip re-resolving this address
                # for the configured cache window (see resolve_ens_name + build_holders_index).
                "last_ens_resolved": entry.get("last_ens_resolved"),
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
    import enrich_gallery_json

    enrich_gallery_json.main()
    import build_catalog

    build_catalog.main()
    import gallery_meta

    gallery_meta.record_success(
        listed_count=listed_count,
        piece_count=len(items),
        source="github_actions" if os.getenv("GITHUB_ACTIONS") else "local",
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        hint = ""
        code = "fetch_failed"
        if status in (401, 403):
            code = "opensea_unauthorized"
            hint = (
                " Check the 'Generate fresh OpenSea API key' step in the Actions log. "
                "The workflow auto-generates a temporary key; fallback secret may be invalid."
            )
        try:
            import gallery_meta

            gallery_meta.record_failure(f"OpenSea HTTP {status}: {e}{hint}", error_code=code)
        except Exception:
            pass
        print(f"OpenSea HTTP {status}: {e}{hint}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        code = "missing_secret" if "OPENSEA_API_KEY" in str(e) else "fetch_failed"
        try:
            import gallery_meta

            gallery_meta.record_failure(str(e), error_code=code)
        except Exception:
            pass
        print(f"Error: {e}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        try:
            import gallery_meta

            gallery_meta.record_failure(str(e), error_code="fetch_failed")
        except Exception:
            pass
        print(f"Error: {e}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        sys.exit(1)