"""Resolve OpenSea HTTP delay for daily fetch scripts.

Default stays REQUEST_DELAY_SEC (2.0) for instant/minted keys and local unknown keys.
CI with repo secret uses REQUEST_DELAY_FAST_SEC (0.35), matching enrich scripts.
"""

from __future__ import annotations

import os

from config import REQUEST_DELAY_FAST_SEC, REQUEST_DELAY_SEC

_resolved_delay: float | None = None


def resolve_request_delay() -> float:
    """Pick delay for OpenSeaClient from env / key source.

    Priority:
      1. OPENSEA_REQUEST_DELAY — explicit float override (rollback / tuning)
      2. OPENSEA_FAST in 1/true/yes — fast delay
      3. OPENSEA_KEY_SOURCE == repo_secret — fast delay
      4. REQUEST_DELAY_SEC (safe default)

    Cached per process so multi-volume fetchers log once.
    """
    global _resolved_delay
    if _resolved_delay is not None:
        return _resolved_delay

    raw = (os.getenv("OPENSEA_REQUEST_DELAY") or "").strip()
    if raw:
        try:
            delay = float(raw)
            print(f"OpenSea throttle: delay={delay} source=OPENSEA_REQUEST_DELAY")
            _resolved_delay = delay
            return delay
        except ValueError:
            print(f"OpenSea throttle: ignoring bad OPENSEA_REQUEST_DELAY={raw!r}")

    fast_flag = (os.getenv("OPENSEA_FAST") or "").strip().lower()
    if fast_flag in ("1", "true", "yes"):
        print(f"OpenSea throttle: delay={REQUEST_DELAY_FAST_SEC} source=OPENSEA_FAST")
        _resolved_delay = REQUEST_DELAY_FAST_SEC
        return REQUEST_DELAY_FAST_SEC

    key_source = (os.getenv("OPENSEA_KEY_SOURCE") or "").strip().lower()
    if key_source == "repo_secret":
        print(f"OpenSea throttle: delay={REQUEST_DELAY_FAST_SEC} source=repo_secret")
        _resolved_delay = REQUEST_DELAY_FAST_SEC
        return REQUEST_DELAY_FAST_SEC

    print(f"OpenSea throttle: delay={REQUEST_DELAY_SEC} source=default key_source={key_source or 'unset'}")
    _resolved_delay = REQUEST_DELAY_SEC
    return REQUEST_DELAY_SEC
