"""
OpenSea API v2 client with request throttling.

Endpoints used by the gallery pipeline:
  - Collection NFTs, stats, holders
  - Per-token owners, events (transfer/sale/mint), and best listing
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
    def __init__(
        self,
        api_key: str,
        delay: float = REQUEST_DELAY_SEC,
        *,
        chain: str | None = None,
        contract: str | None = None,
        collection_slug: str | None = None,
    ):
        self.session = requests.Session()
        self.session.headers["x-api-key"] = api_key
        self.session.headers["Accept"] = "application/json"
        self.delay = delay
        self._last_request = 0.0
        # Per-instance collection context (defaults: primary daCommunity from config)
        self.chain = chain or CHAIN
        self.contract = contract or CONTRACT_ADDRESS
        self.collection_slug = collection_slug or COLLECTION_SLUG

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)
        self._last_request = time.monotonic()

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        """Internal request with retry for rate limits (429) and transient server errors."""
        url = f"{OPENSEA_BASE}{path}"
        last_exc = None
        for attempt in range(5):  # up to 5 attempts
            self._throttle()
            try:
                if method.lower() == "get":
                    resp = self.session.get(url, timeout=45, **kwargs)
                else:
                    resp = self.session.post(url, timeout=30, **kwargs)
                if resp.status_code == 404:
                    return {}
                if resp.status_code == 429:
                    retry_after = int(resp.headers.get("Retry-After", 60))
                    sleep_time = retry_after + (attempt * 5) + 1
                    print(f"Rate limited (429), sleeping {sleep_time}s (attempt {attempt+1})")
                    time.sleep(sleep_time)
                    continue
                if resp.status_code in (500, 502, 503, 504) and attempt < 4:
                    sleep_time = (2 ** attempt) + 1
                    print(f"Server error {resp.status_code}, retrying in {sleep_time}s")
                    time.sleep(sleep_time)
                    continue
                resp.raise_for_status()
                return resp.json()
            except requests.exceptions.RequestException as e:
                last_exc = e
                if attempt < 4:
                    sleep_time = (2 ** attempt) + 2
                    print(f"Request error {e}, retry {attempt+1}/5 in {sleep_time}s")
                    time.sleep(sleep_time)
                    continue
                raise
        if last_exc:
            raise last_exc
        raise RuntimeError("Request failed after retries")

    def _get(self, path: str, params: dict | None = None) -> dict[str, Any]:
        return self._request("get", path, params=params)

    def _post(self, path: str, json_body: dict | None = None) -> dict[str, Any]:
        return self._request("post", path, json=json_body or {})

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
        return self._get(f"/collections/{self.collection_slug}/stats")

    def get_contract(self) -> dict[str, Any]:
        return self._get(f"/chain/{self.chain}/contract/{self.contract}")

    def iter_collection_nfts(self, collection_slug: str = None, limit: int = 200) -> list[dict[str, Any]]:
        if collection_slug is None:
            collection_slug = self.collection_slug
        nfts: list[dict[str, Any]] = []
        next_cursor: str | None = None
        while True:
            params: dict[str, Any] = {"limit": limit}
            if next_cursor:
                params["next"] = next_cursor
            data = self._get(f"/collection/{collection_slug}/nfts", params)
            nfts.extend(data.get("nfts") or [])
            next_cursor = data.get("next")
            if not next_cursor:
                break
        return nfts

    def get_best_listing(self, token_id: str) -> dict[str, Any] | None:
        data = self._get(
            f"/listings/collection/{self.collection_slug}/nfts/{token_id}/best"
        )
        if not data or data.get("status") != "ACTIVE":
            return None
        return data

    def iter_collection_best_listings(self, limit: int = 100) -> list[dict[str, Any]]:
        """All active best listings for the collection (paginated)."""
        listings: list[dict[str, Any]] = []
        next_cursor: str | None = None
        while True:
            params: dict[str, Any] = {"limit": limit}
            if next_cursor:
                params["next"] = next_cursor
            data = self._get(
                f"/listings/collection/{self.collection_slug}/best", params
            )
            batch = data.get("listings") or []
            listings.extend(batch)
            next_cursor = data.get("next")
            if not next_cursor:
                break
        return listings

    def get_nft_owners(self, token_id: str, chain: str = None, contract: str = None) -> list[dict[str, Any]]:
        if chain is None:
            chain = self.chain
        if contract is None:
            contract = self.contract
        owners: list[dict[str, Any]] = []
        next_cursor: str | None = None
        while True:
            params: dict[str, Any] = {"limit": 100}
            if next_cursor:
                params["next"] = next_cursor
            data = self._get(
                f"/chain/{chain}/contract/{contract}/nfts/{token_id}/owners",
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
            data = self._get(f"/collections/{self.collection_slug}/holders", params)
            holders.extend(data.get("holders") or [])
            cursor = data.get("next")
            if not cursor:
                break
        return holders

    def resolve_account(self, identifier: str) -> dict[str, Any]:
        encoded = quote(identifier, safe="")
        return self._get(f"/accounts/resolve/{encoded}")

    def resolve_ens_name(
        self,
        address: str,
        *,
        last_resolved: float | None = None,
        cache_days: int = 14,
        previous_ens: str | None = None,
    ) -> str | None:
        """Primary ENS resolver for wallet_index / badge owners.

        Strategy (per requirements):
        1. Primary: ensdata.net/{address} (free, no key, fast). Uses "ens_primary" or "ens".
        2. Fallback: self.resolve_account(address) from OpenSea.
        3. Cache: Skip network if last_resolved (unix timestamp seconds) is < cache_days old (default 14).
           This prevents re-resolving every address on every daily run, keeping the ~15min pipeline fast.
        4. Always normalize to .lower() on any new resolution. This permanently fixes
           ALL-CAPS issues (e.g. "DAFOREMAN.ETH" -> "daforeman.eth") for storage, aliases, history, and display.
        5. On skip or transient failure: return previous_ens (never wipe good data on flaky days).
        6. Called for both gallery holders (via build_holders_index) and badge owner addresses (via merge).

        last_resolved and previous_ens are passed from prior wallet_index.json entries.
        """
        addr = (address or "").lower().strip()
        if not addr:
            return None

        now = time.time()
        if last_resolved is not None and (now - last_resolved) < (cache_days * 86400):
            # Fast path: recently resolved, reuse previous value. No API calls.
            # Always lower to guarantee no caps ever make it to wallet (even if legacy data had caps).
            return previous_ens.lower() if previous_ens else None

        # Primary resolver: ensdata.net (public, no auth, returns ens_primary or ens)
        try:
            r = requests.get(f"https://ensdata.net/{addr}", timeout=6)
            if r.status_code == 200:
                data = r.json() or {}
                ens = data.get("ens_primary") or data.get("ens")
                if ens:
                    return str(ens).lower().strip()
        except Exception:
            # Network/JSON error etc. -> fall through to OpenSea fallback
            pass

        # Fallback to existing OpenSea account resolver
        try:
            resolved = self.resolve_account(addr)
            ens = resolved.get("ens_name") if isinstance(resolved, dict) else None
            if ens:
                return str(ens).lower().strip()
        except Exception:
            pass

        # Transient failure this run: preserve previous ENS (if any) so we don't lose it
        # (and normalize lower for safety)
        return previous_ens.lower() if previous_ens else None

    def get_nft_events(
        self,
        token_id: str,
        event_types: list[str] | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Recent activity for one token (transfers, sales, mints)."""
        params: dict[str, Any] = {"limit": min(limit, 200)}
        if event_types:
            params["event_type"] = event_types
        data = self._get(
            f"/events/chain/{self.chain}/contract/{self.contract}/nfts/{token_id}",
            params,
        )
        return list(data.get("asset_events") or [])

    def iter_collection_events(
        self,
        event_types: list[str] | None = None,
        limit: int = 200,
    ):
        """Yield asset events for the configured collection (paginated)."""
        next_cursor: str | None = None
        while True:
            params: dict[str, Any] = {"limit": limit}
            if event_types:
                params["event_type"] = event_types
            if next_cursor:
                params["next"] = next_cursor
            data = self._get(f"/events/collection/{self.collection_slug}", params)
            for event in data.get("asset_events") or []:
                yield event
            next_cursor = data.get("next")
            if not next_cursor:
                break

    def get_account_collection_nfts(self, address: str) -> list[dict[str, Any]]:
        nfts: list[dict[str, Any]] = []
        next_cursor: str | None = None
        while True:
            params: dict[str, Any] = {
                "collection": self.collection_slug,
                "limit": 200,
            }
            if next_cursor:
                params["next"] = next_cursor
            data = self._get(f"/chain/{self.chain}/account/{address}/nfts", params)
            nfts.extend(data.get("nfts") or [])
            next_cursor = data.get("next")
            if not next_cursor:
                break
        return nfts