"""
Write web/data/gallery_meta.json — refresh health for the static site banner.

Updated by fetch_gallery_data.py (success) and CI (failure via --record-failure).
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
META_PATH = ROOT / "web" / "data" / "gallery_meta.json"

# OpenSea instant/dev keys expire ~30 days; long-lived dashboard keys: set rotation reminder.
DEFAULT_KEY_ROTATION_DAYS = 30
STALE_DATA_HOURS = 30


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_meta() -> dict:
    if META_PATH.is_file():
        return json.loads(META_PATH.read_text(encoding="utf-8"))
    return {}


def write_meta(payload: dict) -> None:
    META_PATH.parent.mkdir(parents=True, exist_ok=True)
    META_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def record_success(
    *,
    listed_count: int,
    piece_count: int,
    source: str = "fetch",
) -> None:
    data_generated = None
    data_path = ROOT / "web" / "data" / "gallery_data.json"
    if data_path.is_file():
        data_generated = json.loads(data_path.read_text(encoding="utf-8")).get(
            "generated_at"
        )
    write_meta(
        {
            "updated_at": _now(),
            "data_generated_at": data_generated,
            "listed_count": listed_count,
            "piece_count": piece_count,
            "refresh": {
                "status": "ok",
                "source": source,
                "finished_at": _now(),
                "error": None,
                "error_code": None,
            },
            "opensea_key": {
                "status": "ok",
                "checked_at": _now(),
                "rotation_reminder_days": DEFAULT_KEY_ROTATION_DAYS,
                "hint": (
                    "OpenSea API key auto-generated fresh each run via workflow "
                    "(no manual secret rotation needed). Instant keys last ~30 days; "
                    "fallback to repository secret if generation fails."
                ),
            },
        }
    )


def record_failure(
    error: str,
    *,
    error_code: str = "fetch_failed",
    source: str = "github_actions",
) -> None:
    prev = load_meta()
    last_ok = prev.get("data_generated_at") or prev.get("refresh", {}).get(
        "finished_at"
    )
    unauthorized = error_code in ("opensea_unauthorized", "missing_secret")
    write_meta(
        {
            "updated_at": _now(),
            "data_generated_at": last_ok,
            "listed_count": prev.get("listed_count"),
            "piece_count": prev.get("piece_count"),
            "refresh": {
                "status": "failed",
                "source": source,
                "finished_at": _now(),
                "error": error,
                "error_code": error_code,
            },
            "opensea_key": {
                "status": "expired_or_invalid" if unauthorized else "unknown",
                "checked_at": _now(),
                "rotation_reminder_days": DEFAULT_KEY_ROTATION_DAYS,
                "hint": _failure_hint(error_code, error),
            },
        }
    )


def _failure_hint(error_code: str, error: str) -> str:
    if error_code == "missing_secret":
        return (
            "Failed to auto-generate fresh OpenSea API key (workflow step) and no "
            "fallback repository secret was available. The daily refresh will now "
            "attempt to create a temporary key automatically each run."
        )
    if error_code == "opensea_unauthorized":
        return (
            "OpenSea rejected the API key (expired or invalid). The workflow now "
            "auto-generates a fresh temporary key each run via the public endpoint. "
            "If this persists, the fallback secret may need updating."
        )
    return error or "Daily refresh failed. Check the latest Actions run log."


def main() -> int:
    parser = argparse.ArgumentParser(description="Record gallery refresh health")
    parser.add_argument(
        "--record-failure",
        action="store_true",
        help="Write failure meta (CI when fetch step fails)",
    )
    parser.add_argument("--error", default="", help="Error message")
    parser.add_argument(
        "--error-code",
        default="fetch_failed",
        help="missing_secret | opensea_unauthorized | fetch_failed",
    )
    args = parser.parse_args()
    if args.record_failure:
        record_failure(
            args.error or "Unknown refresh error",
            error_code=args.error_code,
            source=os.getenv("GITHUB_ACTIONS") and "github_actions" or "local",
        )
        print(f"Wrote failure meta to {META_PATH}")
        return 0
    print("Nothing to do (use --record-failure).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())