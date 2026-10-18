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

# How long a reverse-primary ENS is trusted before a full multi-source refresh.
# Keep short so renames (new primary reverse) land within a few daily runs.
ENS_CACHE_DAYS = 3


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

    def fetch_account_profile(self, address: str) -> dict[str, Any]:
        """Best-effort OpenSea profile for a wallet (username + optional ens_name).

        Tries ``/accounts/{addr}`` then ``/accounts/resolve/{addr}`` — resolve alone
        sometimes omits username while the accounts endpoint has it.
        """
        addr = (address or "").strip()
        if not addr:
            return {}
        out: dict[str, Any] = {}
        encoded = quote(addr, safe="")
        for path in (f"/accounts/{encoded}", f"/accounts/resolve/{encoded}"):
            try:
                data = self._get(path)
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            if not out.get("username"):
                u = data.get("username") or data.get("display_name")
                if u and not (str(u).lower().startswith("0x") and len(str(u)) >= 10):
                    out["username"] = str(u).strip()
            if not out.get("ens_name") and data.get("ens_name"):
                out["ens_name"] = str(data.get("ens_name")).lower().strip()
            if out.get("username"):
                break
        return out

    @staticmethod
    def _normalize_ens_label(ens: str | None) -> str | None:
        if ens is None:
            return None
        ens = str(ens).lower().strip()
        if not ens or ens.startswith("0x"):
            return None
        return ens

    def _ens_from_ensideas(self, addr: str) -> str | None:
        """Primary reverse via ensideas (tracks Etherscan-style primary closely)."""
        try:
            r = requests.get(
                f"https://api.ensideas.com/ens/resolve/{addr}",
                timeout=6,
            )
            if r.status_code != 200:
                return None
            data = r.json() or {}
            got = (data.get("address") or "").lower().strip()
            if got and got != addr:
                return None
            return self._normalize_ens_label(data.get("name") or data.get("displayName"))
        except Exception:
            return None

    def _ens_from_web3bio(self, addr: str) -> str | None:
        """Primary ENS identity from web3.bio profile list."""
        try:
            r = requests.get(
                f"https://api.web3.bio/profile/{addr}",
                timeout=8,
                headers={"Accept": "application/json"},
            )
            if r.status_code != 200:
                return None
            profiles = r.json() or []
            if not isinstance(profiles, list):
                return None
            for p in profiles:
                if not isinstance(p, dict):
                    continue
                if (p.get("platform") or "").lower() != "ens":
                    continue
                got = (p.get("address") or "").lower().strip()
                if got and got != addr:
                    continue
                ens = self._normalize_ens_label(
                    p.get("identity") or p.get("displayName")
                )
                if ens:
                    return ens
        except Exception:
            return None
        return None

    def _ens_from_ensdata(self, addr: str) -> str | None:
        """ensdata.net ens_primary only (never bare owned-name ``ens``)."""
        try:
            r = requests.get(f"https://ensdata.net/{addr}", timeout=6)
            if r.status_code != 200:
                return None
            data = r.json() or {}
            ens = self._normalize_ens_label(data.get("ens_primary"))
            if not ens:
                return None
            wallets = data.get("wallets") if isinstance(data.get("wallets"), dict) else {}
            eth_wallet = (wallets.get("eth") or data.get("address") or "").lower()
            if eth_wallet and eth_wallet != addr:
                return None
            return ens
        except Exception:
            return None

    def resolve_ens_name(
        self,
        address: str,
        *,
        last_resolved: float | None = None,
        cache_days: int = ENS_CACHE_DAYS,
        previous_ens: str | None = None,
    ) -> str | None:
        """Reverse-primary ENS for a wallet (all collectors, not ad-hoc).

        Sources (first hit wins, freshest APIs first):
          1) ensideas.com — matches Etherscan primary reverse
          2) web3.bio ENS profile
          3) ensdata.net ens_primary
          4) OpenSea account ens_name

        Cache: skip full refresh for ``cache_days`` (default 3), but still probe
        ensideas inside the window so a new primary reverse (rename) is applied
        immediately for every wallet. Lowercase always. On total failure keep
        previous_ens. Base / OpenSea username stay separate fields.
        """
        addr = (address or "").lower().strip()
        if not addr:
            return None

        prev = self._normalize_ens_label(previous_ens)
        now = time.time()
        in_cache = (
            last_resolved is not None
            and (now - float(last_resolved)) < (cache_days * 86400)
        )

        # Soft cache: still check ensideas so renames land without waiting days.
        if in_cache:
            fresh = self._ens_from_ensideas(addr)
            if fresh:
                return fresh
            return prev

        for getter in (
            self._ens_from_ensideas,
            self._ens_from_web3bio,
            self._ens_from_ensdata,
        ):
            ens = getter(addr)
            if ens:
                return ens

        try:
            resolved = self.resolve_account(addr)
            ens = (
                self._normalize_ens_label(resolved.get("ens_name"))
                if isinstance(resolved, dict)
                else None
            )
            if ens:
                return ens
        except Exception:
            pass

        return prev

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