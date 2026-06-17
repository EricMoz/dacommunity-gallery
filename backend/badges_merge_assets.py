"""
ASSET / IMAGE MERGE SCRIPT FOR BADGES (LFS-friendly plan)

This mirrors backend/merge_local_images.py but is scoped to badges and optimized.

DO NOT RUN / DOWNLOAD YET - this is the mapped plan per user request.
User will give OK after reviewing first data load Excel/JSON.

Key requirements from mapping:
- Initial batch: one-time for current creations by the wallet.
- Ongoing: ONLY trigger on new NFT created by the wallet (detected in fetch_badges.py --sync or by comparing proposed vs live).
- 1:1s: store individually (unique files).
- Copies / series (e.g. Rookie Card 333 supply, or non-personalized): reuse the same local asset if the image is identical (detect by OpenSea image_url hash or file hash).
- Video support: e.g. the newer DACAT GEM - NOVA GREEN is a video. Store .mp4 (or animation_url) + optional poster. Set media_type=video.
- Bandwidth/LFS: deltas only. Hash/skip if file already exists with same size. Use Git LFS for large assets/videos.
- Storage: web/assets/badges/ (new dedicated folder, consistent with web/assets/nfts/).
- After merge: patch the badges_data.json (or proposed) so image_url / animation_url point to local "assets/badges/..." and media_type is correct.
- This script will be called from refresh process or manually after fetch_badges.py when new items exist.

How it will work (plan):
1. Input: path to proposed or live badges_data.json (rich items).
2. For each item:
   - If unclaimed_or_available or new: download from item['image_url'] or 'animation_url' if video.
   - Naming: badges/{award_category}-{token_id or slug}.{ext} for 1:1s.
     For series/copies: try to reuse existing file for that source_created_collection + base image.
   - Skip if local file exists and size matches (no re-download).
   - Special for video: download video, also fetch a poster frame if possible or use first frame logic later.
3. Patch the item in memory: image_url = f"assets/badges/{filename}", media_type = ...
4. Write updated JSON (or sidecar).
5. Git note: after initial batch, user runs git add + git lfs track "web/assets/badges/*.mp4" etc. if videos are large.

LFS optimization:
- Only new creations cause downloads.
- Hash check prevents re-downloads of same asset.
- 1:1s will accumulate over time (cost), but series reuse keeps it low.
- Future: could add --dry-run or --max-size to control.

When user says "go" for assets on the first data load:
- We will run this (or enhance it) against the approved JSON.
- Do not call download logic until then.

Current status: skeleton + full plan documented. Ready for implementation once approved.
"""

from __future__ import annotations

import json
from pathlib import Path

# TODO (after approval): implement actual download + patch logic here
# using requests, similar to main merge_local_images.py
# Add support for video (animation_url), hash-based reuse for copies,
# delta detection from fetch_badges.py output, LFS-friendly naming.

def main():
    print("badges_merge_assets.py - PLAN ONLY (no downloads executed).")
    print("See docstring and the Excel mapping sheet 'Asset_Image_Plan_No_Download'.")
    print("Run only after user approval of first data load and explicit OK to pull assets.")

if __name__ == "__main__":
    main()
