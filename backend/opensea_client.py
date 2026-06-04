"""
OpenSea API v2 client with request throttling.

Endpoints used by the gallery pipeline:
  - Collection NFTs, stats, holders
  - Per-token owners and best listing
  - Account resolve (ENS) and account NFTs by collection

See: https://docs.opensea.io/reference
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import quote

import requests

from config import (
    CHAIN,
    COLLECTION_SLUG,
    CONTRACT_ADDRESS,
    OPENSEA_BASE,
    REQUEST_DELAY_SEC,
)


class OpenSeaClient:
    def __init__(self, api_key: str, delay: float = REQUEST_DELAY_SEC):
        self.session = requests.Session()
        self.session.headers["x-api-key"] = api_key
        self.session.headers["Accept"] = "application/json"
        self.delay = delay
        self._last_request = 0.0

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)
        self._last_request = time.monotonic()

    def _get(self, path: str, params: dict | None = None) -> dict[str, Any]:
        self._throttle()
        url = f"{OPENSEA_BASE}{path}"
        resp = self.session.get(url, params=params, timeout=45)
        if resp.status_code == 404:
            return {}
        resp.raise_for_status()
        return resp.json()

    def _post(self, path: str, json_body: dict | None = None) -> dict[str, Any]:
        self._throttle()
        url = f"{OPENSEA_BASE}{path}"
        resp = self.session.post(url, json=json_body or {}, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def create_instant_api_key(self) -> str:
        saved = dict(self.session.headers)
        self.session.headers.pop("x-api-key", None)
        try:
            data = self._post("/auth/keys")
            return data["api_key"]
        finally:
            self.session.headers.clear()
            self.session.headers.update(saved)

    def get_collection_stats(self) -> dict[str, Any]:
        return self._get(f"/collections/{COLLECTION_SLUG}/stats")

    def get_contract(self) -> dict[str, Any]:
        return self._get(f"/chain/{CHAIN}/contract/{CONTRACT_ADDRESS}")

    def iter_collection_nfts(self, limit: int = 200) -> list[dict[str, Any]]:
        nfts: list[dict[str, Any]] = []
        next_cursor: str | None = None
        while True:
            params: dict[str, Any] = {"limit": limit}
            if next_cursor:
                params["next"] = next_cursor
            data = self._get(f"/collection/{COLLECTION_SLUG}/nfts", params)
            nfts.extend(data.get("nfts") or [])
            next_cursor = data.get("next")
            if not next_cursor:
                break
        return nfts

    def get_best_listing(self, token_id: str) -> dict[str, Any] | None:
        data = self._get(
            f"/listings/collection/{COLLECTION_SLUG}/nfts/{token_id}/best"
        )
        if not data or data.get("status") != "ACTIVE":
            return None
        return data

    def get_nft_owners(self, token_id: str) -> list[dict[str, Any]]:
        owners: list[dict[str, Any]] = []
        next_cursor: str | None = None
        while True:
            params: dict[str, Any] = {"limit": 100}
            if next_cursor:
                params["next"] = next_cursor
            data = self._get(
                f"/chain/{CHAIN}/contract/{CONTRACT_ADDRESS}/nfts/{token_id}/owners",
                params,
            )
            owners.extend(data.get("owners") or [])
            next_cursor = data.get("next")
            if not next_cursor:
                break
        return owners

    def iter_collection_holders(self, limit: int = 100) -> list[dict[str, Any]]:
        holders: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {"limit": limit, "sort_direction": "desc"}
            if cursor:
                params["cursor"] = cursor
            data = self._get(f"/collections/{COLLECTION_SLUG}/holders", params)
            holders.extend(data.get("holders") or [])
            cursor = data.get("next")
            if not cursor:
                break
        return holders

    def resolve_account(self, identifier: str) -> dict[str, Any]:
        encoded = quote(identifier, safe="")
        return self._get(f"/accounts/resolve/{encoded}")

    def get_account_collection_nfts(self, address: str) -> list[dict[str, Any]]:
        nfts: list[dict[str, Any]] = []
        next_cursor: str | None = None
        while True:
            params: dict[str, Any] = {
                "collection": COLLECTION_SLUG,
                "limit": 200,
            }
            if next_cursor:
                params["next"] = next_cursor
            data = self._get(f"/chain/{CHAIN}/account/{address}/nfts", params)
            nfts.extend(data.get("nfts") or [])
            next_cursor = data.get("next")
            if not next_cursor:
                break
        return nfts