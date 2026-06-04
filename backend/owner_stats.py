"""Owner/activity helpers with no third-party deps (safe for CI deploy verify)."""

from __future__ import annotations


def dedupe_activity_rows(rows: list[dict]) -> list[dict]:
    """OpenSea often emits duplicate ERC-1155 rows for the same on-chain event."""
    seen: set[tuple] = set()
    out: list[dict] = []
    for row in rows:
        key = (
            row.get("type"),
            row.get("at"),
            (row.get("from") or "").lower() if row.get("from") else None,
            (row.get("to") or "").lower() if row.get("to") else None,
            int(row.get("quantity") or 1),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def enrich_owner_stats(
    owner_stats: dict | None, recent_activity: list[dict] | None
) -> dict | None:
    """
    Attach latest on-chain change for the detail panel (current holders come from
    get_nft_owners; activity explains the most recent move).
    """
    if not owner_stats:
        return owner_stats
    if not recent_activity:
        return owner_stats
    rows = dedupe_activity_rows(recent_activity)
    latest = rows[0] if rows else None
    if not latest:
        return owner_stats
    owner_stats = dict(owner_stats)
    owner_stats["latest_change"] = {
        "type": latest.get("type"),
        "at": latest.get("at"),
        "from": latest.get("from"),
        "to": latest.get("to"),
        "quantity": int(latest.get("quantity") or 1),
    }
    return owner_stats