#!/usr/bin/env bash
# Resolve an OpenSea API key for CI without manual monthly rotation.
#
# Lifecycle (default, secret-free):
#   1. Restore previously stored instant key from Actions cache (.ci/opensea_instant_key.json)
#   2. If it still has enough life left → reuse (do NOT mint; avoid 2-keys/day/IP limit)
#   3. Else mint via POST /api/v2/auth/keys → on success REPLACE the stored file
#   4. If mint fails (often HTTP 429) → fall back to stored key if any life remains
#
# Optional: OPENSEA_API_KEY_SECRET env (repo secret) short-circuits mint/cache for emergencies.
#
# Outputs (GITHUB_OUTPUT):
#   key=...          masked by caller via ::add-mask::
#   source=...       cache | minted | cache_stale_fallback | repo_secret
#   should_save=...  true when KEY_FILE should be written to Actions cache after verify
#
# Safety: never echoes the raw key. Stores only under KEY_FILE (gitignored .ci/).
set -euo pipefail

KEY_FILE="${KEY_FILE:-.ci/opensea_instant_key.json}"
# Prefer reusing until this many seconds remain (default 12h) so we mint before hard expiry
MIN_TTL_SECONDS="${MIN_TTL_SECONDS:-43200}"
# Absolute floor: never reuse if fewer than this many seconds left (default 30m)
HARD_MIN_TTL_SECONDS="${HARD_MIN_TTL_SECONDS:-1800}"
MAX_MINT_ATTEMPTS="${MAX_MINT_ATTEMPTS:-3}"
UA="${OPENSEA_UA:-dacommunity-gallery-refresh/1.2 (+https://github.com/EricMoz/dacommunity-gallery)}"

mkdir -p "$(dirname "$KEY_FILE")"
chmod 700 "$(dirname "$KEY_FILE")" 2>/dev/null || true

emit() {
  local key="$1"
  local source="$2"
  local should_save="${3:-false}"
  if [ -z "$key" ] || [ "$key" = "null" ]; then
    echo "::error::emit() called with empty key (source=$source)"
    return 1
  fi
  # Mask before any further log lines that might interpolate
  echo "::add-mask::$key"
  {
    echo "key=$key"
    echo "source=$source"
    echo "should_save=$should_save"
  } >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "OpenSea key resolved (source=$source, should_save=$should_save)."
}

seconds_until_expiry() {
  local expires_at="$1"
  local exp_epoch now_epoch
  exp_epoch=$(date -u -d "$expires_at" +%s 2>/dev/null || echo 0)
  now_epoch=$(date -u +%s)
  echo $((exp_epoch - now_epoch))
}

read_cached() {
  if [ ! -f "$KEY_FILE" ]; then
    return 1
  fi
  CACHED_KEY=$(jq -r '.api_key // empty' "$KEY_FILE" 2>/dev/null || true)
  EXPIRES_AT=$(jq -r '.expires_at // empty' "$KEY_FILE" 2>/dev/null || true)
  if [ -z "$CACHED_KEY" ]; then
    return 1
  fi
  return 0
}

# --- 0) Optional emergency secret (not required for normal daily ops) ---
if [ -n "${OPENSEA_API_KEY_SECRET:-}" ]; then
  echo "Using optional repository secret OPENSEA_API_KEY (emergency override)."
  emit "$OPENSEA_API_KEY_SECRET" "repo_secret" "false"
  exit 0
fi

# --- 1) Load store ---
CACHED_KEY=""
EXPIRES_AT=""
if read_cached; then
  LEFT=$(seconds_until_expiry "$EXPIRES_AT")
  echo "Found stored instant key (expires_at=${EXPIRES_AT:-unknown}, seconds_left=$LEFT)."
  if [ "$LEFT" -gt "$MIN_TTL_SECONDS" ]; then
    # Still healthy: reuse and re-warm Actions cache so the entry is not evicted from disuse
    emit "$CACHED_KEY" "cache" "true"
    exit 0
  fi
  if [ "$LEFT" -gt "$HARD_MIN_TTL_SECONDS" ]; then
    echo "Stored key is inside renew window; will try mint to replace, with stale store as fallback."
  else
    echo "Stored key is expired or nearly expired; mint required."
    CACHED_KEY=""
  fi
else
  echo "No stored OpenSea key yet — will mint and create the store."
fi

# --- 2) Mint (replace store on success) ---
attempt=1
while [ "$attempt" -le "$MAX_MINT_ATTEMPTS" ]; do
  echo "Minting instant OpenSea key (attempt $attempt/$MAX_MINT_ATTEMPTS)..."
  HTTP_CODE=$(curl -sS -o /tmp/opensea_key.json -w "%{http_code}" \
    -X POST "https://api.opensea.io/api/v2/auth/keys" \
    -H "Accept: application/json" \
    -H "User-Agent: $UA" \
    --max-time 45 || echo "000")
  KEY=$(jq -r '.api_key // empty' /tmp/opensea_key.json 2>/dev/null || true)
  ERR=$(jq -r '(.errors[0] // .error // empty)|tostring' /tmp/opensea_key.json 2>/dev/null || true)

  if { [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; } && [ -n "$KEY" ]; then
    # Replace stored key atomically
    cp /tmp/opensea_key.json "$KEY_FILE"
    chmod 600 "$KEY_FILE" 2>/dev/null || true
    NEW_EXP=$(jq -r '.expires_at // empty' "$KEY_FILE")
    echo "Mint succeeded; stored key replaced (expires_at=${NEW_EXP:-unknown})."
    emit "$KEY" "minted" "true"
    exit 0
  fi

  # Log without secrets (body is error JSON only on failure)
  echo "::warning::Mint failed HTTP=$HTTP_CODE err=${ERR:-none} body=$(head -c 300 /tmp/opensea_key.json 2>/dev/null || true)"

  if [ "$HTTP_CODE" = "429" ]; then
    # Quota exhausted on this IP — further attempts same run rarely help
    break
  fi
  sleep $((attempt * 12))
  attempt=$((attempt + 1))
done

# --- 3) Fall back to store if mint failed ---
if [ -n "${CACHED_KEY:-}" ]; then
  LEFT=$(seconds_until_expiry "${EXPIRES_AT:-1970-01-01T00:00:00Z}")
  if [ "$LEFT" -gt "$HARD_MIN_TTL_SECONDS" ]; then
    echo "::warning::Mint unavailable; reusing stored key until expiry (seconds_left=$LEFT)."
    emit "$CACHED_KEY" "cache_stale_fallback" "true"
    exit 0
  fi
fi

# Re-read file in case LEFT window cleared CACHED_KEY but file still has usable life
if read_cached; then
  LEFT=$(seconds_until_expiry "$EXPIRES_AT")
  if [ "$LEFT" -gt 0 ]; then
    echo "::warning::Using last-resort stored key with $LEFT seconds left."
    emit "$CACHED_KEY" "cache_stale_fallback" "true"
    exit 0
  fi
fi

echo "::error::Could not resolve OpenSea API key. Instant mint is rate-limited (~2 keys/day/IP on shared GitHub runners). After one successful mint, the key is stored in Actions cache and reused automatically until near expiry, then replaced on the next successful mint. Re-run this workflow later (new runner IP or quota reset), or set temporary secret OPENSEA_API_KEY as a one-time bridge."
exit 1
