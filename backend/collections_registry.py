"""
Collection registry — single manifest for live + upcoming NFT collections.

Each collection may use different chains, OpenSea slugs, frontend routes, and
feature flags. Fetch scripts should resolve the active collection by ``id`` rather
than hard-coding slug/contract in multiple files.

Registry file: web/data/collections_registry.json (also consumed by the static site).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REGISTRY_PATH = ROOT / "web" / "data" / "collections_registry.json"


def load_registry() -> dict[str, Any]:
    if not REGISTRY_PATH.is_file():
        raise FileNotFoundError(f"Missing collection registry: {REGISTRY_PATH}")
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def list_collections() -> list[dict[str, Any]]:
    return list(load_registry().get("collections") or [])


def get_collection(collection_id: str) -> dict[str, Any] | None:
    for entry in list_collections():
        if entry.get("id") == collection_id:
            return entry
    return None


def get_live_collections() -> list[dict[str, Any]]:
    return [c for c in list_collections() if c.get("status") == "live"]


def get_primary_live() -> dict[str, Any]:
    """Default gallery collection (daCommunity today)."""
    live = get_live_collections()
    if not live:
        raise RuntimeError("No live collection in registry")
    return live[0]


def opensea_slug_for(collection_id: str) -> str | None:
    entry = get_collection(collection_id)
    if not entry:
        return None
    return entry.get("opensea_slug")


def contract_for(collection_id: str) -> str | None:
    entry = get_collection(collection_id)
    if not entry:
        return None
    return entry.get("contract")