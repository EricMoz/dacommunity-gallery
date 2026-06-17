import json
import re
import os

for fn in ["web/data/badges_catalog.json", "web/data/badges_data.json"]:
    if not os.path.exists(fn):
        continue
    d = json.load(open(fn, encoding="utf-8"))
    items = d.get("items", [])
    changed = 0
    for it in items:
        dn = (it.get("display_name") or it.get("name") or "")
        if re.match(r"^[A-Z0-9 ._-]+ - ", dn, re.I) and ("TRILLION" in dn.upper() or "BILLION" in dn.upper()):
            base = re.sub(r"^[A-Z0-9 ._-]+ - ", "", dn, flags=re.I).strip()
            if base and base != dn:
                it["display_name"] = base
                it["name"] = base
                changed += 1
        if not it.get("minted_at"):
            it["minted_at"] = "2026-06-15T12:00:00+00:00"
    json.dump(d, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print("patched", fn, len(items), "items,", changed, "names cleaned")
print("done")