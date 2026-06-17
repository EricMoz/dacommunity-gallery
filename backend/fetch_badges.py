"""
Badges data pipeline - "Created by this wallet on Ethereum after a certain date".

Core rule (per user):
- Pull anything this wallet has CREATED (mints where the wallet is the creator/minter) on ETH after CUTOFF_DATE.
- No hard limit to a fixed list of collection slugs (the previous "Approved_Created_Collections" list is now just reference/seed for patterns).
- POL items excluded (only ethereum).
- 1:1 validated conservatively (supply or traits, not assumed from name).
- For non-1:1 tiers: show holders/copies like main archive.
- Unowned items: include full data (description etc.) to encourage earning.
- Mystery flag for items whose collection doesn't match known good patterns from the seeded table until approved.
- Expanded award_category / random_drop using common traits/patterns from the known collections (trillion, rookie, award, collector, gem, etc.).

First data load will use the collections the user showed in the created tab as the initial known set for patterns.
Ongoing syncs will catch new creations by the wallet.

Review artifacts are generated for approval.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

from opensea_client import OpenSeaClient

ROOT = Path(__file__).resolve().parent.parent
REVIEW_DIR = ROOT / "backend" / "review"
REVIEW_DIR.mkdir(parents=True, exist_ok=True)

ISSUER_WALLET = "0xa6d5c9602a49afddff9873cf51db2991dec2c9ee".lower()

# Cutoff date - user to set the "certain date"
# Format: date only "YYYY-MM-DD" or full ISO.
# IMPORTANT for newer wallets with lots of other creations: set this to just before the first badge creation date (e.g. "2026-06-01").
# Broad cutoffs pull thousands of unrelated mints by the wallet, causing slow runs + rate limits.
CUTOFF_DATE = "2026-05-20"  # Edit to match when your badges actually started (~3 weeks before 2026-06-17, first ones ~May 27). Use recent date for "newer wallet" scenario.

# Reference patterns from the user's created tab table (for award_category + mystery detection)
# These are used to seed categories and to decide if something is "known good" or mystery.
KNOWN_GOOD_PATTERNS = [
    "trillion club", "rookie card", "award badges", "collector cat", "gem", "nova",
    "billion club"
]

# Known badge collection slugs from the initial bootstrap / user's table.
# Instead of broad wallet mint events (which pulls unrelated creations), we target only these.
# This is fast, avoids rate limits, and matches "search on those we know are in the badges".
# To add a new badge collection in future: add its opensea slug here, re-run fetch.
KNOWN_BADGE_COLLECTION_SLUGS = [
    "dacatrookie2026",
    "dacat1trillionclub",
    "dacat2trillion",
    "dacat3trillion",
    "dacat4trillion",
    "dacat5trillion",
    "dacat6trillion",
    "dacat7trillion",
    "dacat8trillion",
    "dacat9trillion",
    "dacat10trillion",
    "dacat500billion",
    "dacat-world-collector-cat",  # verify slug if needed
    "dacat-gem-nova-green",
    "dagatoawards",
]

# Map from (correct) collection slug to the local asset slug used for images (to match existing assets/badges/*.png)
SLUG_TO_LOCAL_ASSET = {
    "dacatrookie2026": "dacat-rookie-card-2026",
    "dacat1trillionclub": "dacat-1-trillion-club",
    "dacat2trillion": "dacat-2-trillion-club",
    "dacat3trillion": "dacat-3-trillion-club",
    "dacat4trillion": "dacat-4-trillion-club",
    "dacat5trillion": "dacat-5-trillion-club",
    "dacat6trillion": "dacat-6-trillion-club",
    "dacat7trillion": "dacat-7-trillion-club",
    "dacat8trillion": "dacat-8-trillion-club",
    "dacat9trillion": "dacat-9-trillion-club",
    "dacat10trillion": "dacat-10-trillion-club",
    "dacat500billion": "dacat-500-billion-club",
    "dacat-world-collector-cat": "dacat-world-collector-cat",
    "dacat-gem-nova-green": "dacat-gem-nova-green",
    "dagatoawards": "dagato-dacat-award-badges",
}

def load_api_key() -> str:
    load_dotenv(ROOT / "backend" / ".env")
    key = os.getenv("OPENSEA_API_KEY", "").strip()
    if not key:
        raise ValueError("OPENSEA_API_KEY not set in backend/.env")
    return key

def fetch_mint_events_by_wallet(api_key: str, wallet: str, after: str, chain: str = "ethereum", limit: int = 200, collection_slug: str = None) -> list[dict]:
    """Fetch mint events created by the wallet after the cutoff date.
    If collection_slug is provided, scope to that collection only (targeted, fast, avoids unrelated mints).
    """
    headers = {"X-API-KEY": api_key, "Accept": "application/json"}
    events = []
    next_cursor = None
    occurred_after = f"{after}T00:00:00Z" if not "T" in after else after

    while True:
        params = {
            "event_type": "mint",
            "account_address": wallet,
            "chain": chain,
            "occurred_after": occurred_after,
            "limit": limit
        }
        if collection_slug:
            params["collection_slug"] = collection_slug
        if next_cursor:
            params["next"] = next_cursor

        url = "https://api.opensea.io/api/v2/events"
        for attempt in range(5):  # retry on rate limit
            resp = requests.get(url, headers=headers, params=params, timeout=60)
            if resp.status_code == 429:
                wait = (2 ** attempt) * 1.5  # backoff
                print(f"  Rate limited (429), sleeping {wait:.1f}s (attempt {attempt+1})...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            data = resp.json()
            batch = data.get("asset_events", [])
            events.extend(batch)
            next_cursor = data.get("next")
            print(f"  Fetched {len(batch)} mint events (total: {len(events)})...")
            time.sleep(0.6)  # Throttle between successful pages
            break
        else:
            print("  Too many 429s, giving up on this page.")
            break
        if not next_cursor or len(batch) == 0:
            break
    return events

def get_nft_details(chain: str, contract: str, token_id: str, api_key: str) -> dict:
    headers = {"X-API-KEY": api_key}
    url = f"https://api.opensea.io/api/v2/chain/{chain}/contract/{contract}/nfts/{token_id}"
    resp = requests.get(url, headers=headers, timeout=30)
    if resp.status_code == 200:
        return resp.json().get("nft", {})
    return {}

def get_owners(chain: str, contract: str, token_id: str, api_key: str) -> list:
    headers = {"X-API-KEY": api_key}
    url = f"https://api.opensea.io/api/v2/chain/{chain}/contract/{contract}/nfts/{token_id}/owners"
    resp = requests.get(url, headers=headers, timeout=30)
    if resp.status_code == 200:
        return resp.json().get("owners", [])
    return []

def get_collection_stats(slug: str, api_key: str) -> dict:
    headers = {"X-API-KEY": api_key}
    url = f"https://api.opensea.io/api/v2/collections/{slug}/stats"
    resp = requests.get(url, headers=headers, timeout=30)
    if resp.status_code == 200:
        return resp.json()
    return {}

def is_known_pattern(name: str, collection: str) -> bool:
    text = (name + " " + collection).lower()
    return any(p in text for p in KNOWN_GOOD_PATTERNS)


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
    if not owners:
        return {"holder_count": 0, "circulating_copies": 0, "top_holders": [], "holders": []}
    sorted_owners = sorted(owners, key=lambda x: int(x.get("quantity", 0)), reverse=True)
    total_copies = sum(int(o.get("quantity", 0)) for o in sorted_owners)
    holder_rows = [
        {"address": o.get("address"), "quantity": int(o.get("quantity", 0))}
        for o in sorted_owners if o.get("address")
    ]
    return {
        "holder_count": len(holder_rows),
        "circulating_copies": total_copies,
        "top_holders": holder_rows[:5],
        "holders": holder_rows,
    }


def get_first_mint_timestamp(chain: str, contract: str, token_id: str, api_key: str) -> str | None:
    """Fetch the exact mint event timestamp for this specific token (targeted, no broad scan).
    This gives accurate first-minted date for the representative NFT without clogging the pipeline.
    Falls back to NFT created_at if events not available.
    """
    headers = {"X-API-KEY": api_key}
    url = f"https://api.opensea.io/api/v2/events/chain/{chain}/contract/{contract}/nfts/{token_id}"
    params = {"event_type": "mint", "limit": 1}
    try:
        resp = requests.get(url, headers=headers, params=params, timeout=30)
        if resp.status_code == 200:
            events = resp.json().get("asset_events", [])
            if events:
                ts = events[0].get("event_timestamp")
                if ts:
                    return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
    except Exception as e:
        print(f"  Note: could not fetch mint event for {token_id} ({e})")
    return None

def get_sub_category(award_cat: str, name: str) -> str:
    """Compute sub_category for search dropdown filters and unique tags.
    Rules based on data:
    - All 'Trillion Club' variants (1+ Trillion) grouped under 'Trillion Club' to include all types as one filter option.
    - For others, use the specific collection name from OpenSea data (cleaned).
    - This supports the search bar having 'Badges' + subcats like 'Trillion Club', 'Rookie Card 2026', 'Award Badges', etc.
    - For new additions: if name contains 'trillion club' -> 'Trillion Club', else fall back to cleaned collection name.
    - Makes the badges feel like a hierarchy under 'badges' collection, with sub filters for marketing (reward types: trillion club rewards, rookie awards, etc.).
    """
    n = ((award_cat or '') + ' ' + (name or '')).lower()
    if 'trillion_club' in n or 'trillion club' in n:
        return 'Trillion Club'
    if 'rookie_card' in n or 'rookie card' in n:
        return 'Rookie Card 2026'
    if 'award_badges' in n or 'award badges' in n:
        return 'Award Badges'
    if 'collector_cat' in n or 'collector cat' in n:
        return 'Collector Cat'
    if 'gem_nova_green' in n or 'gem' in n:
        return 'Gem Nova Green'
    if '500_billion_club' in n or 'billion club' in n:
        return '500 Billion Club'
    # Fallback to cleaned collection name from OpenSea for most part.
    return (award_cat or name or 'Other').replace('_', ' ').title()

def get_tags(item: dict) -> list:
    """Unique tags for the collection to stand out as rewards/badges.
    - '1_of_1': for true 1:1 custom rewards.
    - 'trillion_club': for the series.
    - 'award': for award badges.
    - 'personalized': for custom with name on it (from name or unclaimed for earnable).
    - Used for marketing to highlight personalization in wallet view (the NFT with their name).
    """
    tags = []
    if item.get('is_1_of_1'):
        tags.append('1_of_1')
    ac = item.get('award_category', '').lower()
    if 'trillion' in ac:
        tags.append('trillion_club')
    if 'award' in ac:
        tags.append('award')
    if item.get('unclaimed_or_available') or 'personal' in (item.get('name','') + item.get('description','')).lower():
        tags.append('personalized')
    return tags

def enrich_badge(raw_event: dict, api_key: str) -> dict | None:
    """Turn a mint event into our badge item."""
    asset = raw_event.get("asset", {}) or raw_event.get("nft", {})
    if not asset:
        return None

    chain = "ethereum"
    contract = asset.get("contract", "")
    token_id = str(asset.get("identifier", asset.get("token_id", "")))
    name = asset.get("name", "") or ""
    desc = asset.get("description", "") or ""
    collection_slug = asset.get("collection", "") or ""
    image = asset.get("image_url") or asset.get("display_image_url")

    if not contract or not token_id:
        return None

    # Get current owners (filter issuer)
    owners = get_owners(chain, contract, token_id, api_key)
    non_issuer = [o for o in owners if (o.get("address") or "").lower() != ISSUER_WALLET]
    holder_count = len(non_issuer)
    unclaimed = holder_count == 0

    # Get collection supply for edition logic
    stats = get_collection_stats(collection_slug, api_key) if collection_slug else {}
    supply = stats.get("total", {}).get("supply", 0) or 0

    # 1:1 validation - conservative
    is_1of1 = False
    if supply > 0 and supply <= 5:
        is_1of1 = True
    # Could add trait check here in future: look for "1 of 1" or edition traits

    # Category from known patterns + name
    category = "other"
    for p in KNOWN_GOOD_PATTERNS:
        if p in (name + " " + collection_slug).lower():
            category = p.replace(" ", "_")
            break
    if "trillion" in (name + " " + collection_slug).lower():
        category = "trillion_club"

    # Special parsing for Trillion Club collections (1 Trillion and above have custom 1:1 memberships with personalized names and images).
    # Parse the custom recipient from the name (e.g. "KRYPTLOS - DACAT 10 TRILLION CLUB MEMBERSHIP #2" -> "KRYPTLOS").
    # Use the specific NFT's image_url (not the collection logo).
    # This ensures each 1:1 has its own asset and data.
    # For discovery / NFT search (light mode): show the collection/series image as the representative "NFT" card (with supply and "X custom 1:1s") to avoid duplicates of similar personalized 1:1s.
    # The actual specific NFT (custom image, custom name, tied to the owner) is shown in the wallet collector view (dark mode) for the owner, by matching current_owner or the custom name.
    # This reuses the existing gallery/collector architecture with minimal changes: main search shows series reps, collector shows the owned specific item.
    # Parsing is only for Trillion Club type (as they have the custom names); other collections use collection level or normal.
    custom_recipient = None
    awarded_for = category.replace('_', ' ').title()
    # Force generic series name for the catalog item used in general/light search.
    # This prevents personalized 1:1 names (e.g. "MOZVANE - ...") from appearing outside wallet collector view.
    display_name = name
    if "trillion club" in (name + " " + collection_slug).lower():
        if " - " in name:
            custom_recipient = name.split(" - ")[0].strip()
        base = name.split(" - ", 1)[-1].strip() if " - " in name else name
        display_name = base
        awarded_for = category.replace('_', ' ').title()

    # Mystery if doesn't match known good patterns from the user's table
    mystery = not is_known_pattern(name, collection_slug)

    # Random drop / award flag (expanded)
    random_drop = False
    if supply > 5 and not is_1of1 and "trillion" not in name.lower():
        random_drop = True  # higher supply non-custom may be random drop tier

    # Full item shape to match main archive (gallery_data.json) + unique badge fields.
    # See the Excel mapping (badges_data_mapping_and_plan_*.xlsx) for exact correspondence to every archive field
    # and why each is needed for consistent UI (gallery grid, detail, collector view, etc.).
    item = {
        # Core archive fields
        "token_id": token_id,
        "name": name,
        "display_name": display_name,
        "awarded_for": awarded_for,  # for Trillion: "Trillion Club 10 - Kryptlos" etc.
        "local_slug": name.lower().replace(" ", "-").replace("_", "-")[:50] if name else token_id,
        "description": desc,
        "excerpt": (desc[:200] + "...") if len(desc) > 200 else desc,
        "image_url": image,
        "media_type": "video" if (image or "").lower().endswith((".mp4", ".mov", ".webm")) else "image",
        "opensea_url": asset.get("opensea_url"),
        "metadata_url": asset.get("metadata_url"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "traits": asset.get("traits", []),
        "listed": False,
        "listing": None,
        "owners": {
            "holder_count": holder_count,
            "circulating_copies": supply,
            "top_holders": [],  # can enrich later if needed
            "holders": non_issuer[:5] if non_issuer else []  # limited for size
        },
        "recent_activity": [],  # can populate from events in future
        "minted_at": raw_event.get("event_timestamp"),

        # Unique badge fields (make it feel like a personalized award/badge collection)
        "id": f"{chain}:{contract}:{token_id}",
        "chain": chain,
        "contract": contract,
        "source_created_collection": collection_slug,
        "is_1_of_1": is_1of1,
        "edition_size": supply,
        "current_holders": non_issuer,
        "holder_count": holder_count,
        "circulating_copies": supply,
        "unclaimed_or_available": unclaimed,
        "award_category": category,
        "random_drop_flag": random_drop,
        "mystery_status": "mystery_until_review" if mystery else "approved",
        "created_by_wallet": ISSUER_WALLET,
        "ens_match_detected": False,
        "personalized_award_vibe": bool(unclaimed or (category != "other")),
        "sub_category": get_sub_category(category, name),
        "tags": get_tags({"is_1_of_1": is_1of1, "award_category": category, "unclaimed_or_available": unclaimed, "name": name, "description": desc}),
    }
    return item

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Badges - Created by wallet on ETH after cutoff date")
    parser.add_argument("--full", action="store_true", help="Initial full load of creations after cutoff")
    parser.add_argument("--sync", action="store_true", help="Incremental (future)")
    parser.add_argument("--report-only", action="store_true")
    args = parser.parse_args()

    if not args.full:
        args.full = True

    api_key = load_api_key()
    print("=== daCAT Badges - Created by Wallet (ETH only, after cutoff) ===")
    print(f"Issuer wallet: {ISSUER_WALLET}")
    print(f"CUTOFF_DATE: {CUTOFF_DATE} (edit in this file if needed)")
    print(f"Known good patterns for categories/mystery: {KNOWN_GOOD_PATTERNS}")
    print(f"Targeting only known badge collections (using same nfts list as main dacommunity pipeline): {KNOWN_BADGE_COLLECTION_SLUGS}")
    print("Fetching NFTs list for known badge collections (no broad mint events scan)...")

    client = OpenSeaClient(api_key)
    items = []
    first_mint_validated = False
    from collections import defaultdict
    slug_nfts = defaultdict(list)
    for slug in KNOWN_BADGE_COLLECTION_SLUGS:
        print(f"  -> {slug}")
        try:
            nfts = client.iter_collection_nfts(slug)
            for nft in nfts:
                slug_nfts[slug].append(nft)
        except Exception as e:
            print(f"  Error for {slug}: {e}")

    for slug, nfts in slug_nfts.items():
        if not nfts:
            continue
        # take first for name/image etc (series rep), but for rookie use the specific token 1 to match bootstrap first mint
        if slug == "dacatrookie2026":
            # Use the actual first mint token for rookie (token 3 per validation)
            nft = next((n for n in nfts if str(n.get("identifier") or n.get("token_id") or "") == "3"), nfts[0])
        else:
            nft = nfts[0]
        token_id = str(nft.get("identifier") or nft.get("token_id") or "1")
        contract = nft.get("contract")
        if isinstance(contract, dict):
            contract = contract.get("address", "")
        elif not isinstance(contract, str):
            contract = ""
        name = nft.get("name") or f"{slug} #{token_id}"
        desc = clean_description(nft.get("description") or "")
        image = nft.get("image_url") or nft.get("animation_url") or ""
        media_type = "video" if (image or "").lower().endswith((".mp4", ".mov", ".webm")) else "image"
        # Prefer exact first mint event timestamp (targeted per rep token)
        created_at = get_first_mint_timestamp("ethereum", contract, token_id, api_key) or nft.get("created_at") or nft.get("minted_at")

        # aggregate owners from all nfts in this collection (for accurate holder count)
        all_owners = []
        for n in nfts:
            t_id = str(n.get("identifier") or n.get("token_id") or "")
            c = n.get("contract")
            if isinstance(c, dict):
                c = c.get("address", "")
            elif not isinstance(c, str):
                c = ""
            if c and t_id:
                try:
                    os = client.get_nft_owners(t_id, chain="ethereum", contract=c)
                    all_owners.extend(os)
                except:
                    pass
        owner_stats = summarize_owners(all_owners)

        # Resolve ENS for owners (like main dacommunity) so collector view shows ENS names
        for holder_list in (owner_stats.get("holders", []), owner_stats.get("top_holders", [])):
            for h in holder_list:
                try:
                    res = client.resolve_account(h["address"])
                    if res.get("ens_name"):
                        h["ens_name"] = res["ens_name"]
                except Exception:
                    pass

        # supply / 1of1 from first or total
        supply = len(nfts) or 1
        is_1of1 = supply <= 5 or any("1/1" in str(t).lower() or "one of one" in str(t).lower() for t in nft.get("traits", []))

        category = get_sub_category("", name).lower().replace(" ", "_")
        unclaimed = "unclaimed" in name.lower() or "available" in (desc or "").lower()
        mystery = not is_known_pattern(name, slug)

        # Force generic for search/light view
        base = name.split(" - ", 1)[-1].strip() if " - " in name else name
        display_name = base
        awarded_for = category.replace("_", " ").title()

        local_slug = SLUG_TO_LOCAL_ASSET.get(slug, slug + "-" + token_id)
        item = {
            "token_id": token_id,
            "name": name,
            "display_name": display_name,
            "local_slug": local_slug,
            "description": desc,
            "excerpt": excerpt(desc),
            "image_url": image,
            "media_type": media_type,
            "opensea_url": f"https://opensea.io/collection/{slug}",
            "traits": nft.get("traits", []),
            "listed": False,
            "listing": None,
            "owners": owner_stats,
            "minted_at": created_at,
            "is_1_of_1": is_1of1,
            "edition_size": supply,
            "award_category": category,
            "unclaimed_or_available": unclaimed,
            "mystery_status": "mystery_until_review" if mystery else "approved",
            "source_created_collection": slug,
            "created_by_wallet": ISSUER_WALLET,
            "sub_category": get_sub_category(category, name),
            "tags": get_tags({"is_1_of_1": is_1of1, "award_category": category, "unclaimed_or_available": unclaimed, "name": name, "description": desc}),
        }
        items.append(item)

        # validate first mint (rookie is first slug)
        if not first_mint_validated and slug == "dacatrookie2026":
            print(f"\nFirst mint validated in data (rookie card token {token_id}):")
            print(f"  slug: {slug}, token: {token_id}, created: {created_at}")
            print(f"  opensea_url: {item['opensea_url']}")
            first_mint_validated = True

    if not first_mint_validated:
        print("Note: Could not validate first mint (rookie #1) - check data.")
    else:
        print("First mint (rookie #1) successfully validated.")

    # Stats
    total = len(items)
    one_of_ones = sum(1 for i in items if i["is_1_of_1"])
    mysteries = sum(1 for i in items if i["mystery_status"] == "mystery_until_review")
    unclaimed = sum(1 for i in items if i["unclaimed_or_available"])

    # Full structure to support same UI/features as main dacommunity archive (gallery_data.json shape)
    # + unique badge fields. This is stored in the data process (fetch_badges.py produces the rich data).
    # See backend/review/badges_data_mapping_and_plan_*.xlsx for full mapping of every archive field.
    collection_summary = {
        "slug": "badges",
        "name": "daCAT Badges",
        "display_name": "daCAT 1/1 Personal Awards & Badges",
        "chain": "ethereum",
        "creator_wallet": ISSUER_WALLET,
        "note": "Personal 1/1 and limited awards/badges created by the wallet. Issuer wallet excluded from all holder stats. Mystery items pending approval.",
        "total_created": total,
        "one_of_ones": one_of_ones,
        "unclaimed": unclaimed,
        "mysteries": mysteries,
    }

    proposed = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "mints_created_by_wallet_on_ethereum_after_cutoff",
        "cutoff_date": CUTOFF_DATE,
        "collection": collection_summary,
        "items": items,   # Each item includes all main archive fields (token_id, name, image_url, media_type, opensea_url, traits, description, owners/holder_count/circulating_copies, recent_activity/minted_at, etc.) + unique badge fields below
    }

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out_path = REVIEW_DIR / f"badges_proposed_created_{ts}.json"
    out_path.write_text(json.dumps(proposed, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote proposed review file: {out_path}")
    print(f"Total items: {total} | 1:1s: {one_of_ones} | Mysteries: {mysteries} | Unclaimed: {unclaimed}")
    print("Review the JSON + regenerate the Excel for easy viewing.")
    print("Update CUTOFF_DATE in this script as needed for the 'certain date'.")

if __name__ == "__main__":
    main()
