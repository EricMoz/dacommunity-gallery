"""
Weekly Base-name enricher (separate from daily OpenSea refresh).

Writes web/data/name_index.json and patches base_name onto wallet_index.json
holders when present. Intentionally NOT part of the daily pipeline so timeouts
or third-party blips never block listings/owners/events.

  cd backend
  python enrich_base_names.py
  python enrich_base_names.py --max 20   # smoke test

Source: api.web3.bio/profile/{address} → platform "basenames" → identity
  e.g. dacatdreams.base.eth

Display priority (frontend):
  ens_name → base_name → username → short 0x
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
WALLET_PATH = ROOT / "web" / "data" / "wallet_index.json"
NAME_INDEX_PATH = ROOT / "web" / "data" / "name_index.json"
DATA_DIR = ROOT / "web" / "data"

# Polite throttle for public API (weekly job only; ~80–200 wallets is fine)
REQUEST_DELAY_SEC = 0.35
CACHE_DAYS = 21  # re-check Base names about every 3 weeks
WEB3BIO = "https://api.web3.bio/profile"
UA = "daCommunity-Gallery/1.0 (base-name enricher; weekly)"


def load_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {path}")


def collect_addresses() -> list[str]:
    """Unique 0x addresses from wallet index + secondary collection catalogs."""
    found: set[str] = set()

    wallet = load_json(WALLET_PATH)
    hi = wallet.get("holders_index") or wallet
    for addr in (hi.get("by_address") or {}):
        a = str(addr).lower().strip()
        if a.startswith("0x") and len(a) == 42:
            found.add(a)

    for name in (
        "gallery_catalog.json",
        "bigkix_catalog.json",
        "dagato_agency_catalog.json",
        "badges_catalog.json",
    ):
        data = load_json(DATA_DIR / name)
        for item in data.get("items") or []:
            owners = item.get("owners") or {}
            for h in (owners.get("holders") or owners.get("top_holders") or []):
                a = (h.get("address") or "").lower().strip()
                if a.startswith("0x") and len(a) == 42:
                    found.add(a)

    return sorted(found)


def extract_basename(profile_payload) -> str | None:
    """Pick best basenames identity from web3.bio profile list."""
    rows = profile_payload if isinstance(profile_payload, list) else [profile_payload]
    candidates: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        platform = (row.get("platform") or "").lower()
        identity = (row.get("identity") or row.get("displayName") or "").strip()
        if not identity:
            continue
        ident_l = identity.lower()
        if platform in ("basenames", "basename", "base") or ident_l.endswith(
            ".base.eth"
        ):
            if ident_l.endswith(".base.eth"):
                candidates.append(ident_l)
            elif not ident_l.startswith("0x"):
                # sometimes identity is bare label
                candidates.append(f"{ident_l}.base.eth")
    if not candidates:
        return None
    # Prefer shortest readable name
    candidates.sort(key=lambda s: (len(s), s))
    return candidates[0]


def fetch_basename(session: requests.Session, address: str) -> str | None:
    url = f"{WEB3BIO}/{address}"
    try:
        r = session.get(url, timeout=12)
        if r.status_code == 404:
            return None
        if r.status_code == 429:
            # Back off once
            time.sleep(8)
            r = session.get(url, timeout=12)
        if not r.ok:
            return None
        return extract_basename(r.json())
    except Exception:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Weekly Base-name enricher")
    parser.add_argument("--max", type=int, default=0, help="Limit addresses (0=all)")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-resolve even if within cache window",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=REQUEST_DELAY_SEC,
        help="Seconds between web3.bio calls",
    )
    args = parser.parse_args()

    addresses = collect_addresses()
    if args.max > 0:
        addresses = addresses[: args.max]
    print(f"Addresses to consider: {len(addresses)}")

    prev_index = load_json(NAME_INDEX_PATH)
    prev_by = {
        str(k).lower(): v
        for k, v in (prev_index.get("by_address") or {}).items()
        if isinstance(v, dict)
    }

    session = requests.Session()
    session.headers["Accept"] = "application/json"
    session.headers["User-Agent"] = UA

    now = time.time()
    cache_sec = CACHE_DAYS * 86400
    by_address: dict[str, dict] = dict(prev_by)
    resolved = 0
    skipped = 0
    found = 0
    errors = 0

    for i, addr in enumerate(addresses, 1):
        prev = prev_by.get(addr) or {}
        last = prev.get("last_base_resolved")
        if (
            not args.force
            and last is not None
            and (now - float(last)) < cache_sec
        ):
            skipped += 1
            # keep previous entry
            if addr not in by_address:
                by_address[addr] = dict(prev)
            continue

        print(f"  [{i}/{len(addresses)}] {addr[:12]}…", end="", flush=True)
        time.sleep(max(0.05, float(args.delay)))
        try:
            base = fetch_basename(session, addr)
            resolved += 1
            entry = {
                "address": addr,
                "base_name": base,
                "last_base_resolved": now,
            }
            # Preserve any ens/username hints if we ever store them here
            if prev.get("ens_name"):
                entry["ens_name"] = prev["ens_name"]
            if prev.get("username"):
                entry["username"] = prev["username"]
            by_address[addr] = entry
            if base:
                found += 1
                print(f" {base}")
            else:
                print(" —")
        except Exception as exc:
            errors += 1
            print(f" err {exc}")
            by_address[addr] = {
                "address": addr,
                "base_name": prev.get("base_name"),
                "last_base_resolved": prev.get("last_base_resolved") or now,
            }

    name_index = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "web3.bio_profile",
        "cache_days": CACHE_DAYS,
        "address_count": len(by_address),
        "base_name_count": sum(
            1 for e in by_address.values() if e.get("base_name")
        ),
        "by_address": by_address,
        # aliases for wallet lookup (name → address)
        "name_aliases": {
            str(e["base_name"]).lower(): e["address"]
            for e in by_address.values()
            if e.get("base_name") and e.get("address")
        },
    }
    save_json(NAME_INDEX_PATH, name_index)

    # Patch wallet_index so archive collectors pick up base_name without extra frontend I/O
    if WALLET_PATH.is_file():
        wallet = load_json(WALLET_PATH)
        hi = wallet.get("holders_index") or wallet
        ba = hi.get("by_address") or {}
        patched = 0
        for addr, entry in ba.items():
            key = str(addr).lower()
            base = (by_address.get(key) or {}).get("base_name")
            if base and entry.get("base_name") != base:
                entry["base_name"] = base
                patched += 1
            elif base and not entry.get("base_name"):
                entry["base_name"] = base
                patched += 1
        # Keep collectors[] in sync (UI sometimes reads this list directly)
        collectors = hi.get("collectors") or []
        for c in collectors:
            key = str(c.get("address") or "").lower()
            base = (by_address.get(key) or {}).get("base_name") or (
                ba.get(key) or {}
            ).get("base_name")
            if base:
                c["base_name"] = base
        # aliases for .base.eth lookup
        aliases = hi.get("ens_aliases") or {}
        for name, a in (name_index.get("name_aliases") or {}).items():
            al = str(a).lower()
            if al in ba:
                aliases[name] = ba[al].get("address") or al
            else:
                aliases[name] = a
        hi["ens_aliases"] = aliases
        hi["collectors"] = collectors
        if "holders_index" in wallet:
            wallet["holders_index"] = hi
        else:
            wallet = {
                "generated_at": wallet.get("generated_at")
                or datetime.now(timezone.utc).isoformat(),
                "holders_index": hi,
            }
        save_json(WALLET_PATH, wallet)
        print(f"Patched base_name onto {patched} wallet_index holders (+ collectors list)")

    print(
        f"Done. resolved={resolved} skipped_cache={skipped} "
        f"with_base={found} errors={errors} index_size={len(by_address)}"
    )
    return 0 if errors < max(5, len(addresses) // 2) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)
    except Exception as e:
        print(f"Base-name enrich failed: {e}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        sys.exit(1)
