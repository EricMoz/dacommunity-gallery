"""daCommunity gallery — collection constants."""

COLLECTION_SLUG = "rodeo-posts-12142"
CONTRACT_ADDRESS = "0x64c30f84ed17e45e349b25c9dc02d7d2fd8081b1"
CHAIN = "base"
OPENSEA_BASE = "https://api.opensea.io/api/v2"
OPENSEA_COLLECTION_URL = "https://opensea.io/collection/rodeo-posts-12142"

# Rodeo decommissioned; collection migrated — contract address unchanged on Base
COLLECTION_NOTE = (
    "Originally minted on Rodeo. Contract unchanged after platform migration; "
    "collection stewarded via dacatdreams.eth."
)
CREATOR_ENS = "dacatdreams.eth"

# Rate limit: free tier ~60 reads/min
REQUEST_DELAY_SEC = 1.05