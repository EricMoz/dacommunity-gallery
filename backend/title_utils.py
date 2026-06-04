"""
Display title normalization for daCommunity NFTs.

OpenSea often returns "Rodeo post #N"; we prefer dacat.xxx from the story
description line or name field. Used by fetch, merge, patch, and catalog build.
"""

from __future__ import annotations

import re

RODEO_NAME = re.compile(r"^rodeo\s+post\s+#\d+$", re.I)
DACAT_SLUG = re.compile(r"^dacat\.[a-z0-9_-]+$", re.I)
DACAT_IN_TEXT = re.compile(r"\bdacat\.([a-z0-9_-]+)\b", re.I)


def extract_slug(description: str | None, name: str | None = None) -> str | None:
    if description:
        first = description.strip().split("\n")[0].strip().lower()
        if first.startswith("dacat.") and DACAT_SLUG.match(first):
            return first
        m = DACAT_IN_TEXT.search(description)
        if m:
            return f"dacat.{m.group(1).lower()}"
    if name:
        n = name.strip().lower()
        if n.startswith("dacat.") and DACAT_SLUG.match(n):
            return n
    return None


def display_title(slug: str | None, name: str | None, token_id: str | None = None) -> str:
    if slug:
        return slug.lower()
    if name and not RODEO_NAME.match(name.strip()):
        n = name.strip()
        if n.lower().startswith("dacat."):
            return n.lower()
        return n
    if token_id:
        return f"dacat.token{token_id}"
    return "dacat.unknown"


def apply_item_titles(item: dict) -> dict:
    slug = extract_slug(item.get("description"), item.get("name"))
    item["local_slug"] = slug or item.get("local_slug")
    item["display_name"] = display_title(slug, item.get("name"), item.get("token_id"))
    if slug and item.get("name") and RODEO_NAME.match(str(item["name"]).strip()):
        item["opensea_name"] = item["name"]
        item["name"] = item["display_name"]
    elif slug and not item.get("name", "").lower().startswith("dacat."):
        item["opensea_name"] = item.get("name")
        item["name"] = item["display_name"]
    return item