"""
Shared constants for the OpenSea fetch pipeline.

Primary collection values are sourced from web/data/collections_registry.json.
Legacy imports (COLLECTION_SLUG, CONTRACT_ADDRESS, …) remain for existing scripts.
"""

from __future__ import annotations

try:
    from collections_registry import get_primary_live

    _PRIMARY = get_primary_live()
    COLLECTION_SLUG = _PRIMARY.get("opensea_slug") or "rodeo-posts-12142"
    CONTRACT_ADDRESS = _PRIMARY.get("contract") or "0x64c30f84ed17e45e349b25c9dc02d7d2fd8081b1"
    CHAIN = _PRIMARY.get("chain") or "base"
except Exception:
    COLLECTION_SLUG = "rodeo-posts-12142"
    CONTRACT_ADDRESS = "0x64c30f84ed17e45e349b25c9dc02d7d2fd8081b1"
    CHAIN = "base"

OPENSEA_BASE = "https://api.opensea.io/api/v2"
OPENSEA_COLLECTION_URL = f"https://opensea.io/collection/{COLLECTION_SLUG}"

# Rodeo decommissioned; collection migrated — contract address unchanged on Base
COLLECTION_NOTE = (
    "Originally minted on Rodeo. Contract unchanged on Base; "
    "collection stewarded via dacatdreams.base.eth."
)
CREATOR_ENS = "dacatdreams.base.eth"

# Rate limit: free tier ~60 reads/min. Use 2s for headroom on long runs (holders + per-token owners/events).
REQUEST_DELAY_SEC = 2.0