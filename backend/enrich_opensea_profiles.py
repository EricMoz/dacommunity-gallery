"""
OpenSea profile username enricher (one-time backfill + weekly refresh).

Fills wallet_index username for holders missing a profile probe, without
touching the daily OpenSea gallery fetch path.

  cd backend
  python enrich_opensea_profiles.py              # fill unchecked / stale
  python enrich_opensea_profiles.py --force      # re-check everyone
  python enrich_opensea_profiles.py --max 20

Display priority on site (frontend):
  ENS → Base name → OpenSea username → short 0x
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = Path(__file__).resolve().parent / ".env"
WALLET_PATH = ROOT / "web" / "data" / "wallet_index.json"
NAME_INDEX_PATH = ROOT / "web" / "data" / "name_index.json"

# Weekly re-probe window (also used when force=False and profile already checked)
CACHE_DAYS = 21
REQUEST_DELAY_SEC = 0.35


def load_api_key() -> str:
    load_dotenv(ENV_PATH)
    key = os.getenv("OPENSEA_API_KEY", "").strip()
    if key:
        return key
    # CI: generate instant key like refresh-data.yml
    print("No OPENSEA_API_KEY — creating instant OpenSea key…")
    r = requests.post("https://api.opensea.io/api/v2/auth/keys", timeout=30)
    r.raise_for_status()
    key = (r.json() or {}).get("api_key") or ""
    if not key:
        raise RuntimeError("Failed to generate OpenSea API key")
    return key


def load_wallet() -> dict:
    if not WALLET_PATH.is_file():
        raise FileNotFoundError(f"Missing {WALLET_PATH}")
    return json.loads(WALLET_PATH.read_text(encoding="utf-8"))


def save_wallet(data: dict) -> None:
    WALLET_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Wrote {WALLET_PATH}")


def clean_username(u: str | None) -> str | None:
    if not u:
        return None
    s = str(u).strip()
    if not s:
        return None
    # Skip raw address dumps as "usernames"
    if s.lower().startswith("0x") and len(s) >= 10:
        return None
    return s


def fetch_profile(session: requests.Session, address: str) -> tuple[str | None, str | None]:
    """Return (username, ens_name) from OpenSea account endpoints."""
    addr = address.lower().strip()
    username = None
    ens = None
    for path in (f"/api/v2/accounts/{addr}", f"/api/v2/accounts/resolve/{addr}"):
        try:
            r = session.get(f"https://api.opensea.io{path}", timeout=20)
            if r.status_code == 404:
                continue
            if r.status_code == 429:
                time.sleep(10)
                r = session.get(f"https://api.opensea.io{path}", timeout=20)
            if not r.ok:
                continue
            d = r.json() or {}
            if not username:
                username = clean_username(d.get("username") or d.get("display_name"))
            if not ens and d.get("ens_name"):
                ens = str(d.get("ens_name")).lower().strip()
            if username:
                break
        except Exception:
            continue
    return username, ens


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill / refresh OpenSea usernames")
    parser.add_argument("--max", type=int, default=0, help="Limit wallets (0=all)")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-check every wallet (ignore profile_checked / cache)",
    )
    parser.add_argument(
        "--only-missing-names",
        action="store_true",
        help="Only wallets with no ENS and no Base name (where OS name would display)",
    )
    parser.add_argument("--delay", type=float, default=REQUEST_DELAY_SEC)
    args = parser.parse_args()

    api_key = load_api_key()
    session = requests.Session()
    session.headers["x-api-key"] = api_key
    session.headers["Accept"] = "application/json"

    wallet = load_wallet()
    hi = wallet.get("holders_index") or wallet
    ba = hi.get("by_address") or {}
    if not ba:
        print("No holders in wallet_index.")
        return 0

    # Optional base names for --only-missing-names
    name_index = {}
    if NAME_INDEX_PATH.is_file():
        try:
            name_index = (
                json.loads(NAME_INDEX_PATH.read_text(encoding="utf-8")).get(
                    "by_address"
                )
                or {}
            )
        except Exception:
            name_index = {}

    now = time.time()
    cache_sec = CACHE_DAYS * 86400
    addrs = sorted(ba.keys(), key=lambda a: str(a).lower())
    if args.max > 0:
        addrs = addrs[: args.max]

    checked = 0
    filled = 0
    skipped = 0
    errors = 0

    for i, addr_key in enumerate(addrs, 1):
        entry = ba[addr_key]
        addr = (entry.get("address") or addr_key).lower()
        ens = (entry.get("ens_name") or "").strip()
        base = (entry.get("base_name") or "").strip()
        if not base:
            base = str((name_index.get(addr) or {}).get("base_name") or "").strip()

        if args.only_missing_names and (ens or base):
            skipped += 1
            continue

        last = entry.get("last_profile_resolved") or entry.get("last_ens_resolved")
        already = bool(entry.get("profile_checked"))
        if (
            not args.force
            and already
            and last is not None
            and (now - float(last)) < cache_sec
        ):
            skipped += 1
            continue

        print(f"  [{i}/{len(addrs)}] {addr[:12]}…", end="", flush=True)
        time.sleep(max(0.05, float(args.delay)))
        try:
            username, os_ens = fetch_profile(session, addr)
            checked += 1
            entry["profile_checked"] = True
            entry["last_profile_resolved"] = now
            if username:
                entry["username"] = username
                filled += 1
                print(f" @{username}")
            else:
                # Keep prior username if any
                if not entry.get("username"):
                    entry["username"] = None
                print(" —")
            # Only fill ENS from OpenSea if we had none (don't clobber good data)
            if os_ens and not entry.get("ens_name"):
                entry["ens_name"] = os_ens
            if base and not entry.get("base_name"):
                entry["base_name"] = base
        except Exception as exc:
            errors += 1
            print(f" err {exc}")
            entry["profile_checked"] = True
            entry["last_profile_resolved"] = now

    # Sync collectors list
    collectors = hi.get("collectors") or []
    for c in collectors:
        key = str(c.get("address") or "").lower()
        e = ba.get(key) or ba.get(c.get("address") or "")
        if not e:
            continue
        if e.get("username"):
            c["username"] = e["username"]
        if e.get("ens_name") and not c.get("ens_name"):
            c["ens_name"] = e["ens_name"]
        if e.get("base_name") and not c.get("base_name"):
            c["base_name"] = e["base_name"]
    hi["collectors"] = collectors
    hi["by_address"] = ba
    if "holders_index" in wallet:
        wallet["holders_index"] = hi
    wallet["profiles_enriched_at"] = datetime.now(timezone.utc).isoformat()
    save_wallet(wallet)

    print(
        f"Done. checked={checked} filled_username={filled} "
        f"skipped={skipped} errors={errors}"
    )
    return 0 if errors < 20 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)
    except Exception as e:
        print(f"OpenSea profile enrich failed: {e}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        sys.exit(1)
