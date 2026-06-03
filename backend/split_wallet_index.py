"""One-time: move holders_index out of gallery_data.json into wallet_index.json."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data" / "gallery_data.json"
WALLET = ROOT / "web" / "data" / "wallet_index.json"

data = json.loads(DATA.read_text(encoding="utf-8"))
hi = data.pop("holders_index", None)
if hi:
    slim = {"ens_aliases": hi.get("ens_aliases", {}), "by_address": {}}
    for addr, entry in hi.get("by_address", {}).items():
        slim["by_address"][addr] = {
            "address": entry["address"],
            "ens_name": entry.get("ens_name"),
            "username": entry.get("username"),
            "collection_quantity": entry.get("collection_quantity"),
            "unique_pieces": entry.get("unique_pieces"),
            "holdings": [
                {"token_id": h["token_id"], "name": h.get("name")}
                for h in entry.get("holdings", [])
            ],
        }
    WALLET.write_text(
        json.dumps(
            {"generated_at": data.get("generated_at"), "holders_index": slim},
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    data["wallet_index_file"] = "wallet_index.json"
    DATA.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Split wallet index — gallery now {(DATA.stat().st_size)/1024:.0f} KB")
else:
    print("No holders_index in gallery_data.json")