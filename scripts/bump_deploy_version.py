#!/usr/bin/env python3
"""
Bump web/VERSION.txt and propagate the build id across static assets.

Run before every GitHub Pages deploy (CI does this automatically) or locally:
  python scripts/bump_deploy_version.py

Updates cache-busting query strings (?v=…), sw.js CACHE name, BUILD.json,
and footer "Site build …" text so browsers and GitHub detect a real change.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
VERSION_FILE = WEB / "VERSION.txt"
BUILD_JSON = WEB / "BUILD.json"
SW_JS = WEB / "sw.js"

# HTML pages that reference styles.css or app.js with ?v=
HTML_GLOB = list(WEB.rglob("*.html"))


def read_current_version() -> str | None:
    if not VERSION_FILE.is_file():
        return None
    return VERSION_FILE.read_text(encoding="utf-8").strip() or None


def next_build_id() -> str:
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    prev = read_current_version()
    seq = 1
    if prev and prev.startswith(today + "-"):
        try:
            seq = int(prev.split("-", 1)[1]) + 1
        except ValueError:
            seq = 1
    return f"{today}-{seq}"


def replace_query_v(text: str, build: str) -> str:
    return re.sub(r"(\?v=)[0-9]{8}-[0-9]+", rf"\g<1>{build}", text)


def replace_site_build(text: str, build: str) -> str:
    text = re.sub(
        r'(name="site-build"\s+content=")[0-9]{8}-[0-9]+',
        rf"\g<1>{build}",
        text,
    )
    text = re.sub(
        r"(Site build\s+)[0-9]{8}-[0-9]+",
        rf"\g<1>{build}",
        text,
    )
    if "site-version" not in text and "site-footer" in text:
        text = text.replace(
            "</footer>",
            f'    <p class="site-version">Site build {build}</p>\n  </footer>',
            1,
        )
    if 'name="site-build"' not in text and "<head>" in text:
        text = text.replace(
            "<head>",
            f'<head>\n  <meta name="site-build" content="{build}" />',
            1,
        )
    return text


def bump_sw_cache(text: str, build: str) -> str:
    return re.sub(
        r'const CACHE = "dacat-gallery-v[^"]*";',
        f'const CACHE = "dacat-gallery-v{build}";',
        text,
        count=1,
    )


def main() -> None:
    build = next_build_id()
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    VERSION_FILE.write_text(build + "\n", encoding="utf-8")
    BUILD_JSON.write_text(
        json.dumps({"build": build, "generated_at": stamp}, indent=2) + "\n",
        encoding="utf-8",
    )

    if SW_JS.is_file():
        sw = SW_JS.read_text(encoding="utf-8")
        SW_JS.write_text(bump_sw_cache(sw, build), encoding="utf-8")

    for path in HTML_GLOB:
        raw = path.read_text(encoding="utf-8")
        updated = replace_query_v(raw, build)
        updated = replace_site_build(updated, build)
        if updated != raw:
            path.write_text(updated, encoding="utf-8")

    print(f"Deploy build bumped to {build}")


if __name__ == "__main__":
    main()