"""
Verify a token's recent_activity includes expected transfers (CI / manual QA).

Usage:
  cd backend && python ../scripts/verify_piece_activity.py --token 47
  python ../scripts/verify_piece_activity.py --token 47 --expect-from mozvane.eth --expect-to 0x3e43287...
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data" / "gallery_data.json"
WALLET = ROOT / "web" / "data" / "wallet_index.json"


def resolve_ens(name: str, aliases: dict) -> str | None:
    key = name.strip().lower()
    if key in aliases:
        return aliases[key].lower()
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify gallery JSON activity for a token")
    parser.add_argument("--token", required=True, help="Token id, e.g. 47")
    parser.add_argument("--expect-from", help="ENS or 0x sender of latest transfer")
    parser.add_argument("--expect-to", help="ENS or 0x recipient of latest transfer")
    args = parser.parse_args()

    if not DATA.is_file():
        print(f"Missing {DATA} — run: cd backend && python fetch_gallery_data.py")
        return 1

    data = json.loads(DATA.read_text(encoding="utf-8"))
    item = next((i for i in data["items"] if str(i["token_id"]) == str(args.token)), None)
    if not item:
        print(f"Token {args.token} not in gallery_data.json")
        return 1

    activity = item.get("recent_activity") or []
    transfers = [a for a in activity if a.get("type") == "transfer"]
    print(f"Token #{args.token} ({item.get('display_name')}) — {len(activity)} activity rows, {len(transfers)} transfers")

    aliases = {}
    if WALLET.is_file():
        wi = json.loads(WALLET.read_text(encoding="utf-8"))
        aliases = (wi.get("holders_index") or {}).get("ens_aliases") or {}

    owners = item.get("owners") or {}
    latest = owners.get("latest_change")
    if latest:
        print(
            f"  latest_change: {latest.get('type')} @ {latest.get('at')}: "
            f"{latest.get('from')} → {latest.get('to')}"
        )
    else:
        print("  WARNING: owners.latest_change missing — run: cd backend && python enrich_gallery_json.py")

    if activity:
        for row in activity[:5]:
            print(f"  {row.get('type')} @ {row.get('at')}: {row.get('from')} → {row.get('to')} (×{row.get('quantity', 1)})")
    else:
        print("  WARNING: no recent_activity on item — re-run full fetch")

    holders = owners.get("holders") or []
    if args.expect_to:
        want = resolve_ens(args.expect_to.strip(), aliases) or args.expect_to.strip().lower()
        if not any((h.get("address") or "").lower() == want for h in holders):
            print(f"FAIL: {want!r} not in owners.holders ({len(holders)} wallets)")
            return 1
        print(f"OK: {want!r} listed as current holder")

    if args.expect_from or args.expect_to:
        if not transfers:
            print("FAIL: no transfer rows to match")
            return 1
        latest = transfers[0]
        exp_from = (args.expect_from or "").strip()
        exp_to = (args.expect_to or "").strip()
        if exp_from:
            want = resolve_ens(exp_from, aliases) or exp_from.lower()
            got = (latest.get("from") or "").lower()
            if got != want:
                print(f"FAIL: latest transfer from {got!r}, expected {want!r}")
                return 1
        if exp_to:
            want = resolve_ens(exp_to, aliases) or exp_to.lower()
            got = (latest.get("to") or "").lower()
            if got != want:
                print(f"FAIL: latest transfer to {got!r}, expected {want!r}")
                return 1
        print("OK: latest transfer matches expectations")

    holders = (item.get("owners") or {}).get("holders") or []
    print(f"Holders indexed: {len(holders)} (UI must not rely on top_holders only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())