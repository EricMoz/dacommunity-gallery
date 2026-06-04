"""
Patch minted_at on existing gallery_data.json from OpenSea collection events.

Usage (from backend/):
  python backfill_mint_dates.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from fetch_gallery_data import build_mint_date_index, load_api_key
from opensea_client import OpenSeaClient

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "web" / "data" / "gallery_data.json"
ENV_PATH = Path(__file__).resolve().parent / ".env"


def main() -> int:
    load_dotenv(ENV_PATH)
    api_key = load_api_key(create_if_missing=False)
    client = OpenSeaClient(api_key)
    mint_dates = build_mint_date_index(client)

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    matched = 0
    for item in data.get("items", []):
        ts = mint_dates.get(str(item.get("token_id", "")))
        if ts:
            item["minted_at"] = ts
            matched += 1

    data["generated_at"] = datetime.now(timezone.utc).isoformat()
    DATA_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Patched minted_at on {matched}/{len(data.get('items', []))} items")

    import build_catalog

    build_catalog.main()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)