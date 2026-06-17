import json

CONTRACT_MAP = {
    "dacatrookie2026": "0x776160fee93ea8727b2c2db360599f33977e93f1",
    "dacat1trillionclub": "0x0b5be1e2b68467afa8c371576f47b27e50f2b14f",
    "dacat5trillion": "0x1276d1e11aa5d2cc0854b936477f4d3bc88a5df1",
}

for fn in ["web/data/badges_catalog.json", "web/data/badges_data.json"]:
    d = json.load(open(fn, encoding="utf-8"))
    for it in d.get("items", []):
        slug = it.get("source_created_collection") or ""
        tid = it.get("token_id")
        contract = CONTRACT_MAP.get(slug)
        if contract and tid:
            it["opensea_url"] = f"https://opensea.io/item/ethereum/{contract}/{tid}"
    json.dump(d, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print("updated opensea urls in", fn)
print("done")