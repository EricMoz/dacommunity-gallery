/**
 * daCommunity Gallery core JS (vanilla, static).
 * Powers: gallery browse (search/filters/sort/grid), ?wallet= collector view,
 * ?collection= multi-col support, detail/activity, URL share.
 *
 * Boot: initDataUrls -> loadCatalogFirst -> bootGallery -> background enrich + wallet/collections.
 * Client state only; ?params for deep links/share.
 * No wallet connect needed.
 */

/* === Film ↔ NFT deep links (static; survives OpenSea badge refresh) === */
/** Piece local_slug → film hub player. Inverse of videos.json relatedNft. */
var RELATED_FILM_BY_PIECE_SLUG = {
  "dacat-world-collector-cat": {
    href: "../film/?v=dacatworld-collector-cat",
    label: "Watch Collector Cat teaser"
  }
};

function relatedFilmForItem(item) {
  if (!item) return null;
  var slug = (item.local_slug || "").toLowerCase();
  if (slug && RELATED_FILM_BY_PIECE_SLUG[slug]) return RELATED_FILM_BY_PIECE_SLUG[slug];
  return null;
}

/* === Data URL Resolution & Build Stamp (cache busting) === */
/** Parent path prefix when gallery is not at site root (e.g. /dacommunity/). */
function getDataPrefix() {
  var body = document.body;
  if (body) {
    var attr = body.getAttribute("data-base");
    if (attr) return attr;
  }
  var path = window.location.pathname || "";
  if (path.indexOf("/dacommunity") !== -1) return "../";
  return "";
}

/** Current build stamp from <meta name="site-build"> (injected by bump_deploy_version.py on deploy).
 *  Used for strong cache-busting of all dynamic JSON data files so GitHub Pages / browser / SW
 *  never serve stale gallery_*.json or wallet_index after a data refresh + deploy.
 */
function getBuildStamp() {
  try {
    var meta = document.querySelector('meta[name="site-build"]');
    if (meta && meta.getAttribute("content")) {
      return meta.getAttribute("content");
    }
  } catch (e) {}
  // Fallback (file: protocol or missing meta) — short time-based token so we don't hammer caches in dev.
  return "dev-" + Math.floor(Date.now() / 1000).toString(36);
}

let CATALOG_URL = "";
let FULL_DATA_URL = "";
let WALLET_URL = "";
let META_URL = "";
let REGISTRY_URL = "";
let galleryMeta = null;
function initDataUrls() {
  var prefix = getDataPrefix();
  var stamp = getBuildStamp();
  // Always append the deploy build stamp. This makes every data fetch URL unique per release
  // (e.g. /data/gallery_data.json?v=20260610-5), busting GitHub Pages CDN, browser HTTP cache,
  // and the SW's per-URL cache for the four dynamic JSONs. The stamp is the same one used
  // for the HTML/CSS/JS ?v= links and the footer "Site build" text.
  var q = "?v=" + stamp;
  CATALOG_URL = prefix + "data/gallery_catalog.json" + q;
  FULL_DATA_URL = prefix + "data/gallery_data.json" + q;
  WALLET_URL = prefix + "data/wallet_index.json" + q;
  META_URL = prefix + "data/gallery_meta.json" + q;
  REGISTRY_URL = prefix + "data/collections_registry.json" + q;
}

const $ = (sel, root = document) => root.querySelector(sel);

/* === Global State (single source of truth for browse + collector modes) === */
let galleryData = null;
let walletIndex = null;
let collectorsList = [];
let itemsById = new Map();
/** Browse view — single source of truth for search / filter / sort. */
let activeFilter = "all";
let searchQuery = "";
let sortKey = "token_desc";
let dataSource = "catalog";
/** catalog | loading_full | live | error */
let fullDataStatus = "catalog";
let activeCollectorAddress = null;
/** When set, main gallery grid shows only this collector's holdings. */
let galleryCollectorView = null;

let originalHeroTitle = null;
let originalHeroLead = null;
/** Token id when detail drawer is open — refresh holders/activity after background merge. */
let activeDetailTokenId = null;
let activeCollection = "all";

function getItemKey(item) {
  if (!item) return "";
  // Badges multi-slug 1:1s
  if (item.source_created_collection) {
    return item.source_created_collection + "-" + item.token_id;
  }
  // Secondary collections (BIG KIX, etc.) — avoid token_id collisions with daCommunity
  var cid = item.collection_id || "dacommunity";
  if (cid && cid !== "dacommunity" && cid !== "all") {
    return cid + "-" + item.token_id;
  }
  return String(item.token_id);
}

/** daGATO Agency rarity-tier row (browse grid shows these 5 only). */
function isAgencyRaritySeries(item) {
  return !!(item && (item.agency_rarity_series || (item.collection_id === "dagato-agency" && item.is_series_rep)));
}

/** Case-file edition (collector wallet) — hide from light browse when series exist. */
function isAgencyEditionToken(item) {
  if (!item || (item.collection_id || "") !== "dagato-agency") return false;
  if (isAgencyRaritySeries(item)) return false;
  return !!(item.is_edition_token || item.rarity);
}

/** Pill label: rank 1–5 for agency series; real token # for editions. */
function itemTokenPillLabel(item) {
  if (!item) return "";
  if (item.token_rank != null && isAgencyRaritySeries(item)) return String(item.token_rank);
  return String(item.token_id);
}

/** Max collection rank pills next to wallet name (escape bar + profile). */
var MAX_COLLECTOR_RANK_BADGES = 5;

/** Quantity held for this address on an item (ERC-1155 multi-copy aware). */
function holderQuantityForAddress(item, address) {
  var addr = (address || "").toLowerCase();
  if (!addr || !item) return 0;
  var list = (item.owners && (item.owners.holders || item.owners.top_holders)) || [];
  for (var i = 0; i < list.length; i++) {
    if ((list[i].address || "").toLowerCase() === addr) {
      var q = Number(list[i].quantity);
      return !isNaN(q) && q > 0 ? q : 1;
    }
  }
  return 0;
}

/** unique_pieces + collection_quantity from holdings rows (qty defaults to 1). */
function summarizeHoldingsStats(holdings) {
  var unique = 0;
  var qty = 0;
  (holdings || []).forEach(function (h) {
    unique += 1;
    var q = Number(h.quantity);
    qty += !isNaN(q) && q > 0 ? q : 1;
  });
  return { unique_pieces: unique, collection_quantity: qty };
}

/* Browse labels (used for chips + resets). Extended for multi-col in Part 1. */
var FILTER_LABELS = {
  all: "All",
  listed: "For sale",
  not_listed: "Not listed",
  activity: "Recent Transfers",
};

var SORT_LABELS = {
  token_desc: "Newest",
  token_asc: "Oldest",
  price_asc: "Price: Low to High",
  price_desc: "Price: High to Low",
  transfer_desc: "Recently Transferred",
};

let collectionsRegistry = null;

function getLiveCollections() {
  if (!collectionsRegistry || !collectionsRegistry.collections) {
    return [{ id: "dacommunity", name: "daCommunity NFT Archive", status: "live" }];
  }
  return collectionsRegistry.collections.filter(function (c) {
    return c.status === "live";
  });
}

function getCollectionName(id) {
  if (!id || id === "all") return "All collections";
  var list = (collectionsRegistry && collectionsRegistry.collections) || [];
  var found = list.find(function (c) { return c.id === id; });
  return found ? found.name : id;
}

/** Return per-collection catalog/full data URLs (with current prefix + build stamp) when the
 *  registry entry for a live collection specifies its own data files (e.g. badges_*).
 *  Returns null for the primary daCommunity / "all" so the default gallery_* URLs are used.
 */
function getCollectionDataUrls(colId) {
  if (!colId || colId === "all" || colId === "dacommunity") return null;
  var list = (collectionsRegistry && collectionsRegistry.collections) || [];
  var col = list.find(function (c) { return c.id === colId; });
  if (!col || !col.data) return null;
  var prefix = getDataPrefix();
  var stamp = getBuildStamp();
  var q = "?v=" + stamp;
  return {
    catalog: prefix + "data/" + (col.data.catalog || "gallery_catalog.json") + q,
    full: prefix + "data/" + (col.data.gallery || "gallery_data.json") + q
  };
}

/** Merge live secondary collections (badges, BIG KIX, …) into galleryData for "All". */
async function mergeSecondaryCatalogsIntoGallery() {
  if (!galleryData) return;
  var list = getLiveCollections();
  var prefix = getDataPrefix();
  var stamp = getBuildStamp();
  var q = "?v=" + stamp;
  var have = {};
  (galleryData.items || []).forEach(function (ii) {
    have[getItemKey(ii)] = true;
  });
  for (var i = 0; i < list.length; i++) {
    var col = list[i];
    if (!col || !col.id || col.id === "dacommunity") continue;
    if (!col.data || !col.data.catalog) continue;
    try {
      var url = prefix + "data/" + col.data.catalog + q;
      var res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      var data = await res.json();
      if (!data || !data.items || !data.items.length) continue;
      data.items.forEach(function (item) {
        if (!item.collection_id) item.collection_id = col.id;
        var k = getItemKey(item);
        if (!have[k]) {
          galleryData.items.push(item);
          have[k] = true;
        }
      });
    } catch (e) {
      console.warn("Could not merge catalog for " + col.id, e);
    }
  }
  indexItems(galleryData);
}

function getCurrentCollection() {
  if (!collectionsRegistry || !activeCollection || activeCollection === "all") return null;
  var list = (collectionsRegistry && collectionsRegistry.collections) || [];
  return list.find(function (c) { return c.id === activeCollection; }) || null;
}

function applyCollectionUI() {
  var col = getCurrentCollection();
  var hasWallet = !col || (col.features || []).indexOf("wallet_lookup") !== -1;
  var walletLookup = $("#wallet-lookup");
  if (walletLookup) {
    walletLookup.style.display = hasWallet ? "" : "none";
  }
  if (!hasWallet) {
    clearGalleryCollectorView({ clearResult: true });
    if (typeof collectorsList !== "undefined") {
      collectorsList = [];
    }
    var btn = $("#view-collectors-btn");
    if (btn) btn.hidden = true;
  }
}

/** Light adaptation so the host gallery page feels like the selected collection
 *  without inventing a whole new page. Touches hero when badges / BIG KIX / etc.
 */
function adaptHeaderForCollection() {
  var isBadges = activeCollection === "badges";
  var isBigKix = activeCollection === "bigkix";
  var isAgency = activeCollection === "dagato-agency";
  document.body.classList.toggle("is-badges-view", isBadges);
  document.body.classList.toggle("is-bigkix-view", isBigKix);
  document.body.classList.toggle("is-dagato-agency-view", isAgency);
  try {
    var h1 = document.querySelector(".hero-band h1");
    var lead = document.querySelector(".hero-lead");
    if (!h1 || !lead) return;
    if (typeof originalHeroTitle === "undefined" || originalHeroTitle === null) {
      originalHeroTitle = h1.innerHTML;
      originalHeroLead = lead.textContent;
    }
    if (isBadges) {
      h1.innerHTML = 'daCAT <span class="accent">Badges</span>';
      lead.textContent = "Personal 1:1 awards. Series images shown in the grid (generic photos to keep discovery clean, no 1:1 dupes). Your specific named copy appears in the collector wallet lookup when you hold it.";
    } else if (isBigKix) {
      h1.innerHTML = 'BIG <span class="accent">KIX</span>';
      lead.textContent =
        "Ridiculously BIG sneakers and original DACAT WORLD characters. Collect what you love, connect with fellow fans and creators, and enjoy a collector-first experience where every mint matters.";
    } else if (isAgency) {
      h1.innerHTML = 'daGATO <span class="accent">Detective Agency</span>';
      lead.textContent =
        "Enter the shadows of Cyber City. Volume 1 case files span distinctive detective identities, cyber-noir environments, and rarity tiers — from Common operatives to legendary 1:1 creations. The city hides the truth. daGATO finds it. Stealth. Style. Supremacy.";
    } else {
      h1.innerHTML = originalHeroTitle || h1.innerHTML;
      lead.textContent = originalHeroLead || lead.textContent;
    }
  } catch (e) {}
}

function isFileProtocol() {
  return window.location.protocol === "file:";
}

function nvl(value, fallback) {
  return value !== undefined && value !== null ? value : fallback;
}

function showFatalError(title, detail, cmd) {
  $("#load-state").hidden = true;
  var strip = $("#stats-strip");
  if (strip) strip.innerHTML = "";
  const err = $("#load-error");
  err.hidden = false;
  err.innerHTML =
    "<p><strong>" + escapeHtml(title) + "</strong></p><p>" + escapeHtml(detail) + "</p>" +
    (cmd ? "<code>" + escapeHtml(cmd) + "</code>" : "");
}

function showStaleBanner(message, level) {
  let el = $("#data-stale-banner");
  if (!el) {
    el = document.createElement("p");
    el.id = "data-stale-banner";
    el.className = "hero-note";
    const hero = document.querySelector(".hero-inner");
    if (hero) hero.appendChild(el);
  }
  el.textContent = message;
  el.className = "hero-note" + (level === "error" ? " hero-note-error" : level === "warn" ? " hero-note-warn" : "");
  el.hidden = false;
}

function hideStaleBanner() {
  const banner = $("#data-stale-banner");
  if (banner) banner.hidden = true;
}

function hoursSince(iso) {
  if (!iso) return null;
  var t = Date.parse(iso);
  if (isNaN(t)) return null;
  return (Date.now() - t) / 3600000;
}

function dataTimestampIso() {
  if (galleryMeta && galleryMeta.data_generated_at) return galleryMeta.data_generated_at;
  if (galleryData && galleryData.generated_at) return galleryData.generated_at;
  return null;
}

function formatDataUpdated(iso) {
  if (!iso) return "—";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function setFullDataStatus(status) {
  fullDataStatus = status;
  var mergeEl = $("#merge-status");
  var freshness = $("#data-freshness");
  var list = $("#gallery-list");
  if (mergeEl) {
    if (status === "loading_full") {
      mergeEl.hidden = false;
      mergeEl.classList.remove("is-done");
      mergeEl.textContent = "Pulling full stories & transfer trails into the archive…";
    } else if (status === "live") {
      mergeEl.textContent = "Full archive loaded. Stories and activity match this snapshot.";
      mergeEl.classList.add("is-done");
      setTimeout(function () {
        if (fullDataStatus === "live") mergeEl.hidden = true;
      }, 3200);
    } else if (status === "error") {
      mergeEl.hidden = false;
      mergeEl.classList.remove("is-done");
      mergeEl.textContent = "Could not load full details. Excerpts from the catalog are still visible.";
    } else {
      mergeEl.hidden = true;
    }
  }
  if (freshness) {
    freshness.classList.toggle("is-loading", status === "loading_full");
  }
  if (list) list.setAttribute("aria-busy", status === "loading_full" ? "true" : "false");
}

function renderDataFreshness() {
  var iso = dataTimestampIso();
  var timeEl = $("#data-freshness-time");
  var freshness = $("#data-freshness");
  if (timeEl) {
    timeEl.textContent = formatDataUpdated(iso);
    timeEl.setAttribute("datetime", iso || "");
  }
  if (freshness && iso) {
    var ageH = hoursSince(iso);
    freshness.classList.toggle("is-stale", ageH !== null && ageH > 30);
  }
  var footer = $("#footer-updated");
  if (footer && iso) footer.textContent = formatDataUpdated(iso);

  // Dynamically update the hint to emphasize the actual last_updated timestamp (from gallery_meta.json
  // data_generated_at) while keeping the static explanatory text. Previously the hint was purely static.
  var hintEl = document.getElementById("data-freshness-hint");
  if (hintEl) {
    hintEl.textContent = `Refreshed daily from OpenSea (last data pull: ${formatDataUpdated(iso) || '—'}). Not live on-chain. Full stories and transfers appear after the first load.`;
  }
}

function bindFreshnessToggle() {
  var btn = $("#data-freshness-toggle");
  var detail = $("#data-freshness-detail");
  if (!btn || !detail || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", function () {
    var open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    detail.hidden = open;
  });
}

function applyGalleryMeta(meta) {
  galleryMeta = meta;
  if (!meta) return;
  var refresh = meta.refresh || {};
  var key = meta.opensea_key || {};
  var dataAt = meta.data_generated_at || galleryData.generated_at;
  var ageH = hoursSince(dataAt);

  if (refresh.status === "failed") {
    var hint = (key.hint || refresh.error || "Daily OpenSea refresh failed.").trim();
    showStaleBanner(hint, "error");
    return;
  }
  if (key.status === "expired_or_invalid") {
    showStaleBanner(key.hint || "OpenSea API key needs renewal.", "error");
    return;
  }
  if (ageH !== null && ageH > 30) {
    showStaleBanner(
      "Gallery data is about " +
        Math.round(ageH) +
        " hours old. Listings and transfers may be outdated until the daily refresh succeeds (check GitHub Actions).",
      "warn"
    );
  }
}

function updateFooterMaintenance(meta) {
  var footer = document.querySelector(".site-footer p");
  if (!footer || !meta) return;
  var base = "OpenSea ownership & listings · Refreshed daily · Updated ";
  var span = $("#footer-updated");
  var updated = span && span.textContent !== "—" ? span.textContent : "—";
  var extra = "";
  if (meta.refresh && meta.refresh.status === "failed") {
    extra = " · refresh failed (check GitHub Actions for key generation step)";
  }
  // Intentionally omit internal key-rotation / fallback-secret notes from production footer.
  footer.innerHTML = base + '<span id="footer-updated">' + escapeHtml(updated) + "</span>" + escapeHtml(extra);
}

async function loadGalleryMeta() {
  if (isFileProtocol()) return;
  try {
    galleryMeta = await fetchJson(META_URL, 8000);
    applyGalleryMeta(galleryMeta);
    // Force the "last updated" / data-freshness banner (and footer) to always reflect the
    // authoritative data_generated_at from gallery_meta.json (the real pull timestamp),
    // not a potentially stale generated_at that may have been embedded in the catalog/full JSON.
    renderDataFreshness();
    updateFooterMaintenance(galleryMeta);
  } catch (e) {
    console.warn("gallery_meta.json not loaded:", e);
  }
}

function pieceSlug(item) {
  return (item.local_slug || item.name || "").toLowerCase();
}

function findItemBySlug(slug) {
  if (!slug || !galleryData) return null;
  var q = slug.trim().toLowerCase();
  for (var i = 0; i < galleryData.items.length; i++) {
    var it = galleryData.items[i];
    if (pieceSlug(it) === q || String(it.token_id) === q) return it;
  }
  return null;
}

function parsePieceFromUrl() {
  return (new URLSearchParams(window.location.search).get("piece") || "").trim();
}

function applyPieceFromUrl() {
  var slug = parsePieceFromUrl();
  if (!slug) return;
  var item = findItemBySlug(slug);
  if (item) {
    openDetail(item);
    return;
  }
  var search = $("#search");
  if (search) {
    search.value = slug;
    searchQuery = slug;
    refreshView();
  }
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  try {
    // Strong no-store for our dynamic data JSONs (gallery_* and wallet_index) so that
    // after a manual or daily refresh-data workflow updates the files in the repo + deploy,
    // the browser always gets the absolute latest bytes from the server (bypassing any
    // HTTP/browser cache). The ?v=BUILD stamp (from meta) still provides build-coherent
    // long-term caching keys per release, and the SW network-first layer provides offline.
    const isOurData = /\/data\/(gallery_(data|meta|catalog|wallet_index)|videos|badges_(data|catalog)|bigkix_(data|catalog)|dagato_agency_(data|catalog)|collections_registry)\.json(\?|$)/i.test(url);
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: isOurData ? "no-store" : "default"
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function indexItems(data) {
  itemsById.clear();
  (data.items || []).forEach(function (i) {
    if (!i.display_name) {
      i.display_name = i.local_slug || (i.name && i.name.toLowerCase().indexOf("dacat.") === 0 ? i.name : null);
    }
    if (!i.opensea_image_url && i.image_url && i.image_url.indexOf("http") === 0) {
      i.opensea_image_url = i.image_url;
    }
    if (/\.(mov|mp4|webm)(\?|$)/i.test(i.image_url || "") && !i.media_type) {
      i.media_type = "video";
    }
    itemsById.set(getItemKey(i), i);
  });
}

function mergeFullDescriptions(full) {
  if (!full || !full.items) return;
  full.items.forEach(function (fullItem) {
    const cur = itemsById.get(getItemKey(fullItem));
    if (!cur) return;
    if (fullItem.description) cur.description = fullItem.description;
    if (fullItem.excerpt) cur.excerpt = fullItem.excerpt;
    if (fullItem.owners) cur.owners = fullItem.owners;
    if (fullItem.recent_activity) cur.recent_activity = fullItem.recent_activity;
    if (fullItem.listed !== undefined) cur.listed = fullItem.listed;
    if (fullItem.listing) cur.listing = fullItem.listing;
    if (fullItem.minted_at) cur.minted_at = fullItem.minted_at;
    if (fullItem.generated_at) galleryData.generated_at = full.generated_at;
  });
  dataSource = "live";
  setFullDataStatus("live");
  hideStaleBanner();
  renderDataFreshness();
  if (galleryMeta) applyGalleryMeta(galleryMeta);
  renderStats(galleryData.collection);
  refreshView();
  if (activeDetailTokenId) {
    var openItem = itemsById.get(activeDetailTokenId);
    if (openItem) refreshDetailPanel(openItem);
  }
}

// --- Data loading: catalog (fast) → full JSON (stories/activity) → wallet index ---

/** First paint: lean catalog built by backend/build_catalog.py (no recent_activity). */
/* === Data Loading (catalog first, then full + registry + wallet index) === */
/* Strong emphasis on ?v= busting + no-store for live data freshness after daily backend runs. */
async function loadCatalogFirst() {
  if (isFileProtocol()) throw new Error("FILE_PROTOCOL");
  try {
    return await fetchJson(CATALOG_URL, 20000);
  } catch (e1) {
    console.warn("Catalog fetch failed, trying full data:", e1);
    return await fetchJson(FULL_DATA_URL, 45000);
  }
}

/** After grid is visible, enrich items with full descriptions and transfer history. */
async function refreshFullDataInBackground() {
  setFullDataStatus("loading_full");
  try {
    const full = await fetchJson(FULL_DATA_URL, 45000);
    mergeFullDescriptions(full);
    galleryData.generated_at = full.generated_at;
    galleryData.collection = full.collection;
    renderDataFreshness();
  } catch (e) {
    console.warn("Background full data refresh failed:", e);
    setFullDataStatus("error");
  }
}

async function loadWalletIndex() {
  // Always load the main daCommunity wallet index for ENS enrichment — even when viewing
  // BIG KIX / badges (those collections do not ship their own wallet_index_file).
  // Collectors for the active collection are rebuilt after, so the main index never clobbers them.
  try {
    if (!walletIndex) {
      var w = await fetchJson(WALLET_URL, 20000);
      walletIndex = (w && w.holders_index) || w || null;
    }
  } catch (e) {
    console.warn("Wallet index load failed:", e);
    if (!walletIndex) walletIndex = (galleryData && galleryData.holders_index) || null;
  }

  // Enrich wallet by_address with ENS from badge item names if missing (most recent by minted_at).
  if (walletIndex && walletIndex.by_address && galleryData && galleryData.items) {
    var nameEns = {};
    galleryData.items.forEach(function (item) {
      var nm = item.name || item.display_name || "";
      var m = nm.match(/([a-z0-9-]+\.eth)/i);
      if (m) {
        var ens = m[1].toLowerCase();
        var d = item.minted_at || "0";
        var hs = (item.current_holders || []).concat(
          item.owners
            ? (item.owners.holders || []).concat(item.owners.top_holders || [])
            : []
        );
        hs.forEach(function (h) {
          var a = (h.address || "").toLowerCase();
          if (a) {
            if (!nameEns[a] || d > (nameEns[a].d || "0")) {
              nameEns[a] = { ens: ens, d: d };
            }
          }
        });
      }
    });
    Object.keys(nameEns).forEach(function (a) {
      if (walletIndex.by_address[a] && !walletIndex.by_address[a].ens_name) {
        walletIndex.by_address[a].ens_name = nameEns[a].ens;
      }
    });
  }

  enrichHoldersAndCollectorsWithENS();
  rebuildCollectorsForCurrentView();
  seedRankingCacheFromGalleryData();
  if (galleryCollectorView && galleryCollectorView.address) {
    refreshCollectorRankBadgesAsync();
  }
}

/* Registry loader (Part 1 multi-col support).
 * Only "live" collections appear in dropdown / pre-filters / share links.
 * Badges is now live (series reps in light search via dedicated view + ?collection hint).
 * Adding a new live collection = update registry.json + data wiring.
 */
async function loadCollectionsRegistry() {
  if (!REGISTRY_URL) {
    collectionsRegistry = { collections: [{ id: "dacommunity", name: "daCommunity NFT Archive", status: "live" }] };
    return;
  }
  try {
    collectionsRegistry = await fetchJson(REGISTRY_URL, 10000);
  } catch (e) {
    console.warn("Collections registry load failed, using fallback:", e);
    collectionsRegistry = { collections: [{ id: "dacommunity", name: "daCommunity NFT Archive", status: "live" }] };
  }
}

function buildCollectorsFromIndex(idx) {
  if (!idx || !idx.by_address) return [];
  return Object.values(idx.by_address)
    .map(function (e) {
      var holdings = e.holdings || [];
      return {
        address: e.address,
        ens_name: e.ens_name,
        username: e.username,
        unique_pieces: nvl(e.unique_pieces, holdings.length),
        collection_quantity: nvl(e.collection_quantity, 0),
      };
    })
    .sort(function (a, b) {
      return b.unique_pieces - a.unique_pieces;
    });
}

function buildCollectorsFromBadgeItems(items) {
  var byAddr = {};
  var ensCandidates = {}; // addr -> [{ens, date}]
  (items || []).forEach(function (item) {
    if (!item.source_created_collection) return; // badges only
    var slug = item.source_created_collection;
    var os = item.owners || {};
    var list = os.holders || os.top_holders || [];
    // Extract ENS from personalized item name if present (e.g. "daforeman.eth - ...")
    var itemName = item.name || item.display_name || '';
    var m = itemName.match(/([a-z0-9-]+\.eth)/i);
    var ensFromName = m ? m[1].toLowerCase() : null;
    var itemDate = item.minted_at || '0';
    if (ensFromName) {
      list.forEach(function (h) {
        var a = (h.address || '').toLowerCase();
        if (a) {
          if (!ensCandidates[a]) ensCandidates[a] = [];
          ensCandidates[a].push({ens: ensFromName, date: itemDate});
        }
      });
    }
    list.forEach(function (h) {
      var a = (h.address || '').toLowerCase();
      if (!a) return;
      if (!byAddr[a]) {
        byAddr[a] = {
          address: h.address,
          ens_name: h.ens_name || null,
          username: h.username || null,
          unique_pieces: 0,
          collection_quantity: 0,
          _slugs: {}
        };
      } else if (h.ens_name && !byAddr[a].ens_name) {
        byAddr[a].ens_name = h.ens_name;
      } else if (h.username && !byAddr[a].username) {
        byAddr[a].username = h.username;
      }
      byAddr[a].collection_quantity += (h.quantity || 1);
      if (slug) byAddr[a]._slugs[slug] = true;
    });
  });
  // Pick most recent ENS from names (for cases where resolve didn't populate ens_name)
  Object.keys(ensCandidates).forEach(function (a) {
    var list = ensCandidates[a];
    if (list.length > 0) {
      list.sort(function (x, y) { return y.date.localeCompare(x.date); });
      var best = list[0].ens;
      if (!byAddr[a]) {
        byAddr[a] = { address: a, ens_name: best, username: null, unique_pieces: 0, collection_quantity: 0, _slugs: {} };
      } else if (!byAddr[a].ens_name) {
        byAddr[a].ens_name = best;
      }
    }
  });
  // enrich ENS from walletIndex if available (many overlap) -- but do not clobber good values from badge owners data
  Object.keys(byAddr).forEach(function (a) {
    var e = walletIndex && walletIndex.by_address && walletIndex.by_address[a];
    if (e) {
      if (!byAddr[a].ens_name && e.ens_name) byAddr[a].ens_name = e.ens_name;
      if (!byAddr[a].username && e.username) byAddr[a].username = e.username;
    }
  });
  return Object.values(byAddr)
    .map(function (e) {
      // for badges, unique_pieces = distinct series/slugs owned (ignore double count from series_rep + personal)
      var slugCount = e._slugs ? Object.keys(e._slugs).length : 0;
      e.unique_pieces = slugCount || e.collection_quantity;
      delete e._slugs;
      return e;
    })
    .sort(function (a, b) {
      return (b.unique_pieces || b.collection_quantity || 0) - (a.unique_pieces || a.collection_quantity || 0);
    });
}

function enrichHoldersAndCollectorsWithENS() {
  if (!galleryData || !galleryData.items) return;
  var addrToBest = {};
  galleryData.items.forEach(function (item) {
    var nm = item.name || item.display_name || '';
    var m = nm.match(/([a-z0-9-]+\.eth)/i);
    if (m) {
      var ens = m[1].toLowerCase();
      var d = item.minted_at || '0';
      var hs = [];
      if (item.owners) {
        hs = hs.concat(item.owners.holders || []);
        hs = hs.concat(item.owners.top_holders || []);
      }
      hs = hs.concat(item.current_holders || []);
      hs.forEach(function (h) {
        var a = (h.address || '').toLowerCase();
        if (a) {
          if (!addrToBest[a] || d > (addrToBest[a].d || '0')) {
            addrToBest[a] = { ens: ens, d: d };
          }
          if (!h.ens_name) h.ens_name = ens;
        }
      });
    }
  });
  // from wallet
  if (walletIndex && walletIndex.by_address) {
    Object.keys(walletIndex.by_address).forEach(function (a) {
      var e = walletIndex.by_address[a];
      if (e && e.ens_name) {
        if (!addrToBest[a]) addrToBest[a] = { ens: e.ens_name, d: '9999' };
      }
    });
  }
  // apply to collectorsList if built
  collectorsList.forEach(function (c) {
    var a = (c.address || '').toLowerCase();
    if (a && !c.ens_name && addrToBest[a]) {
      c.ens_name = addrToBest[a].ens;
    }
  });
}

/**
 * Build collectors list from currently loaded gallery items.
 * Uses the same per-item ownership rules as buildHoldingsFromCurrentItems so the
 * collectors-modal "N pieces" count matches the collector wallet view when both
 * daCommunity + badges are loaded ("All collections").
 */
function buildCollectorsFromLoadedItems(items) {
  var byAddr = {};
  (items || []).forEach(function (item) {
    // Match buildHoldingsFromCurrentItems: multi 1:1 series_rep is search-only
    if (
      item.is_series_rep &&
      item.source_created_collection &&
      /trillion|billion/i.test(item.source_created_collection) &&
      !item.edition_club
    ) {
      return;
    }
    // Agency: count real case files only (not aggregated rarity rows)
    if (isAgencyRaritySeries(item)) return;
    var os = item.owners || {};
    var list = os.holders || os.top_holders || [];
    var itemKey = getItemKey(item);
    list.forEach(function (h) {
      var a = (h.address || "").toLowerCase();
      if (!a) return;
      if (!byAddr[a]) {
        byAddr[a] = {
          address: h.address || a,
          ens_name: h.ens_name || null,
          username: h.username || null,
          unique_pieces: 0,
          collection_quantity: 0,
          _keys: {},
        };
      } else {
        if (h.ens_name && !byAddr[a].ens_name) byAddr[a].ens_name = h.ens_name;
        if (h.username && !byAddr[a].username) byAddr[a].username = h.username;
      }
      if (byAddr[a]._keys[itemKey]) return;
      byAddr[a]._keys[itemKey] = true;
      byAddr[a].unique_pieces += 1;
      byAddr[a].collection_quantity += Number(h.quantity || 1) || 1;
    });
  });
  // Enrich ENS / username from wallet index when item owners lack them
  Object.keys(byAddr).forEach(function (a) {
    var e = walletIndex && walletIndex.by_address && walletIndex.by_address[a];
    if (e) {
      if (!byAddr[a].ens_name && e.ens_name) byAddr[a].ens_name = e.ens_name;
      if (!byAddr[a].username && e.username) byAddr[a].username = e.username;
    }
    delete byAddr[a]._keys;
  });
  return Object.values(byAddr).sort(function (a, b) {
    return (b.unique_pieces || b.collection_quantity || 0) - (a.unique_pieces || a.collection_quantity || 0);
  });
}

/** Prefer full JSON for secondary collections (activity + complete owners). */
async function loadSecondaryCollectionData(urls) {
  if (!urls) return loadCatalogFirst();
  try {
    var full = await fetchJson(urls.full, 45000);
    if (full && full.items && full.items.length) return full;
  } catch (e) {
    console.warn("Full secondary collection load failed, falling back to catalog", e);
  }
  return await fetchJson(urls.catalog, 20000);
}

function rebuildCollectorsForCurrentView() {
  // Secondary collections: derive from item owners (badges need series-slug logic)
  if (
    activeCollection &&
    activeCollection !== "all" &&
    activeCollection !== "dacommunity"
  ) {
    var items = galleryData ? galleryData.items : [];
    // CRITICAL: buildCollectorsFromBadgeItems skips items without source_created_collection
    // (badges only). BIG KIX and similar collections must use loaded-item owners.
    if (activeCollection === "badges") {
      collectorsList = buildCollectorsFromBadgeItems(items);
    } else {
      collectorsList = buildCollectorsFromLoadedItems(items);
    }
    updateCollectorsButton();
    return;
  }
  if (!activeCollection || activeCollection === "all") {
    // "All collections": count pieces across currently loaded dacommunity + secondaries.
    // Previous merge kept only the first list's unique_pieces, so badge holdings were dropped
    // for anyone already in the daCommunity wallet index — modal under-counted vs wallet view.
    var fromItems = buildCollectorsFromLoadedItems(galleryData ? galleryData.items : []);
    if (fromItems.length) {
      collectorsList = fromItems;
    } else {
      // Fallback if items not loaded yet: sum dacommunity index + item-based collectors
      var dacomCols = [];
      if (walletIndex && walletIndex.by_address) {
        dacomCols = buildCollectorsFromIndex(walletIndex);
      }
      var itemCols = buildCollectorsFromBadgeItems(galleryData ? galleryData.items : []);
      var map = {};
      function mergeRow(c) {
        if (!c || !c.address) return;
        var k = c.address.toLowerCase();
        var pieces = Number(c.unique_pieces) || 0;
        var qty = Number(c.collection_quantity) || 0;
        if (!map[k]) {
          map[k] = {
            address: c.address,
            ens_name: c.ens_name || null,
            username: c.username || null,
            unique_pieces: pieces,
            collection_quantity: qty,
          };
        } else {
          map[k].unique_pieces += pieces;
          map[k].collection_quantity += qty;
          if (!map[k].ens_name && c.ens_name) map[k].ens_name = c.ens_name;
          if (!map[k].username && c.username) map[k].username = c.username;
        }
      }
      dacomCols.forEach(mergeRow);
      itemCols.forEach(mergeRow);
      collectorsList = Object.values(map).sort(function (a, b) {
        return (b.unique_pieces || b.collection_quantity || 0) - (a.unique_pieces || a.collection_quantity || 0);
      });
    }
  } else if (activeCollection === "dacommunity") {
    collectorsList = buildCollectorsFromIndex(walletIndex);
  }
  updateCollectorsButton();
}

function syncCollectorViewToCurrentItems() {
  if (!galleryCollectorView || !galleryCollectorView.address) return;
  expandCollectorHoldingsFromLoadedData();
  renderCollectorFocusUi();
}

function formatMintDate(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatEth(n) {
  if (n == null || isNaN(n)) return "—";
  var v = Number(n);
  if (v === 0) return "0";
  var prec = (v < 0.01) ? 4 : 3;
  var str = v.toFixed(prec);
  // strip trailing zeros after decimal (e.g. 0.0030 -> 0.003, 0.050 -> 0.05)
  return str.replace(/\.?0+$/, '');
}

function escapeHtml(str) {
  var d = document.createElement("div");
  d.textContent = str == null ? "" : str;
  return d.innerHTML;
}

function itemTitle(item) {
  return item.display_name || item.local_slug || item.name || "Token #" + item.token_id;
}

/* === Utility Formatters === */
function formatPieceTitleHtml(title) {
  var t = title || "";
  if (t.toLowerCase().indexOf("dacat.") === 0) {
    var dot = t.indexOf(".");
    if (dot > 0) {
      return (
        '<span class="piece-title"><span class="piece-prefix">' +
        escapeHtml(t.slice(0, dot + 1)) +
        '</span><span class="piece-name">' +
        escapeHtml(t.slice(dot + 1)) +
        "</span></span>"
      );
    }
  }
  return escapeHtml(t);
}

/** Normalize rarity label from item.rarity or traits (Detective Agency). */
function itemRarityLabel(item) {
  if (!item) return null;
  if (item.rarity) return String(item.rarity);
  var traits = item.traits || [];
  for (var i = 0; i < traits.length; i++) {
    var tt = (traits[i].trait_type || "").toLowerCase();
    if (tt === "rarity" && traits[i].value) {
      var raw = String(traits[i].value).trim();
      var key = raw.toLowerCase();
      if (key === "1 of 1" || key === "1of1" || key === "one of one") return "1:1";
      if (key === "common") return "Common";
      if (key === "uncommon") return "Uncommon";
      if (key === "epic") return "Epic";
      if (key === "legendary") return "Legendary";
      return raw;
    }
  }
  return null;
}

function rarityBadgeClass(label) {
  if (!label) return "";
  var k = String(label).toLowerCase().replace(/\s+/g, "");
  if (k === "1:1" || k === "1of1") return "rarity-badge-1of1";
  if (k === "common") return "rarity-badge-common";
  if (k === "uncommon") return "rarity-badge-uncommon";
  if (k === "epic") return "rarity-badge-epic";
  if (k === "legendary") return "rarity-badge-legendary";
  return "rarity-badge-common";
}

function formatRarityBadgeHtml(item) {
  var label = itemRarityLabel(item);
  if (!label) return "";
  return (
    '<span class="rarity-badge ' +
    rarityBadgeClass(label) +
    '" title="Rarity: ' +
    escapeHtml(label) +
    '">' +
    escapeHtml(label) +
    "</span>"
  );
}

function collectionStewardLabel() {
  if (!galleryData || !galleryData.collection) return "dacatdreams.base.eth";
  return galleryData.collection.creator_ens || "dacatdreams.base.eth";
}

function cleanStoryText(item) {
  var text = (item.description || item.excerpt || "").replace(/\r\n/g, "\n");
  if (!text) return "";
  var title = itemTitle(item).toLowerCase();
  var slug = (item.local_slug || "").toLowerCase();
  var lines = text.split("\n");
  while (lines.length) {
    var head = lines[0].trim().toLowerCase();
    if (!head) {
      lines.shift();
      continue;
    }
    if (slug && head === slug) {
      lines.shift();
      continue;
    }
    if (title && head === title) {
      lines.shift();
      continue;
    }
    // Drop pure OpenSea name line when present
    if (item.opensea_name && head === String(item.opensea_name).trim().toLowerCase()) {
      lines.shift();
      continue;
    }
    // BIG KIX: multi-line body after a title-only first line
    if (/^big\s*kix\s*#\s*\d+/i.test(head) && lines.length > 1) {
      lines.shift();
      continue;
    }
    // BIG KIX flat catalog excerpt is one line: "BIG KIX #024 – NAME - Season 1 – First Edition The story…"
    // Do NOT drop the whole line — strip the title prefix and keep the lore.
    if (/^big\s*kix\s*#\s*\d+/i.test(head) && lines.length === 1) {
      var rest = lines[0]
        .replace(
          /^BIG\s*KIX\s*#\s*\d+\s*[-–—]\s*.+?\s*[-–—]\s*Season\s*\d+(?:\s*[-–—]\s*First\s*Edition)?\s*/i,
          ""
        )
        .trim();
      if (rest) lines[0] = rest;
      break;
    }
    break;
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  var out = lines.join("\n").trim();
  // Safety: if we still only have a title-ish string, try raw description body
  if (
    (!out || /^big\s*kix\s*#/i.test(out)) &&
    item.description &&
    item.description.indexOf("\n") >= 0
  ) {
    var body = item.description.replace(/\r\n/g, "\n").split("\n");
    while (body.length && !body[0].trim()) body.shift();
    if (body.length && /^big\s*kix\s*#/i.test(body[0].trim())) body.shift();
    while (body.length && !body[0].trim()) body.shift();
    out = body.join("\n").trim() || out;
  }
  return out;
}

function displayExcerpt(item) {
  var text = cleanStoryText(item);
  if (!text) return "";
  var flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 160) return flat;
  return flat.slice(0, 159).trim() + "…";
}

/** Detail drawer story: same short cut as list excerpts (~160), expandable in place. */
var DETAIL_STORY_CUT = 160;

function renderDetailDescription(item) {
  var el = $("#detail-description");
  if (!el) return;
  // Clear any previous full dump (textContent or nodes)
  el.textContent = "";
  el.innerHTML = "";
  el.classList.add("detail-description-clamped");

  var story = cleanStoryText(item) || "";
  if (!story) {
    el.textContent = "No description.";
    return;
  }
  // Prefer flat text for length; keep original newlines only in expanded view
  var flat = story.replace(/\s+/g, " ").trim();
  if (flat.length <= DETAIL_STORY_CUT) {
    el.textContent = flat;
    return;
  }

  var preview = flat.slice(0, DETAIL_STORY_CUT - 1).replace(/\s+\S*$/, "").trim() + "…";
  if (preview.length < 40) preview = flat.slice(0, DETAIL_STORY_CUT - 1).trim() + "…";

  var shortP = document.createElement("p");
  shortP.className = "detail-story-preview";
  shortP.textContent = preview;

  var fullP = document.createElement("p");
  fullP.className = "detail-story-full";
  fullP.setAttribute("hidden", "");
  fullP.style.display = "none";
  fullP.textContent = story;

  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "detail-story-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "Show more";
  toggle.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    var open = fullP.style.display === "none";
    if (open) {
      fullP.removeAttribute("hidden");
      fullP.style.display = "";
      shortP.style.display = "none";
      shortP.setAttribute("hidden", "");
      toggle.setAttribute("aria-expanded", "true");
      toggle.textContent = "Show less";
    } else {
      fullP.setAttribute("hidden", "");
      fullP.style.display = "none";
      shortP.removeAttribute("hidden");
      shortP.style.display = "";
      toggle.setAttribute("aria-expanded", "false");
      toggle.textContent = "Show more";
    }
  });

  el.appendChild(shortP);
  el.appendChild(fullP);
  el.appendChild(toggle);
  if (item.opensea_url) {
    var more = document.createElement("p");
    more.className = "detail-story-more";
    more.innerHTML =
      'Full lore on <a href="' +
      escapeHtml(item.opensea_url) +
      '" target="_blank" rel="noopener noreferrer">OpenSea ↗</a>';
    el.appendChild(more);
  }
}

function isVideoItem(item) {
  if (!item) return false;
  if (item.media_type === "video") return true;
  if (/\.(mp4|mov|webm)(\?|$)/i.test(item.image_url || "")) return true;
  if (/\.(mp4|mov|webm)(\?|$)/i.test(item.opensea_image_url || "")) return true;
  return false;
}

function resolveMediaUrl(url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return getDataPrefix() + String(url).replace(/^\//, "");
}

function imgSrc(item) {
  return resolveMediaUrl(item.image_url || item.opensea_image_url || "");
}

function shortenAddress(addr) {
  if (!addr || addr.length < 12) return addr;
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function holderLabel(address) {
  var entry = walletIndex && walletIndex.by_address && walletIndex.by_address[address.toLowerCase()];
  if (!entry) return shortenAddress(address);
  return entry.ens_name || entry.username || shortenAddress(address);
}

function addressDisplayMeta(address) {
  if (!address) return { address: "", display: "", lookupValue: "", full: "" };
  var key = address.toLowerCase();
  var full = address;
  var entry = walletIndex && walletIndex.by_address && walletIndex.by_address[key];
  // Also check attached ens_name from badge owners data (for pure badge holders or after fetch with ENS)
  var fromDataEns = null;
  if (galleryData && Array.isArray(galleryData.items)) {
    for (var it of galleryData.items) {
      var os = it.owners || {};
      for (var kk of ["holders", "top_holders"]) {
        for (var o of (os[kk] || [])) {
          if ((o.address || "").toLowerCase() === key && o.ens_name) {
            fromDataEns = o.ens_name;
            break;
          }
        }
      }
    }
  }
  // Prefer ens_name from the collectorsList (Heavy collectors) for consistency between the list
  // and any portfolio / wallet view / chips for the same address. This ensures e.g. daforeman.eth
  // (current) shows everywhere instead of old names like inshirowetrust.eth from stale owner records.
  var fromList = null;
  (collectorsList || []).forEach(function (c) {
    if ((c.address || '').toLowerCase() === key && c.ens_name) {
      fromList = c.ens_name;
    }
  });
  var ens = fromList || (entry && entry.ens_name) || fromDataEns;
  var username = entry && entry.username;
  var lookupValue = ens || full;
  var display = ens || username || shortenAddress(full);
  return {
    address: key,
    display: display,
    lookupValue: lookupValue,
    full: full,
    /** Show full 0x under chip when label is ENS/username or shortened hex. */
    showFullHex: display !== full,
  };
}

function holderChipLabelHtml(meta) {
  return escapeHtml(meta.display);
}

/** Prefer live holder list length when OpenSea holder_count lags a new wallet. */
function effectiveHolderCount(item) {
  var owners = item.owners || {};
  var holders = resolveHoldersList(item);
  return Math.max(owners.holder_count || 0, holders.length);
}

/**
 * Full holder list for this token. Prefer owners.holders from OpenSea; if JSON only
 * has top_holders (5), backfill from wallet_index once it has loaded.
 */
function resolveHoldersList(item) {
  var owners = item.owners || {};
  var byAddr = {};
  function add(h) {
    if (!h || !h.address) return;
    byAddr[h.address.toLowerCase()] = {
      address: h.address.toLowerCase(),
      quantity: intQty(h.quantity),
    };
  }
  function intQty(n) {
    var v = parseInt(n, 10);
    return isNaN(v) ? 1 : v;
  }
  (owners.holders || []).forEach(add);
  if (!owners.holders || !owners.holders.length) {
    (owners.top_holders || []).forEach(add);
  }
  var expected = owners.holder_count || 0;
  if (expected > Object.keys(byAddr).length && walletIndex && walletIndex.by_address) {
    Object.values(walletIndex.by_address).forEach(function (entry) {
      (entry.holdings || []).forEach(function (h) {
        if (String(h.token_id) !== String(item.token_id)) return;
        var k = (entry.address || "").toLowerCase();
        if (!k || byAddr[k]) return;
        byAddr[k] = { address: k, quantity: 1 };
      });
    });
  }
  return sortHoldersForDisplay(Object.values(byAddr), item);
}

/**
 * Wallet to pin/highlight in the detail holder list.
 * Portfolio mode: galleryCollectorView.tokenIds only (never resolveHoldersList — that would recurse).
 */
function holderHighlightAddress(item) {
  if (galleryCollectorView && galleryCollectorView.address) {
    var viewing = galleryCollectorView.address.toLowerCase();
    if (galleryCollectorView.tokenIds[String(item.token_id)]) {
      return viewing;
    }
    return null;
  }
  return currentOwnerAddress(item);
}

function holderHighlightNote(item, holderAddress) {
  if (!holderAddress) return "";
  if (
    galleryCollectorView &&
    galleryCollectorView.address &&
    holderAddress === galleryCollectorView.address.toLowerCase()
  ) {
    return " · this portfolio";
  }
  return " · latest transfer";
}

function sortHoldersForDisplay(holders, item) {
  var pinAddr = holderHighlightAddress(item);
  return holders.sort(function (a, b) {
    var aa = a.address.toLowerCase();
    var ba = b.address.toLowerCase();
    if (pinAddr) {
      if (aa === pinAddr && ba !== pinAddr) return -1;
      if (ba === pinAddr && aa !== pinAddr) return 1;
    }
    return (b.quantity || 0) - (a.quantity || 0);
  });
}

function holderRowForToken(item, address) {
  var key = (address || "").toLowerCase();
  var list = resolveHoldersList(item);
  for (var i = 0; i < list.length; i++) {
    if (list[i].address.toLowerCase() === key) return list[i];
  }
  return null;
}

function showCopyToast(message) {
  var el = $("#copy-toast");
  if (!el) {
    el = document.createElement("p");
    el.id = "copy-toast";
    el.className = "copy-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(showCopyToast._timer);
  showCopyToast._timer = setTimeout(function () {
    el.classList.remove("is-visible");
  }, 2200);
}

function copyFullAddress(address) {
  if (!address) return;
  var full = address.toLowerCase();
  function done(ok) {
    showCopyToast(ok ? "Address copied" : "Copy failed. Select and copy manually.");
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(full).then(function () { done(true); }).catch(function () { done(false); });
    return;
  }
  var ta = document.createElement("textarea");
  ta.value = full;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    done(document.execCommand("copy"));
  } catch (e) {
    done(false);
  }
  document.body.removeChild(ta);
}

/* === Collector / Wallet View (dark cinema portfolio + ?wallet= deep links) === */
// --- Collector lookup (wallet_index.json, shareable ?wallet= URLs) ---

function parseWalletFromUrl() {
  var params = new URLSearchParams(window.location.search);
  return (params.get("wallet") || params.get("ens") || "").trim();
}

function parseBrowseParamsFromUrl() {
  var params = new URLSearchParams(window.location.search);
  var col = params.get("collection") || params.get("col");
  if (col) activeCollection = col;
  var f = params.get("filter");
  if (f && FILTER_LABELS[f]) activeFilter = f;
  var s = params.get("sort");
  if (s && SORT_LABELS[s]) sortKey = s;
  var q = params.get("q") || params.get("search");
  if (q) searchQuery = q;
}

function syncBrowseParamsToUrl() {
  try {
    var params = new URLSearchParams(window.location.search);
    if (activeCollection && activeCollection !== "all") {
      params.set("collection", activeCollection);
    } else {
      params.delete("collection");
    }
    if (searchQuery) {
      params.set("q", searchQuery);
    } else {
      params.delete("q");
    }
    if (activeFilter && activeFilter !== "all") {
      params.set("filter", activeFilter);
    } else {
      params.delete("filter");
    }
    if (sortKey && sortKey !== "token_desc") {
      params.set("sort", sortKey);
    } else {
      params.delete("sort");
    }
    var qs = params.toString();
    var newUrl = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
    history.replaceState(null, "", newUrl);
  } catch (e) {}
}

/** Measured sticky nav height — used for scroll offsets (collector escape bar, wallet hub). */
function getSiteHeaderOffset() {
  var raw = getComputedStyle(document.documentElement).getPropertyValue("--site-header-h").trim();
  var px = parseFloat(raw);
  if (!isNaN(px) && px > 0) return Math.ceil(px);
  var header = document.querySelector(".site-header");
  return header ? Math.ceil(header.getBoundingClientRect().height) : 0;
}

/** Scroll so el sits flush under the sticky site header (no scrollIntoView — avoids sticky gaps). */
function scrollToElementBelowHeader(el, opts) {
  opts = opts || {};
  if (!el) return;
  var behavior = opts.behavior === "instant" ? "auto" : opts.behavior || "smooth";
  var top = el.getBoundingClientRect().top + window.pageYOffset - getSiteHeaderOffset();
  window.scrollTo({ top: Math.max(0, top), behavior: behavior });
}

/** Canonical /dacommunity/ URL (share links work from any page on the site). */
function dacommunityBaseUrl() {
  var path = (window.location.pathname || "/").replace(/\/index\.html$/i, "/");
  var marker = "/dacommunity";
  var idx = path.indexOf(marker);
  if (idx >= 0) {
    return new URL(path.slice(0, idx + marker.length) + "/", window.location.origin);
  }
  var segments = path.split("/").filter(Boolean);
  if (segments.length && segments[segments.length - 1].indexOf(".") >= 0) {
    segments.pop();
  }
  if (segments.length) {
    return new URL("/" + segments[0] + "/dacommunity/", window.location.origin);
  }
  return new URL("/dacommunity/", window.location.origin);
}

function syncWalletShareUrl(address) {
  if (!address || !/^0x[a-fA-F0-9]{40}$/i.test(address)) return;
  var onDacommunity = window.location.pathname.indexOf("/dacommunity") >= 0;
  var url = onDacommunity ? new URL(window.location.href) : dacommunityBaseUrl();
  url.searchParams.set("wallet", address.toLowerCase());
  url.searchParams.delete("ens");
  url.hash = "wallet-panel";
  if (bindCollectorHubNav._bound) bindCollectorHubNav._suppressHash = true;
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  if (bindCollectorHubNav._bound) bindCollectorHubNav._suppressHash = false;
}

function clearWalletShareUrl() {
  var params = new URLSearchParams(window.location.search);
  params.delete("wallet");
  params.delete("ens");
  var q = params.toString();
  var path = window.location.pathname + (q ? "?" + q : "") + window.location.hash;
  history.replaceState(null, "", path);
}

/** Empty lookup field, hide result card, drop ?wallet= from URL. */
function resetWalletLookupHub() {
  var input = $("#wallet-input");
  if (input) input.value = "";
  var clearBtn = $("#wallet-clear");
  if (clearBtn) clearBtn.hidden = true;
  var resultEl = $("#wallet-result");
  if (resultEl) {
    resultEl.hidden = true;
    resultEl.innerHTML = "";
  }
  clearWalletResultHighlight();
  clearWalletShareUrl();
  var panel = $("#wallet-lookup");
  if (panel) {
    panel.classList.remove("has-result");
    panel.classList.remove("is-collector-compact");
  }
}

function collectorTokenIdSet(entry) {
  var ids = {};
  (entry.holdings || []).forEach(function (h) {
    // Use composite key (source+token) to prevent numeric token_id collisions
    // between dacommunity and badges collections in portfolio view.
    ids[getItemKey(h)] = true;
  });
  return ids;
}

function setGalleryCollectorView(entry, opts) {
  opts = opts || {};
  if (!entry) return;
  var label = entry.ens_name || entry.username || shortenAddress(entry.address);
  var addr = entry.address.toLowerCase();
  // Ensure collectorsList matches active collection so primary rank is meaningful
  rebuildCollectorsForCurrentView();
  seedRankingCacheFromGalleryData();
  var holdings = entry.holdings || [];
  // Prefer live quantity sums from holdings (BIG KIX multi-copy + agency editions)
  var fromHoldings = holdings.length ? summarizeHoldingsStats(holdings) : null;
  var uniqueN = fromHoldings
    ? fromHoldings.unique_pieces
    : nvl(entry.unique_pieces, 0);
  var qtyN = fromHoldings
    ? fromHoldings.collection_quantity
    : nvl(entry.collection_quantity, uniqueN);
  galleryCollectorView = {
    address: addr,
    label: label,
    tokenIds: collectorTokenIdSet(entry),
    pieceCount: uniqueN,
    uniquePieces: uniqueN,
    collectionQuantity: qtyN,
    rank: collectorRank(addr),
    ranks: collectorRankBadges(addr, 10, MAX_COLLECTOR_RANK_BADGES),
  };
  renderCollectorFocusUi();
  refreshView();
  // When portfolio opens from a single-collection page, expand to all loaded pieces
  // once secondary catalogs / wallet index catch up (clear-filters still forces full reload).
  if (!activeCollection || activeCollection === "all") {
    expandCollectorHoldingsFromLoadedData();
    renderCollectorFocusUi();
  }
  // Fill ranks for collections not in current filter (async catalogs / wallet index)
  refreshCollectorRankBadgesAsync();
  if (opts.scroll === false) return;
  scrollToCollectorTheaterTop({ behavior: opts.scrollBehavior || "smooth" });
}

/** After data load / clear-filters: expand portfolio to every piece this wallet holds. */
function expandCollectorHoldingsFromLoadedData() {
  if (!galleryCollectorView || !galleryCollectorView.address) return;
  var addr = galleryCollectorView.address;
  rebuildCollectorsForCurrentView();
  var holdings = buildHoldingsFromCurrentItems(addr);
  // Merge wallet-index holdings when on all/dacommunity so Base pieces appear too
  if (
    (!activeCollection || activeCollection === "all" || activeCollection === "dacommunity") &&
    walletIndex &&
    walletIndex.by_address &&
    walletIndex.by_address[addr]
  ) {
    var wi = walletIndex.by_address[addr];
    var have = {};
    holdings.forEach(function (h) {
      have[getItemKey(h)] = true;
    });
    (wi.holdings || []).forEach(function (h) {
      var k = getItemKey(h);
      if (!have[k]) {
        // Wallet index often lacks quantity — treat as 1 copy of that piece
        var row = Object.assign({}, h);
        if (row.quantity == null) row.quantity = 1;
        if (!row.collection_id) row.collection_id = "dacommunity";
        holdings.push(row);
        have[k] = true;
      }
    });
  }
  if (!holdings.length) return;
  var stats = summarizeHoldingsStats(holdings);
  galleryCollectorView.tokenIds = collectorTokenIdSet({ holdings: holdings });
  galleryCollectorView.pieceCount = stats.unique_pieces;
  galleryCollectorView.uniquePieces = stats.unique_pieces;
  galleryCollectorView.collectionQuantity = stats.collection_quantity;
  galleryCollectorView.rank = collectorRank(addr);
  galleryCollectorView.ranks = collectorRankBadges(addr, 10, MAX_COLLECTOR_RANK_BADGES);
  refreshCollectorRankBadgesAsync();
}

/**
 * Scroll to the top of the collector theater (escape bar).
 * Portfolio mode hides the hero — keep scrollY at 0 so we are not left at a prior archive depth.
 */
function scrollToCollectorTheaterTop(opts) {
  opts = opts || {};
  var behavior = opts.behavior === "instant" ? "auto" : opts.behavior || "smooth";

  function run() {
    syncSiteHeaderHeight();
    if (galleryCollectorView) {
      window.scrollTo({ top: 0, behavior: behavior });
      return;
    }
    var bar = $("#collector-escape-bar");
    if (bar && !bar.hidden) {
      scrollToElementBelowHeader(bar, { behavior: behavior });
      return;
    }
    scrollToCollectorCollection({ behavior: behavior });
  }

  requestAnimationFrame(function () {
    requestAnimationFrame(run);
  });
}

/** Reset search/filter/sort inside an active collector view (stay in theater mode).
 *  Always reloads "All collections" data so holdings outside the prior filter reappear.
 */
function clearCollectorFilters() {
  if (!galleryCollectorView) return;
  activeFilter = "all";
  searchQuery = "";
  sortKey = "token_desc";
  var search = $("#search");
  var sort = $("#sort-select");
  var colSel = $("#collection-select");
  if (search) search.value = "";
  if (sort) sort.value = "token_desc";
  document.querySelectorAll(".filter").forEach(function (btn) {
    var on = btn.dataset.filter === "all";
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });

  function afterAllDataReady() {
    expandCollectorHoldingsFromLoadedData();
    renderCollectorFocusUi();
    refreshView();
    syncBrowseParamsToUrl();
  }

  async function loadAllCollectionsForPortfolio() {
    initDataUrls();
    var newData = await loadCatalogFirst();
    galleryData = newData;
    if (galleryData && Array.isArray(galleryData.items)) {
      galleryData.items.forEach(function (item) {
        if (!item.collection_id) item.collection_id = "dacommunity";
      });
    }
    dataSource =
      galleryData && galleryData.source === "gallery_catalog" ? "catalog" : "full";
    indexItems(galleryData);
    await mergeSecondaryCatalogsIntoGallery();
    rebuildCollectorsForCurrentView();
    renderStats((galleryData && galleryData.collection) || null);
    adaptHeaderForCollection();
    applyCollectionUI();
  }

  // Already on all: still re-merge secondaries so agency/bigkix pieces aren't missing
  // after a single-collection cold load that never merged.
  if (!activeCollection || activeCollection === "all") {
    if (colSel) colSel.value = "all";
    var loadElAll = $("#load-state");
    if (loadElAll) loadElAll.hidden = false;
    (async function () {
      try {
        await loadAllCollectionsForPortfolio();
        afterAllDataReady();
        if (dataSource === "catalog") refreshFullDataInBackground();
        loadWalletIndex()
          .then(function () {
            expandCollectorHoldingsFromLoadedData();
            renderCollectorFocusUi();
            refreshView();
          })
          .catch(function () {
            afterAllDataReady();
          });
      } catch (err) {
        console.error("clearCollectorFilters (all) failed", err);
        afterAllDataReady();
      } finally {
        if (loadElAll) loadElAll.hidden = true;
      }
    })();
    return;
  }

  // Need full multi-collection catalog so portfolio is not stuck on one collection
  activeCollection = "all";
  if (colSel) colSel.value = "all";
  syncBrowseParamsToUrl();
  var loadEl = $("#load-state");
  if (loadEl) loadEl.hidden = false;
  (async function () {
    try {
      await loadAllCollectionsForPortfolio();
      afterAllDataReady();
      if (dataSource === "catalog") {
        refreshFullDataInBackground();
      }
      loadWalletIndex()
        .then(function () {
          expandCollectorHoldingsFromLoadedData();
          renderCollectorFocusUi();
          refreshView();
        })
        .catch(function () {
          afterAllDataReady();
        });
    } catch (err) {
      console.error("clearCollectorFilters failed", err);
      afterAllDataReady();
    } finally {
      if (loadEl) loadEl.hidden = true;
    }
  })();
}

function clearGalleryCollectorView(opts) {
  opts = opts || {};
  galleryCollectorView = null;
  clearWalletShareUrl();
  renderCollectorFocusUi();
  if (opts.clearResult !== false) {
    var resultEl = $("#wallet-result");
    if (resultEl) {
      resultEl.hidden = true;
      resultEl.innerHTML = "";
    }
    clearWalletResultHighlight();
  }
  refreshView();
}

/** Leave focused wallet grid; by default clears lookup field + result card. */
function exitCollectorView(opts) {
  opts = opts || {};
  if (!galleryCollectorView) return;
  var keepLookup = opts.keepLookup === true;
  clearGalleryCollectorView({ clearResult: keepLookup ? false : true });
  if (!keepLookup) {
    resetWalletLookupHub();
  } else if (opts.clearInput) {
    var input = $("#wallet-input");
    if (input) input.value = "";
  }
  if (opts.scrollToHub !== false) {
    scrollToCollectorHub({
      behavior: opts.scrollBehavior || "smooth",
      updateHash: opts.updateHash !== false,
    });
  }
}

function scrollToCollectorCollection(opts) {
  opts = opts || {};
  var list = $("#gallery-list");
  if (list && galleryCollectorView) {
    scrollToElementBelowHeader(list, opts);
  }
}

var browseAdvancedMq = window.matchMedia("(max-width: 950px)");

/** Collapse filter/sort on mobile (archive + portfolio); always open on desktop archive. */
function syncBrowseAdvancedPanel() {
  var browse = $("#browse-controls");
  var browseToggle = $("#browse-advanced-toggle");
  var browseAdvanced = $("#browse-advanced");
  if (!browse || !browseToggle || !browseAdvanced) return;

  var isPortfolio = browse.classList.contains("is-portfolio-browse");
  var isMobile = browseAdvancedMq.matches;
  var showToggle = isPortfolio || isMobile;
  var userToggled = browseToggle.dataset.userToggled === "1";

  browseToggle.hidden = !showToggle;

  if (!showToggle) {
    browseAdvanced.classList.remove("is-collapsed");
    browseToggle.setAttribute("aria-expanded", "true");
    return;
  }

  if (!userToggled) {
    browseAdvanced.classList.add("is-collapsed");
    browseToggle.setAttribute("aria-expanded", "false");
  }
}

function onBrowseAdvancedMqChange() {
  var browseToggle = $("#browse-advanced-toggle");
  if (browseToggle && !browseAdvancedMq.matches) {
    delete browseToggle.dataset.userToggled;
  }
  syncBrowseAdvancedPanel();
}

/** Toggle dark portfolio layout: hide hero, compact browse, cinema grid. */
function renderCollectorFocusUi() {
  var active = !!galleryCollectorView;
  document.body.classList.toggle("has-collector-view", active);

  var panel = $("#wallet-lookup");
  if (panel) {
    panel.classList.toggle("is-collector-active", active);
    panel.classList.toggle("is-collector-compact", active && panel.classList.contains("has-result"));
  }

  var frame = $("#collector-theater-frame");
  if (frame) frame.classList.toggle("is-active", active);

  var escapeBar = $("#collector-escape-bar");
  if (escapeBar) escapeBar.hidden = !active;

  var browse = $("#browse-controls");
  if (browse) browse.classList.toggle("is-portfolio-browse", active);

  var browseToggle = $("#browse-advanced-toggle");
  if (active && browseToggle) {
    delete browseToggle.dataset.userToggled;
  }
  syncBrowseAdvancedPanel();

  var hero = document.querySelector(".hero-band");
  if (hero) hero.hidden = active;

  var searchInp = $("#search");
  if (searchInp) {
    searchInp.placeholder = active
      ? "Search this collection…"
      : "dacat.blast, story, #47…";
  }

  var browseRibbon = $("#collector-browse-ribbon");
  if (browseRibbon) browseRibbon.hidden = !active;

  // Gallery page identity is "my dacats" — dashed race border + first in nav order
  // (with Universe always second). Also true while a collector portfolio is open.
  var onGallery = document.body.hasAttribute("data-base");
  var walletIsCurrent = active || onGallery;
  document.querySelectorAll(".nav-btn-wallet").forEach(function (el) {
    el.classList.toggle("is-active", walletIsCurrent);
    if (walletIsCurrent) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });

  if (galleryCollectorView) {
    var label = galleryCollectorView.label;
    var count = galleryCollectorView.pieceCount;
    var pieceWord = count === 1 ? "piece" : "pieces";

    var escapeName = $("#collector-escape-name");
    if (escapeName) escapeName.textContent = label;

    var escapeCount = $("#collector-escape-count");
    if (escapeCount) {
      escapeCount.textContent = count + " " + pieceWord;
      escapeCount.hidden = false;
    }

    var escapeStats = $("#collector-escape-stats");
    if (escapeStats) {
      var uq = galleryCollectorView.uniquePieces;
      var qty = galleryCollectorView.collectionQuantity;
      escapeStats.textContent =
        uq + " unique · " + qty + " copies held";
      escapeStats.hidden = false;
    }

    var escapeRank = $("#collector-escape-rank");
    if (escapeRank) {
      var ranks =
        galleryCollectorView.ranks && galleryCollectorView.ranks.length
          ? galleryCollectorView.ranks
          : null;
      if (!ranks || !ranks.length) {
        // Fallback: single rank for active collection list
        var rOne = galleryCollectorView.rank;
        if (rOne && rOne <= 10) {
          ranks = [
            {
              id: activeCollection && activeCollection !== "all" ? activeCollection : "dacommunity",
              rank: rOne,
              short:
                activeCollection === "bigkix"
                  ? "BIG KIX"
                  : activeCollection === "badges"
                    ? "Badges"
                    : activeCollection === "dacommunity"
                      ? "daCommunity"
                      : "Archive",
            },
          ];
        }
      }
      if (ranks && ranks.length) {
        escapeRank.hidden = false;
        escapeRank.className = "collector-escape-ranks";
        escapeRank.innerHTML = formatRankBadgesHtml(ranks, { short: true });
      } else {
        escapeRank.hidden = true;
        escapeRank.textContent = "";
        escapeRank.innerHTML = "";
        escapeRank.className = "collector-escape-rank-badge";
      }
    }

    document.title = label + " · daCommunity Gallery · daCAT";
  } else {
    ["collector-escape-count", "collector-escape-stats", "collector-escape-rank"].forEach(function (id) {
      var el = $("#" + id);
      if (el) el.hidden = true;
    });
    document.title = "daCommunity Gallery · daCAT";
  }

  var zone = $("#gallery-focus-zone");
  if (zone) zone.classList.toggle("is-collector-grid", active);

  var list = $("#gallery-list");
  if (list) {
    list.classList.toggle("gallery-list--collector", active);
    list.classList.toggle("holdings-grid", active);
    list.classList.toggle("collector-collection-grid", active);
  }
}

function bindCollectorExitUi() {
  function onExitClick(e) {
    if (e) e.preventDefault();
    exitCollectorView();
  }

  [$("#collector-escape-archive")].forEach(function (el) {
    if (!el || el.dataset.boundExit) return;
    el.dataset.boundExit = "1";
    el.addEventListener("click", onExitClick);
  });

  var clearFilters = $("#collector-clear-filters");
  if (clearFilters && !clearFilters.dataset.boundExit) {
    clearFilters.dataset.boundExit = "1";
    clearFilters.addEventListener("click", function (e) {
      if (e) e.preventDefault();
      clearCollectorFilters();
    });
  }
}

function handleEscapeKey() {
  if ($("#collectors-modal").classList.contains("open")) {
    closeCollectorsModal();
    return;
  }
  if ($("#share-modal") && !$("#share-modal").hidden) {
    closeShareModal();
    return;
  }
  if ($("#detail-panel").classList.contains("open")) {
    closeDetail();
    return;
  }
  if (galleryCollectorView) {
    exitCollectorView();
    return;
  }
  var walletInp = $("#wallet-input");
  if (walletInp && walletInp.value.trim()) {
    resetWalletLookupHub();
    return;
  }
  if (searchQuery) {
    searchQuery = "";
    var searchInp = $("#search");
    if (searchInp) searchInp.value = "";
    refreshView();
    return;
  }
  if (activeFilter !== "all" || sortKey !== "token_desc" || activeCollection !== "all") {
    activeFilter = "all";
    sortKey = "token_desc";
    activeCollection = "all";
    var sortSel = $("#sort-select");
    var colSel = $("#collection-select");
    if (sortSel) sortSel.value = "token_desc";
    if (colSel) colSel.value = "all";
    document.querySelectorAll(".filter").forEach(function (btn) {
      var on = btn.dataset.filter === "all";
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    refreshView();
  }
}

function applyCollectorView(address) {
  if (!address) return;
  var key = address.toLowerCase();
  var meta = addressDisplayMeta(address);
  closeDetail();
  closeCollectorsModal();
  var input = $("#wallet-input");
  if (input) input.value = meta.lookupValue || meta.address;
  // Rank + holdings from current loaded collection (badges / BIG KIX / all)
  rebuildCollectorsForCurrentView();
  var synthHoldings = buildHoldingsFromCurrentItems(key);
  if (synthHoldings.length > 0) {
    var m = (walletIndex && walletIndex.by_address && walletIndex.by_address[key]) || {};
    var fEns = null, fUser = null;
    (galleryData && galleryData.items || []).forEach(function (item) {
      var list = (item.owners || {}).holders || (item.owners || {}).top_holders || [];
      list.forEach(function (o) {
        if ((o.address || "").toLowerCase() === key && o.ens_name) {
          fEns = o.ens_name;
          if (o.username) fUser = o.username;
        }
      });
    });
    // Mirror the fromList preference from lookupWallet synth so that applyCollectorView
    // (used e.g. from holder chips in badges grid, some collector clicks) also gets the
    // consistent current ENS (daforeman.eth) instead of stale from item owners.
    var fromList = null;
    (collectorsList || []).forEach(function (c) {
      if ((c.address || '').toLowerCase() === key && c.ens_name) {
        fromList = c.ens_name;
      }
    });
    var synthStats = summarizeHoldingsStats(synthHoldings);
    var entry = {
      address: key,
      holdings: synthHoldings,
      unique_pieces: synthStats.unique_pieces,
      collection_quantity: synthStats.collection_quantity,
      ens_name: fromList || fEns || m.ens_name || null,
      username: fUser || m.username || null
    };
    renderWalletSuccess(entry, { scrollBehavior: "smooth" });
    syncWalletShareUrl(key);
    return;
  }
  var entry = walletIndex && walletIndex.by_address && walletIndex.by_address[key];
  if (entry) {
    renderWalletSuccess(entry, { scrollBehavior: "smooth" });
    syncWalletShareUrl(entry.address);
    return;
  }
  runWalletLookupFromAddress(address, meta.lookupValue);
}

function walletShareUrl(address) {
  var url = dacommunityBaseUrl();
  url.searchParams.set("wallet", address.toLowerCase());
  url.searchParams.delete("ens");
  url.hash = "wallet-panel";
  return url.toString();
}

/** Scroll to wallet lookup hub (#wallet-lookup) or theater top when portfolio is open. */
function scrollToCollectorHub(opts) {
  opts = opts || {};
  if (!$("#wallet-panel")) return;

  if (galleryCollectorView) {
    scrollToCollectorTheaterTop(opts);
    return;
  }

  var lookup = $("#wallet-lookup");
  if (!lookup) return;

  function runScroll() {
    if (opts.updateHash !== false) {
      bindCollectorHubNav._suppressHash = true;
      history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search + "#wallet-panel"
      );
      bindCollectorHubNav._suppressHash = false;
    }
    scrollToElementBelowHeader(lookup, opts);
    lookup.focus({ preventScroll: true });
  }

  requestAnimationFrame(function () {
    requestAnimationFrame(runScroll);
  });
}

/** Nav “My daCATs” / #wallet-panel — close overlays, exit portfolio grid, scroll to lookup. */
function navigateToCollectorHub() {
  closeDetail();
  closeCollectorsModal();
  if (galleryCollectorView && parseWalletFromUrl()) {
    scrollToCollectorTheaterTop({ behavior: "smooth" });
    return;
  }
  if (galleryCollectorView) {
    exitCollectorView({ scrollToHub: false });
  }
  scrollToCollectorHub({ updateHash: true });
  var input = $("#wallet-input");
  if (input) {
    window.setTimeout(function () {
      input.focus({ preventScroll: true });
    }, 350);
  }
}

function bindCollectorHubNav() {
  if (bindCollectorHubNav._bound) return;
  bindCollectorHubNav._bound = true;

  document
    .querySelectorAll('a[href="#wallet-panel"], a[href*="#wallet-panel"]')
    .forEach(function (link) {
      link.addEventListener("click", function (e) {
        if (!$("#wallet-panel")) return;
        e.preventDefault();
        navigateToCollectorHub();
      });
    });

  window.addEventListener("hashchange", function () {
    if (location.hash !== "#wallet-panel" || !$("#wallet-panel")) return;
    if (bindCollectorHubNav._suppressHash) return;
    navigateToCollectorHub();
  });
}

/** Clicks on grid cards (re-bound whenever renderGallery runs). */
function bindGalleryListClicks() {
  var list = $("#gallery-list");
  if (!list || list.dataset.clickBound) return;
  list.dataset.clickBound = "1";
  list.addEventListener("click", function (e) {
    var card = e.target.closest(".holding-card, .gallery-row");
    if (!card || !list.contains(card)) return;
    var tid = card.getAttribute("data-token-id");
    if (!tid) return;
    var item = itemsById.get(tid);
    if (item) openDetail(item);
  });
}

function runWalletLookupFromAddress(address, lookupValue) {
  var input = $("#wallet-input");
  if (!input) return;
  var meta = addressDisplayMeta(address);
  input.value = lookupValue || meta.lookupValue || meta.address;
  closeDetail();
  closeCollectorsModal();
  // Always pass the canonical 0x address (from data-address in pills etc) to lookup
  // so synth path works directly without relying on ENS resolve (which can hang on external service).
  // The input keeps the nice ENS name for display.
  renderWalletLookup(address, { updateUrl: true, scrollBehavior: "smooth" });
}

function pinWalletDeepLinkScroll() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.scrollTo(0, 0);
}

async function applyWalletFromUrl() {
  var q = parseWalletFromUrl();
  if (!q) return;
  pinWalletDeepLinkScroll();
  var input = $("#wallet-input");
  if (input) input.value = q;
  await renderWalletLookup(q, { updateUrl: true, scrollBehavior: "instant" });
  pinWalletDeepLinkScroll();
  requestAnimationFrame(function () {
    requestAnimationFrame(pinWalletDeepLinkScroll);
  });
}

function collectorRank(address) {
  return collectorRankInList(address, collectorsList);
}

function collectorRankInList(address, list) {
  var key = (address || "").toLowerCase();
  if (!key || !list || !list.length) return null;
  for (var i = 0; i < list.length; i++) {
    if ((list[i].address || "").toLowerCase() === key) return i + 1;
  }
  return null;
}

/** Independent of active filter — ranks per collection for wallet badges. */
var collectionRankingCache = {}; // colId -> sorted collectors array

function collectionRankShortName(colId, fallbackName) {
  if (colId === "bigkix") return "BIG KIX";
  if (colId === "dagato-agency") return "Agency";
  if (colId === "badges") return "Badges";
  if (colId === "dacommunity") return "daCommunity";
  return fallbackName || colId || "Archive";
}

/** Sync snapshot from currently loaded gallery items (cheap, call when data loads). */
function seedRankingCacheFromGalleryData() {
  var items = (galleryData && galleryData.items) || [];
  if (!items.length) return;
  var byCol = {};
  items.forEach(function (it) {
    var cid = it.collection_id || "dacommunity";
    if (!byCol[cid]) byCol[cid] = [];
    byCol[cid].push(it);
  });
  Object.keys(byCol).forEach(function (cid) {
    if (cid === "badges") {
      collectionRankingCache[cid] = buildCollectorsFromBadgeItems(byCol[cid]);
    } else {
      collectionRankingCache[cid] = buildCollectorsFromLoadedItems(byCol[cid]);
    }
  });
  // daCommunity wallet index is authoritative when present (full Base ranking)
  if (walletIndex && (walletIndex.collectors || walletIndex.by_address)) {
    var wiList =
      (walletIndex.collectors && walletIndex.collectors.length
        ? walletIndex.collectors
        : null) || buildCollectorsFromIndex(walletIndex);
    if (wiList && wiList.length) {
      collectionRankingCache.dacommunity = wiList;
    }
  }
}

/**
 * Ensure ranking lists exist for every live collection (loads catalogs if needed).
 * Does not change activeCollection / gallery grid data.
 */
async function ensureAllCollectionRankingCaches() {
  seedRankingCacheFromGalleryData();
  var live = getLiveCollections();
  var prefix = getDataPrefix();
  var stamp = getBuildStamp();
  var q = "?v=" + stamp;

  for (var i = 0; i < live.length; i++) {
    var col = live[i];
    if (!col || !col.id) continue;
    if (collectionRankingCache[col.id] && collectionRankingCache[col.id].length) {
      continue;
    }
    try {
      if (col.id === "dacommunity") {
        if (!walletIndex) {
          try {
            var w = await fetchJson(WALLET_URL, 20000);
            walletIndex = (w && w.holders_index) || w || null;
          } catch (e1) {}
        }
        if (walletIndex) {
          collectionRankingCache.dacommunity =
            (walletIndex.collectors && walletIndex.collectors.length
              ? walletIndex.collectors
              : null) || buildCollectorsFromIndex(walletIndex);
        }
        if (
          !collectionRankingCache.dacommunity ||
          !collectionRankingCache.dacommunity.length
        ) {
          var gUrl = prefix + "data/gallery_catalog.json" + q;
          var g = await fetchJson(gUrl, 20000);
          if (g && g.items) {
            g.items.forEach(function (it) {
              if (!it.collection_id) it.collection_id = "dacommunity";
            });
            collectionRankingCache.dacommunity = buildCollectorsFromLoadedItems(
              g.items
            );
          }
        }
        continue;
      }
      // Secondary: badges / bigkix / agency / future
      var catFile =
        (col.data && col.data.catalog) ||
        (col.id === "badges" ? "badges_catalog.json" : null) ||
        (col.id === "bigkix" ? "bigkix_catalog.json" : null) ||
        (col.id === "dagato-agency" ? "dagato_agency_catalog.json" : null);
      if (!catFile) continue;
      var data = await fetchJson(prefix + "data/" + catFile + q, 20000);
      if (!data || !data.items || !data.items.length) continue;
      data.items.forEach(function (it) {
        if (!it.collection_id) it.collection_id = col.id;
      });
      if (col.id === "badges") {
        collectionRankingCache[col.id] = buildCollectorsFromBadgeItems(data.items);
      } else {
        collectionRankingCache[col.id] = buildCollectorsFromLoadedItems(data.items);
      }
    } catch (e) {
      console.warn("Ranking cache load failed for " + col.id, e);
    }
  }
}

/** Sync ranking from cache (or current list). Filter-independent. */
function getCollectorsRankingList(colId) {
  if (colId && collectionRankingCache[colId] && collectionRankingCache[colId].length) {
    return collectionRankingCache[colId];
  }
  // Fallbacks from whatever is currently in memory
  if (colId === "dacommunity" && walletIndex) {
    return (
      (walletIndex.collectors && walletIndex.collectors.length
        ? walletIndex.collectors
        : null) || buildCollectorsFromIndex(walletIndex)
    );
  }
  var items = (galleryData && galleryData.items) || [];
  if (colId && colId !== "all") {
    items = items.filter(function (i) {
      return (i.collection_id || "dacommunity") === colId;
    });
  }
  if (colId === "badges") return buildCollectorsFromBadgeItems(items);
  return buildCollectorsFromLoadedItems(items);
}

/**
 * Top ranks across ALL live collections (default top 10 each, max 3 badges shown).
 * Independent of collection filter. Active filter's collection is ordered first.
 */
function collectorRankBadges(address, topN, maxBadges) {
  topN = topN || 10;
  maxBadges = maxBadges != null ? maxBadges : MAX_COLLECTOR_RANK_BADGES;
  var key = (address || "").toLowerCase();
  if (!key) return [];
  var out = [];
  var seen = {};
  var live = getLiveCollections();
  live.forEach(function (col) {
    if (!col || !col.id || seen[col.id]) return;
    var list = getCollectorsRankingList(col.id);
    var r = collectorRankInList(key, list);
    if (r && r <= topN) {
      seen[col.id] = true;
      out.push({
        id: col.id,
        rank: r,
        name: col.name || col.id,
        short: collectionRankShortName(col.id, col.name),
      });
    }
  });
  // Prefer current collection first, then best ranks
  var prefer = activeCollection && activeCollection !== "all" ? activeCollection : null;
  out.sort(function (a, b) {
    if (prefer) {
      if (a.id === prefer && b.id !== prefer) return -1;
      if (b.id === prefer && a.id !== prefer) return 1;
    }
    if (a.rank !== b.rank) return a.rank - b.rank;
    return String(a.short).localeCompare(String(b.short));
  });
  return out.slice(0, maxBadges);
}

function rankBadgeClass(colId) {
  if (colId === "bigkix") return "rank-badge-bigkix";
  if (colId === "dagato-agency") return "rank-badge-dagato-agency";
  if (colId === "badges") return "rank-badge-badges";
  if (colId === "dacommunity") return "rank-badge-dacommunity";
  return "rank-badge-archive";
}

function formatRankBadgesHtml(ranks, opts) {
  opts = opts || {};
  if (!ranks || !ranks.length) return "";
  // Compact mobile labels keep the escape-bar single-line (avoid stacked tall pills)
  var compact =
    opts.compact === true ||
    (opts.compact !== false &&
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(max-width: 640px)").matches);
  return ranks
    .map(function (r) {
      var short = r.short;
      if (compact) {
        if (r.id === "bigkix") short = "KIX";
        else if (r.id === "dagato-agency") short = "AGY";
        else if (r.id === "badges") short = "BDG";
        else if (r.id === "dacommunity") short = "COM";
        else short = String(r.short || r.id || "").slice(0, 4);
      }
      var label = opts.short || compact
        ? "#" + r.rank + " " + short
        : "#" + r.rank + " in " + (r.short || short);
      return (
        '<span class="collector-rank-pill ' +
        rankBadgeClass(r.id) +
        (compact ? " collector-rank-pill--compact" : "") +
        '" title="' +
        escapeHtml("#" + r.rank + " among " + (r.name || r.short) + " collectors") +
        '">' +
        escapeHtml(label) +
        "</span>"
      );
    })
    .join("");
}

/** Refresh rank badges on open portfolio after async cache fills. */
async function refreshCollectorRankBadgesAsync() {
  if (!galleryCollectorView || !galleryCollectorView.address) return;
  try {
    await ensureAllCollectionRankingCaches();
  } catch (e) {
    console.warn("ensureAllCollectionRankingCaches", e);
  }
  if (!galleryCollectorView) return;
  var addr = galleryCollectorView.address;
  galleryCollectorView.ranks = collectorRankBadges(addr, 10, MAX_COLLECTOR_RANK_BADGES);
  galleryCollectorView.rank = collectorRank(addr);
  renderCollectorFocusUi();
  // Update profile card ranks if visible
  var ranksWrap = document.querySelector(".collector-profile-ranks");
  if (ranksWrap && galleryCollectorView.ranks) {
    ranksWrap.innerHTML = formatRankBadgesHtml(galleryCollectorView.ranks, {
      short: true,
    });
  }
}

function renderTopCollectors() {
  var wrap = $("#top-collectors");
  var track = $("#top-collectors-track");
  if (!wrap || !track) return;
  if (!collectorsList.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  var labelEl = wrap.querySelector(".top-collectors-label");
  if (labelEl) {
    if (activeCollection === "bigkix") {
      labelEl.textContent = "Heavy collectors in BIG KIX";
    } else if (activeCollection === "dagato-agency") {
      labelEl.textContent = "Heavy collectors in Detective Agency";
    } else if (activeCollection === "badges") {
      labelEl.textContent = "Heavy collectors in Badges";
    } else if (activeCollection === "dacommunity") {
      labelEl.textContent = "Heavy collectors in daCommunity";
    } else {
      labelEl.textContent = "Heavy collectors in the archive";
    }
  }
  var top = collectorsList.slice(0, 8);
  track.innerHTML = top
    .map(function (c) {
      var label = c.ens_name || c.username || shortenAddress(c.address);
      var uq = Number(c.unique_pieces) || 0;
      var cq = Number(c.collection_quantity) || uq;
      // Show unique · copies when multi-qty (BIG KIX editions, multi-file wallets)
      var meta = cq > uq ? uq + "·" + cq : String(uq);
      return (
        '<button type="button" class="top-collector-pill" data-address="' +
        escapeHtml(c.address) +
        '" data-lookup="' +
        escapeHtml(c.ens_name || c.address) +
        '" title="' +
        escapeHtml(uq + " unique · " + cq + " copies held") +
        '">' +
        escapeHtml(label) +
        '<span class="meta">' +
        meta +
        "</span></button>"
      );
    })
    .join("");
  track.querySelectorAll(".top-collector-pill").forEach(function (btn) {
    btn.addEventListener("click", function () {
      runWalletLookupFromAddress(btn.getAttribute("data-address"), btn.getAttribute("data-lookup"));
    });
  });
}

function createHoldingCard(item, holding) {
  var btn = document.createElement("button");
  btn.className = "holding-card";
  btn.type = "button";
  var title = item ? itemTitle(item) : holding.display_name || holding.name || "#" + holding.token_id;
  var listedBadge =
    item && item.listed
      ? '<span class="badge-listed">' +
        (item.listing ? formatEth(item.listing.amount_eth) + " ETH" : "Listed") +
        "</span>"
      : "";
  var rarityBadge = item ? formatRarityBadgeHtml(item) : "";
  var videoBadge = item && isVideoItem(item) ? '<span class="thumb-video-badge">▶</span>' : "";
  btn.innerHTML =
    '<div class="holding-card-media"><div class="holding-card-slot"></div>' +
    videoBadge +
    "</div>" +
    '<div class="holding-card-body">' +
    '<p class="holding-card-title">' +
    (item ? formatPieceTitleHtml(title) : escapeHtml(title)) +
    "</p>" +
    '<div class="holding-card-meta"><span>#' +
    escapeHtml(String(holding.token_id)) +
    "</span>" +
    rarityBadge +
    listedBadge +
    "</div></div>";
  if (item) {
    btn.setAttribute("data-token-id", getItemKey(item));
    fillMediaSlot(btn.querySelector(".holding-card-slot"), item, { controls: false });
    var thumb = btn.querySelector(".holding-card-slot img, .holding-card-slot video");
    if (
      thumb &&
      thumb.tagName === "IMG" &&
      item.opensea_image_url &&
      resolveMediaUrl(item.image_url) !== resolveMediaUrl(item.opensea_image_url)
    ) {
      thumb.addEventListener(
        "error",
        function () {
          thumb.src = resolveMediaUrl(item.opensea_image_url);
        },
        { once: true }
      );
    }
  }
  return btn;
}

function renderHoldingsGrid(holdings, container) {
  if (!container) return;
  container.innerHTML = "";
  var sorted = holdings.slice().sort(function (a, b) {
    return Number(b.token_id) - Number(a.token_id);
  });
  sorted.forEach(function (h) {
    var item = itemsById.get(getItemKey(h));
    container.appendChild(createHoldingCard(item, h));
  });
  if (!sorted.length) {
    container.innerHTML = '<p class="wallet-state-lead">No pieces indexed for this wallet.</p>';
  }
}

/* Share helpers (wallet-specific + new view-level for filters+collection in Part 1).
 * buildCurrentViewUrl + sync ensure share links carry collection + activeFilter/sort/q.
 */
function showSocialShareModal(url, title) {
  title = title || "Check this out on daCommunity Gallery";
  var id = "social-share-modal";
  var existing = document.getElementById(id);
  if (existing) existing.remove();

  var modal = document.createElement("div");
  modal.id = id;
  modal.className = "social-share-modal";
  modal.innerHTML =
    '<div class="social-share-backdrop"></div>' +
    '<div class="social-share-card">' +
      '<button class="social-close" aria-label="Close">×</button>' +
      '<h3>Share</h3>' +
      '<div class="social-buttons">' +
        '<a class="social-btn" data-type="x" target="_blank" rel="noopener">𝕏 Post</a>' +
        '<a class="social-btn" data-type="tg" target="_blank" rel="noopener">Telegram</a>' +
        '<a class="social-btn" data-type="fb" target="_blank" rel="noopener">Facebook</a>' +
        '<button class="social-btn copy" data-type="copy">📋 Copy link</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  var close = function () { modal.remove(); };
  modal.querySelector(".social-share-backdrop").addEventListener("click", close);
  modal.querySelector(".social-close").addEventListener("click", close);

  var encodedUrl = encodeURIComponent(url);
  var encodedTitle = encodeURIComponent(title);

  var x = modal.querySelector('[data-type="x"]');
  x.href = "https://x.com/intent/tweet?text=" + encodedTitle + "&url=" + encodedUrl;

  var tg = modal.querySelector('[data-type="tg"]');
  tg.href = "https://t.me/share/url?url=" + encodedUrl + "&text=" + encodedTitle;

  var fb = modal.querySelector('[data-type="fb"]');
  fb.href = "https://www.facebook.com/sharer/sharer.php?u=" + encodedUrl;

  var copyBtn = modal.querySelector('[data-type="copy"]');
  copyBtn.addEventListener("click", function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        copyBtn.textContent = "Copied!";
        setTimeout(close, 700);
      }).catch(function () {
        prompt("Copy link:", url);
        close();
      });
    } else {
      prompt("Copy link:", url);
      close();
    }
  });
}

function shareCollectorCollection(address) {
  if (!address) return;
  // Use the standard share modal (same as main gallery view) which handles social options and centers properly.
  // The current URL (synced with ?wallet=) will be used by buildCurrentViewUrl inside showShareModal.
  showShareModal();
}

/* === Share Modal (Part 1) — copyable URL with current collection + filters + social quick-links.
 * Mobile bottom-sheet via CSS; desktop centered. Reuses existing toast / URL helpers.
 */
function buildCurrentViewUrl() {
  syncBrowseParamsToUrl();
  return window.location.href;
}

function showShareModal() {
  var modal = $("#share-modal");
  if (!modal) return;
  var url = buildCurrentViewUrl();
  var copyBtn = $("#share-copy-btn");
  if (copyBtn) {
    copyBtn.onclick = function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          showCopyToast("Link copied (includes collection + filters)");
        }).catch(function () {
          showCopyToast("Copy: " + url);
        });
      } else {
        showCopyToast("Copy: " + url);
      }
      closeShareModal();
    };
  }
  modal.querySelectorAll(".share-social-btn").forEach(function (btn) {
    btn.onclick = function () {
      var platform = btn.getAttribute("data-platform");
      shareToSocial(platform, url);
    };
  });
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeShareModal() {
  var modal = $("#share-modal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  if (!$("#detail-panel").classList.contains("open") && !$("#collectors-modal").classList.contains("open")) {
    document.body.style.overflow = "";
  }
}

function shareToSocial(platform, url) {
  var text = encodeURIComponent("daCAT archive view — filters & collection included");
  var u = encodeURIComponent(url);
  var href = "";
  if (platform === "x") {
    href = "https://twitter.com/intent/tweet?text=" + text + "&url=" + u;
  } else if (platform === "telegram") {
    href = "https://t.me/share/url?url=" + u + "&text=" + text;
  } else if (platform === "facebook") {
    href = "https://www.facebook.com/sharer/sharer.php?u=" + u;
  } else if (platform === "instagram") {
    // No direct web share; copy link and hint
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url);
    }
    showCopyToast("Link copied — paste into Instagram story or post");
    closeShareModal();
    return;
  }
  if (href) {
    window.open(href, "_blank", "noopener");
  }
  closeShareModal();
}

function bindCollectorResultActions(entry) {
  var address = entry.address;
  var shareBtn = $("#wallet-share-btn");
  if (shareBtn && !shareBtn.dataset.boundShare) {
    shareBtn.dataset.boundShare = "1";
    shareBtn.addEventListener("click", function () {
      shareCollectorCollection(address);
    });
  }
  var copyBtn = $("#wallet-copy-address");
  if (copyBtn && !copyBtn.dataset.boundCopy) {
    copyBtn.dataset.boundCopy = "1";
    copyBtn.addEventListener("click", function () {
      copyFullAddress(address);
    });
  }
}

function bindCollectorHeaderActions() {
  var shareBtn = $("#collector-share-btn");
  if (shareBtn && !shareBtn.dataset.boundShare) {
    shareBtn.dataset.boundShare = "1";
    shareBtn.addEventListener("click", function () {
      if (galleryCollectorView && galleryCollectorView.address) {
        shareCollectorCollection(galleryCollectorView.address);
      }
    });
  }
  var copyBtn = $("#collector-copy-address");
  if (copyBtn && !copyBtn.dataset.boundCopy) {
    copyBtn.dataset.boundCopy = "1";
    copyBtn.addEventListener("click", function () {
      if (galleryCollectorView && galleryCollectorView.address) {
        copyFullAddress(galleryCollectorView.address);
      }
    });
  }
}

function renderWalletState(kind, opts) {
  opts = opts || {};
  var resultEl = $("#wallet-result");
  if (!resultEl) return;
  resultEl.hidden = false;
  if (kind === "loading") {
    resultEl.innerHTML =
      '<div class="wallet-state wallet-state-loading">' +
      '<div class="spinner" aria-hidden="true"></div>' +
      "<div><p class=\"wallet-state-title\">Tracing the archive…</p>" +
      '<p class="wallet-state-lead">Checking our daily collector index.</p></div></div>';
    return;
  }
  if (kind === "error") {
    resultEl.innerHTML =
      '<div class="wallet-state wallet-state-error">' +
      '<p class="wallet-state-title">' +
      escapeHtml(opts.title || "Could not find that collector") +
      "</p>" +
      '<p class="wallet-state-lead">' +
      escapeHtml(opts.message || "") +
      "</p>" +
      (opts.hint
        ? '<p class="wallet-state-lead">' + escapeHtml(opts.hint) + "</p>"
        : "") +
      '<button type="button" class="btn btn-dark" id="wallet-retry-btn">Try another address</button></div>';
    var retry = $("#wallet-retry-btn");
    if (retry) {
      retry.addEventListener("click", function () {
        var input = $("#wallet-input");
        if (input) {
          input.value = "";
          input.focus();
        }
        resultEl.hidden = true;
        resultEl.innerHTML = "";
      });
    }
  }
}

function renderWalletSuccess(entry, opts) {
  var resultEl = $("#wallet-result");
  if (!resultEl) return;
  var label = entry.ens_name || entry.username || shortenAddress(entry.address);
  var holdings = entry.holdings || [];
  var holdStats = holdings.length ? summarizeHoldingsStats(holdings) : null;
  var uq = holdStats ? holdStats.unique_pieces : nvl(entry.unique_pieces, holdings.length);
  var qty = holdStats ? holdStats.collection_quantity : nvl(entry.collection_quantity, "—");
  // Keep entry in sync so setGalleryCollectorView sees correct qty
  entry.unique_pieces = uq;
  entry.collection_quantity = qty;
  rebuildCollectorsForCurrentView();
  seedRankingCacheFromGalleryData();
  var ranks = collectorRankBadges(entry.address, 10, MAX_COLLECTOR_RANK_BADGES);
  var rankHtml = ranks.length
    ? '<div class="collector-profile-ranks">' +
      formatRankBadgesHtml(ranks, { short: true }) +
      "</div>"
    : "";

  resultEl.hidden = false;
  resultEl.innerHTML =
    '<div class="collector-profile-card collector-profile-card--theater">' +
    '<div class="collector-profile-main">' +
    '<p class="collector-profile-eyebrow">Collector</p>' +
    '<p class="collector-profile-name">' +
    escapeHtml(label) +
    "</p>" +
    (entry.ens_name && entry.username
      ? '<p class="collector-profile-ens">' + escapeHtml(entry.username) + "</p>"
      : "") +
    '<p class="collector-profile-address">' +
    escapeHtml(entry.address) +
    "</p>" +
    '<p class="collector-profile-stats">' +
    uq +
    " unique piece" +
    (uq === 1 ? "" : "s") +
    " · " +
    qty +
    " copies in collection</p>" +
    rankHtml +
    "</div>" +
    '<div class="collector-actions">' +
    '<button type="button" class="btn btn-accent" id="wallet-share-btn">Share your daCATs</button>' +
    '<button type="button" class="btn btn-outline btn-sm" id="wallet-copy-address">Copy address</button>' +
    "</div></div>" +
    '<h3 class="holdings-heading">Pieces in the archive (' +
    holdings.length +
    ")</h3>" +
    '<div class="holdings-grid" id="wallet-holdings-grid"></div>';
  // Async: fill ranks for collections not in the current filter (up to 3 top-10s)
  refreshCollectorRankBadgesAsync();

  renderHoldingsGrid(holdings, $("#wallet-holdings-grid"));
  bindCollectorResultActions(entry);
  var hub = resultEl.closest && resultEl.closest(".collector-hub");
  if (hub) hub.classList.add("has-result");
  setGalleryCollectorView(entry, { scrollBehavior: opts && opts.scrollBehavior });
}

function clearWalletResultHighlight() {
  var hub = document.querySelector(".collector-hub");
  if (hub) hub.classList.remove("has-result");
}

function addressActionHtml(address) {
  if (!address || !/^0x[a-fA-F0-9]{40}$/i.test(address)) {
    return escapeHtml(address || "");
  }
  var meta = addressDisplayMeta(address);
  return (
    '<span class="addr-action">' +
    '<button type="button" class="addr-action-lookup" data-address="' +
    escapeHtml(meta.address) +
    '" data-lookup="' +
    escapeHtml(meta.lookupValue) +
    '" title="View this collector in the archive" aria-label="View collector ' +
    escapeHtml(meta.display) +
    '">' +
    escapeHtml(meta.display) +
    "</button>" +
    '<span class="addr-view-hint">· view</span>' +
    '<button type="button" class="addr-action-copy" data-copy="' +
    escapeHtml(meta.address) +
    '" title="Copy full address">Copy</button></span>'
  );
}

function bindAddressActions(root) {
  if (!root) return;
  root.querySelectorAll(".addr-action-copy").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      copyFullAddress(btn.getAttribute("data-copy"));
    });
  });
  root.querySelectorAll(".addr-action-lookup").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      applyCollectorView(btn.getAttribute("data-address"));
    });
  });
}

function isEthAddress(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

function isEnsName(v) {
  var s = v.trim().toLowerCase();
  return (s.endsWith(".eth") || s.endsWith(".base.eth")) && s.length > 4;
}

async function resolveEnsToAddress(name) {
  var url = "https://ensdata.net/" + encodeURIComponent(name.trim());
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 10000);
  try {
    var res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("ENS name could not be resolved.");
    var data = await res.json();
    var addr = data.address || (data.wallets && data.wallets.eth);
    if (!addr) throw new Error("No address found for this ENS name.");
    return addr.toLowerCase();
  } finally {
    clearTimeout(timer);
  }
}

function buildHoldingsFromCurrentItems(address) {
  var addr = (address || '').toLowerCase();
  var holdings = [];
  var seen = {};
  (galleryData && galleryData.items || []).forEach(function (item) {
    var key = getItemKey(item);
    if (seen[key]) return;
    var ownersData = item.owners || {};
    var list = ownersData.holders || ownersData.top_holders || [];
    var qty = 0;
    list.forEach(function (o) {
      if ((o.address || '').toLowerCase() === addr) {
        var q = Number(o.quantity);
        qty += !isNaN(q) && q > 0 ? q : 1;
      }
    });
    if (qty > 0) {
      // Multi 1:1 clubs: series_rep is search-only. Edition clubs (e.g. 100 Billion) use
      // series_rep as the real collectible card and must still appear for holders.
      if (item.is_series_rep && item.source_created_collection && /trillion|billion/i.test(item.source_created_collection) && !item.edition_club) return;
      // Agency: portfolio shows real case files, not aggregated rarity rows
      if (isAgencyRaritySeries(item)) return;
      seen[key] = true;
      holdings.push({
        token_id: item.token_id,
        name: item.display_name || item.name,
        display_name: item.display_name || item.name,
        image_url: item.image_url,
        opensea_url: item.opensea_url,
        source_created_collection: item.source_created_collection,
        collection_id: item.collection_id,
        rarity: item.rarity,
        quantity: qty
      });
    }
  });
  return holdings;
}

function lookupWallet(identifier) {
  var raw = identifier.trim();
  if (!raw) {
    return {
      error: "Paste an ENS name or 0x address to see what's in the archive.",
      title: "Need an address",
    };
  }

  // Resolve ENS to address early so synth always gets a 0x (synth fails on ENS strings)
  var address = raw.toLowerCase();
  var needsResolve = false;
  if (isEnsName(raw)) {
    var alias = (walletIndex && walletIndex.ens_aliases && walletIndex.ens_aliases[raw.toLowerCase()]) || null;
    if (alias) {
      address = alias.toLowerCase();
    } else {
      needsResolve = true;
    }
  } else if (!isEthAddress(raw)) {
    return {
      error: "That doesn't look like a valid ENS (.eth / .base.eth) or 0x address.",
      title: "Check the format",
      hint: "Example: mozvane.eth or 0xabc…1234",
    };
  }

  // Try synthetic holdings from whatever is currently loaded in galleryData (badges items have owners lists).
  // This works even if walletIndex is not loaded for this view. Always use resolved 0x here.
  var synth = buildHoldingsFromCurrentItems(address);
  if (synth.length > 0) {
    var meta = (walletIndex && walletIndex.by_address && walletIndex.by_address[address]) || {};
    // Also pick ens directly from the badge item owners (populated by fetch or enrich)
    var foundEns = null;
    var foundUser = null;
    (galleryData && galleryData.items || []).forEach(function (item) {
      var list = (item.owners || {}).holders || (item.owners || {}).top_holders || [];
      list.forEach(function (o) {
        if ((o.address || "").toLowerCase() === address && o.ens_name) {
          foundEns = o.ens_name;
          if (o.username) foundUser = o.username;
        }
      });
    });
    // Prefer the ens_name used in the Heavy collectors list (collectorsList) so that
    // clicking a name there (e.g. daforeman.eth) shows the same current ENS in the portfolio view,
    // instead of an older name that may be stuck in badge owners data for some items.
    var fromList = null;
    (collectorsList || []).forEach(function (c) {
      if ((c.address || '').toLowerCase() === address && c.ens_name) {
        fromList = c.ens_name;
      }
    });
    var synthStats = summarizeHoldingsStats(synth);
    return {
      entry: {
        address: address,
        holdings: synth,
        unique_pieces: synthStats.unique_pieces,
        collection_quantity: synthStats.collection_quantity,
        ens_name: fromList || foundEns || meta.ens_name || null,
        username: foundUser || meta.username || null
      }
    };
  }

  if (needsResolve) {
    return { needsResolve: true, ens: raw };
  }

  if (!walletIndex || !walletIndex.by_address) {
    // Kick off load in background for future calls / ENS; fall through to no-pieces if none.
    loadWalletIndex().catch(function(){});
  }

  var entry = walletIndex && walletIndex.by_address && walletIndex.by_address[address];
  if (!entry) {
    return {
      error: "This wallet has no pieces in the current snapshot (dacommunity or badges).",
      title: "No pieces found",
      hint: "They may hold badges or other collections not yet indexed, or try a different address.",
      address: address,
    };
  }
  return { entry: entry };
}

function renderHoldingsChips(holdings, container, opts) {
  opts = opts || {};
  var highlightTokenId = opts.highlightTokenId;
  container.innerHTML = "";
  var html = holdings
    .map(function (h) {
      var item = itemsById.get(getItemKey(h));
      var src = item ? imgSrc(item) : "";
      var name = h.display_name || h.name || (item ? itemTitle(item) : "#" + h.token_id);
      var hi = highlightTokenId && String(h.token_id) === String(highlightTokenId) ? " holding-chip-current" : "";
      var img = src && !(item && isVideoItem(item)) ? '<img src="' + escapeHtml(src) + '" alt="" loading="lazy" />' : "";
      return '<button type="button" class="holding-chip' + hi + '" data-token="' + h.token_id + '">' + img + "<span>" + escapeHtml(name) + "</span></button>";
    })
    .join("");
  container.innerHTML = html || "<span class='empty'>No pieces indexed.</span>";
  container.querySelectorAll(".holding-chip").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var item = itemsById.get(btn.dataset.token);
      if (item) openDetail(item);
    });
  });
}

async function renderWalletLookup(identifier, opts) {
  opts = opts || {};
  clearWalletResultHighlight();
  renderWalletState("loading");

  // Always ensure wallet index is available (for ENS + cross lookup) before deciding errors.
  // Synth path (badges owners etc) takes priority inside lookupWallet regardless.
  if (!walletIndex) {
    try { await loadWalletIndex(); } catch (e) { /* non-fatal */ }
  }

  // In badges collection context, ensure collectorsList reflects the current badge items
  // (loadWalletIndex may have clobbered it in the !wallet_index_file fallback path).
  if (
    activeCollection === "badges" ||
    activeCollection === "bigkix" ||
    activeCollection === "dagato-agency"
  ) {
    if (activeCollection === "badges") {
      collectorsList = buildCollectorsFromBadgeItems(galleryData ? galleryData.items : []);
    } else {
      collectorsList = buildCollectorsFromLoadedItems(galleryData ? galleryData.items : []);
    }
  }

  var lookup = lookupWallet(identifier);

  if (lookup.needsResolve) {
    try {
      var addr = await resolveEnsToAddress(lookup.ens);
      lookup = lookupWallet(addr);
    } catch (e) {
      renderWalletState("error", {
        title: "ENS didn't resolve",
        message: e.message || "Could not map that name to an address.",
        hint: "Try the full 0x address instead.",
      });
      return;
    }
  }

  if (lookup.error) {
    clearGalleryCollectorView({ clearResult: false });
    renderWalletState("error", {
      title: lookup.title,
      message: lookup.error,
      hint: lookup.hint,
    });
    return;
  }

  var entry = lookup.entry;
  renderWalletSuccess(entry, opts);
  if (opts.updateUrl !== false) syncWalletShareUrl(entry.address);
}

function updateCollectorsButton() {
  var btn = $("#view-collectors-btn");
  var n = (collectorsList && collectorsList.length) || 0;
  if (btn) btn.hidden = !n;
  // Never permanently disable: cold loads of ?collection=bigkix can race before owners
  // are indexed. Click handler always rebuilds; only dim when truly empty after rebuild.
  document.querySelectorAll(".stat-collectors").forEach(function (el) {
    el.disabled = false;
    el.style.opacity = n ? "1" : "0.75";
    el.style.cursor = "pointer";
    el.setAttribute("aria-disabled", n ? "false" : "true");
  });
  renderTopCollectors();
}

function openCollectorsModal() {
  rebuildCollectorsForCurrentView();
  updateCollectorsButton();
  if (!collectorsList.length) {
    // Last-chance rebuild from raw item owners (BIG KIX / secondary cold load)
    if (galleryData && galleryData.items && galleryData.items.length) {
      if (activeCollection === "badges") {
        collectorsList = buildCollectorsFromBadgeItems(galleryData.items);
      } else if (activeCollection && activeCollection !== "dacommunity") {
        collectorsList = buildCollectorsFromLoadedItems(galleryData.items);
      }
      updateCollectorsButton();
    }
  }
  if (!collectorsList.length) return;
  var modal = $("#collectors-modal");
  renderCollectors($("#collectors-search") ? $("#collectors-search").value : "");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  var search = $("#collectors-search");
  if (search) setTimeout(function () { search.focus(); }, 200);
}

function closeCollectorsModal() {
  var modal = $("#collectors-modal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  if (!$("#detail-panel").classList.contains("open")) {
    document.body.style.overflow = "";
  }
}

function exploreCollector(address, highlightTokenId) {
  var key = address.toLowerCase();
  var entry = walletIndex && walletIndex.by_address && walletIndex.by_address[key];
  var explore = $("#collector-explore");
  if (!entry) {
    // Prefer full synth from current loaded items (badges context, or mixed after "all" merge)
    // so "view collector" / owner chips can show their actual owned pieces even for pure-badge holders.
    var synth = buildHoldingsFromCurrentItems(key);
    if (synth.length > 0) {
      entry = {
        address: key,
        holdings: synth,
      };
    } else if (activeDetailTokenId) {
      var piece = itemsById.get(activeDetailTokenId);
      if (piece && holderRowForToken(piece, key)) {
        entry = {
          address: key,
          holdings: [
            {
              token_id: piece.token_id,
              name: itemTitle(piece),
              display_name: piece.display_name,
            },
          ],
        };
      }
    }
  }
  if (!entry) {
    explore.hidden = true;
    return;
  }
  activeCollectorAddress = key;
  $("#collector-explore-title").textContent =
    "Pieces held by " + holderLabel(address) + " (tap another holder above)";
  renderHoldingsChips(entry.holdings || [], $("#collector-explore-holdings"), {
    highlightTokenId: highlightTokenId,
  });
  explore.hidden = false;
  document.querySelectorAll(".owner-chip").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.address === activeCollectorAddress);
  });
}

function renderCollectors(filter) {
  var list = $("#collectors-list");
  if (!list) return;
  if (!collectorsList.length) {
    list.innerHTML = "<p class='wallet-result empty'>No collectors indexed yet.</p>";
    return;
  }
  var q = (filter || "").trim().toLowerCase();
  var rows = collectorsList;
  if (q) {
    rows = rows.filter(function (c) {
      return (
        (c.ens_name || "").toLowerCase().indexOf(q) >= 0 ||
        (c.username || "").toLowerCase().indexOf(q) >= 0 ||
        c.address.toLowerCase().indexOf(q) >= 0
      );
    });
  }
  list.innerHTML = rows
    .map(function (c) {
      var label = c.ens_name || c.username || shortenAddress(c.address);
      var uq = Number(c.unique_pieces) || 0;
      var cq = Number(c.collection_quantity) || uq;
      var countLabel =
        cq > uq
          ? uq + " unique · " + cq + " copies"
          : uq + " piece" + (uq === 1 ? "" : "s");
      return (
        '<button type="button" class="collector-row" data-address="' + escapeHtml(c.address) + '">' +
        '<div class="collector-info"><strong>' + escapeHtml(label) + '</strong><span class="meta">' + escapeHtml(c.ens_name || c.address) + "</span></div>" +
        '<span class="count">' + countLabel + "</span></button>"
      );
    })
    .join("");
  list.querySelectorAll(".collector-row").forEach(function (btn) {
    btn.addEventListener("click", function () {
      closeCollectorsModal();
      runWalletLookupFromAddress(btn.dataset.address, btn.dataset.address);
    });
  });
}

function fillMediaSlot(slot, item, opts) {
  opts = opts || {};
  slot.innerHTML = "";
  var src = imgSrc(item);
  // Prefer opensea video source for video items (e.g. gem nova green in generic search/detail)
  // or personalized in portfolio. Fall back to current src (png for generic).
  if (item && item.opensea_image_url && /^https?:/i.test(item.opensea_image_url) && /\.(mp4|mov|webm)/i.test(item.opensea_image_url)) {
    if (isVideoItem(item) || galleryCollectorView || (opts && (opts.autoplay || opts.controls))) {
      src = resolveMediaUrl(item.opensea_image_url);
    }
  } else if (galleryCollectorView && item && item.opensea_image_url && /^https?:/i.test(item.opensea_image_url)) {
    src = resolveMediaUrl(item.opensea_image_url);
  }
  if (!src) return;
  var effectiveVideo = isVideoItem(item) || /\.(mp4|mov|webm)(\?|$)/i.test(src || "");
  if (effectiveVideo) {
    var v = document.createElement("video");
    v.className = "thumb-media";
    v.src = src;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    if (opts.autoplay) v.autoplay = true;
    if (opts.controls !== false && opts.autoplay) v.controls = true;
    else if (opts.controls) v.controls = true;
    v.setAttribute("aria-label", itemTitle(item));
    slot.appendChild(v);
  } else {
    var img = document.createElement("img");
    img.className = "thumb-media";
    img.src = src;
    img.alt = itemTitle(item);
    img.loading = "lazy";
    img.decoding = "async";
    if (item.opensea_image_url && resolveMediaUrl(item.image_url) !== resolveMediaUrl(item.opensea_image_url)) {
      img.addEventListener("error", function () { img.src = resolveMediaUrl(item.opensea_image_url); }, { once: true });
    }
    slot.appendChild(img);
  }
}

function statCollectorsValue(collection) {
  if (collection.num_owners != null) return collection.num_owners;
  if (collectorsList.length) return collectorsList.length;
  return "—";
}

function renderHeroNote(collection) {
  var note = $("#hero-note");
  if (!note) return;

  var collId = activeCollection;
  var steward = (collection && collection.creator_ens) || "dacatdreams.base.eth";

  var html;
  if (collId === "dacommunity") {
    // Exact text for the NFT archive (Rodeo/Base)
    html = "Originally minted on Rodeo. Contract on Base, stewarded by " +
      '<strong class="steward-name">dacatdreams.base.eth</strong>.';
  } else if (collId === "badges") {
    // Exact text for badges
    html = "Originally minted on OpenSea. Contract on Ethereum, stewarded by " +
      '<strong class="steward-name">dacatworld.eth</strong>.';
  } else if (collId === "bigkix") {
    html =
      "Character kicks from DACAT WORLD on Ethereum. Stewarded by " +
      '<strong class="steward-name">dacatworld.eth</strong>.';
  } else if (collId === "dagato-agency") {
    html =
      "Cyber-noir detective case files on Ethereum. Stewarded by " +
      '<strong class="steward-name">dagato.eth</strong>. Complete limited drop — all holders counted.';
  } else {
    note.hidden = true;
    return;
  }

  note.innerHTML = html;
  note.hidden = false;
}

function renderStats(collection) {
  var strip = $("#stats-strip");
  strip.innerHTML = "";

  // Compute dynamic stats based on current filter ("badges", dacommunity, or "all")
  var pieces = nvl(collection && collection.piece_count, 0);
  var collectorsVal = statCollectorsValue(collection);
  var floorVal = formatEth(collection && collection.floor_eth) + " " + ((collection && collection.floor_symbol) || "ETH");
  var listedVal = nvl(collection && collection.listed_count, "—");

  if (!activeCollection || activeCollection === "all") {
    // Combined stats for All collections
    var allItems = (galleryData && galleryData.items) || [];
    // Deduped to match grid (dacom + 15 badges series, not raw badge 1/1s)
    pieces = getDedupedPiecesCount(allItems);

    // listed and floor from current items
    var listed = 0;
    var minFloor = null;
    allItems.forEach(function (it) {
      if (it.listed) {
        listed++;
        if (it.listing && it.listing.amount_eth != null) {
          var p = Number(it.listing.amount_eth);
          if (!isNaN(p) && (minFloor === null || p < minFloor)) minFloor = p;
        }
      }
    });
    listedVal = listed > 0 ? listed : "—";
    floorVal = minFloor != null ? formatEth(minFloor) + " ETH" : "—";

    // collectors: prefer walletIndex length if loaded, else unique from current owners (approx)
    if (collectorsList && collectorsList.length) {
      collectorsVal = collectorsList.length;
    } else {
      var uniq = {};
      allItems.forEach(function (it) {
        var os = (it.owners || {}).holders || (it.owners || {}).top_holders || [];
        os.forEach(function (o) { if (o.address) uniq[o.address.toLowerCase()] = true; });
      });
      collectorsVal = Object.keys(uniq).length || "—";
    }
  } else if (activeCollection === "badges") {
    // Badges specific: count using same dedup logic as search grid (15 unique nfts)
    var bItems = (galleryData && galleryData.items) || [];
    pieces = getDedupedPiecesCount(bItems);
    listedVal = "—"; // badges rarely listed in this data
    floorVal = "—";
    // collectors approx from owners (unique wallets across all badge NFTs)
    var uniqB = {};
    bItems.forEach(function (it) {
      var os = (it.owners || {}).holders || (it.owners || {}).top_holders || [];
      os.forEach(function (o) { if (o.address) uniqB[o.address.toLowerCase()] = true; });
    });
    collectorsVal = Object.keys(uniqB).length || nvl(collection && collection.num_owners, "—");
  } else if (
    activeCollection === "bigkix" ||
    activeCollection === "dagato-agency"
  ) {
    var kItems = (galleryData && galleryData.items) || [];
    // Prefer live list so stats match the grid + collectors modal
    rebuildCollectorsForCurrentView();
    // Agency browse grid = 5 rarity series only (not 33 case files)
    if (activeCollection === "dagato-agency") {
      pieces =
        getDedupedPiecesCount(kItems) ||
        nvl(collection && collection.piece_count, "—");
    } else {
      pieces = kItems.length || nvl(collection && collection.piece_count, "—");
    }
    var listedK = 0;
    var minFloorK = null;
    var listedScan =
      activeCollection === "dagato-agency"
        ? kItems.filter(function (it) {
            return isAgencyRaritySeries(it);
          })
        : kItems;
    listedScan.forEach(function (it) {
      if (it.listed) {
        listedK++;
        if (it.listing && it.listing.amount_eth != null) {
          var pk = Number(it.listing.amount_eth);
          if (!isNaN(pk) && (minFloorK === null || pk < minFloorK)) minFloorK = pk;
        }
      }
    });
    listedVal = listedK > 0 ? listedK : nvl(collection && collection.listed_count, "—");
    floorVal =
      minFloorK != null
        ? formatEth(minFloorK) + " ETH"
        : collection && collection.floor_eth != null
          ? formatEth(collection.floor_eth) + " " + (collection.floor_symbol || "ETH")
          : "—";
    // Must match modal list length (never show num_owners while list is empty → greyed tile)
    collectorsVal =
      collectorsList && collectorsList.length
        ? collectorsList.length
        : "—";
  }

  var defs = [
    { label: "Pieces", value: pieces || "—", clickable: false },
    { label: "Collectors", value: collectorsVal, clickable: true },
    { label: "Floor", value: floorVal, clickable: false },
    { label: "Listed", value: listedVal, clickable: false },
  ];
  defs.forEach(function (s) {
    var el = document.createElement(s.clickable ? "button" : "div");
    el.className = "stat" + (s.clickable ? " stat-collectors" : "");
    el.innerHTML = '<span class="stat-value">' + s.value + '</span><span class="stat-label">' + s.label + "</span>";
    if (s.clickable) {
      el.type = "button";
      el.title = "View all collectors";
      el.setAttribute("aria-label", "View collectors");
      el.disabled = false;
      el.style.opacity = "1";
      el.addEventListener("click", function () {
        // Always rebuild for current collection filter, then open (dynamic like daCommunity)
        rebuildCollectorsForCurrentView();
        updateCollectorsButton();
        if (collectorsList && collectorsList.length) {
          openCollectorsModal();
        }
      });
    }
    strip.appendChild(el);
  });
  // Sync enabled state with live list (after rebuild above for bigkix path)
  updateCollectorsButton();

  // Show the hero steward note ONLY when a specific collection filter is active:
  //   ?collection=dacommunity → "Originally minted on Rodeo. Contract on Base, stewarded by dacatdreams.base.eth."
  //   ?collection=badges      → "Originally minted on OpenSea. Contract on Ethereum, stewarded by dacatworld.eth."
  // Hidden on bare /dacommunity/ (activeCollection "all") and after "Clear all".
  if (activeCollection && activeCollection !== "all") {
    var col = getCurrentCollection();
    var noteCol = collection || (galleryData && galleryData.collection) || {};
    if (col && col.creator_ens) noteCol.creator_ens = col.creator_ens;
    renderHeroNote(noteCol);
  } else {
    var note = $("#hero-note");
    if (note) note.hidden = true;
  }
}

function itemLatestTransferAt(item) {
  var owners = item.owners || {};
  if (owners.latest_change && owners.latest_change.at) return owners.latest_change.at;
  var rows = item.recent_activity || [];
  if (rows.length && rows[0].at) return rows[0].at;
  return null;
}

function hasRecentActivity(item, withinDays) {
  withinDays = withinDays || 90;
  var at = itemLatestTransferAt(item);
  if (!at) return false;
  var ageH = hoursSince(at);
  return ageH !== null && ageH <= withinDays * 24;
}

function itemMatchesSearch(item, q) {
  if (!q) return true;
  var steward = collectionStewardLabel().toLowerCase();
  if (steward.indexOf(q) >= 0) return true;
  var holders = (item.owners && item.owners.holders) || [];
  for (var i = 0; i < holders.length; i++) {
    var addr = holders[i].address;
    if (addr && addr.toLowerCase().indexOf(q) >= 0) return true;
    if (walletIndex && walletIndex.by_address) {
      var entry = walletIndex.by_address[addr.toLowerCase()];
      if (entry) {
        if ((entry.ens_name || "").toLowerCase().indexOf(q) >= 0) return true;
        if ((entry.username || "").toLowerCase().indexOf(q) >= 0) return true;
      }
    }
  }
  var rarity = (itemRarityLabel(item) || "").toLowerCase();
  return (
    itemTitle(item).toLowerCase().indexOf(q) >= 0 ||
    (item.name || "").toLowerCase().indexOf(q) >= 0 ||
    (item.description || "").toLowerCase().indexOf(q) >= 0 ||
    (item.excerpt || "").toLowerCase().indexOf(q) >= 0 ||
    (item.local_slug || "").toLowerCase().indexOf(q) >= 0 ||
    (rarity && rarity.indexOf(q) >= 0) ||
    String(item.token_id).indexOf(q) >= 0
  );
}

function compareItems(a, b) {
  // Agency rarity series always order by token_rank (1:1 first … Common last)
  if (
    a.token_rank != null &&
    b.token_rank != null &&
    isAgencyRaritySeries(a) &&
    isAgencyRaritySeries(b)
  ) {
    var ra = Number(a.token_rank) - Number(b.token_rank);
    if (ra !== 0) return ra;
  }
  var key = sortKey || "token_desc";
  if (key === "token_desc") {
    var da = Date.parse(a.minted_at || 0) || 0;
    var db = Date.parse(b.minted_at || 0) || 0;
    if (da && db && da !== db) return db - da; // newest first across collections
    if (da && !db) return -1;
    if (!da && db) return 1;
    return Number(b.token_id) - Number(a.token_id);
  }
  if (key === "token_asc") {
    var da2 = Date.parse(a.minted_at || 0) || 0;
    var db2 = Date.parse(b.minted_at || 0) || 0;
    if (da2 && db2 && da2 !== db2) return da2 - db2;
    if (da2 && !db2) return 1;
    if (!da2 && db2) return -1;
    return Number(a.token_id) - Number(b.token_id);
  }
  if (key === "name_asc") {
    return itemTitle(a).localeCompare(itemTitle(b), undefined, { sensitivity: "base" });
  }
  if (key === "price_asc" || key === "price_desc") {
    var pa = a.listed && a.listing ? Number(a.listing.amount_eth) : null;
    var pb = b.listed && b.listing ? Number(b.listing.amount_eth) : null;
    if (pa == null && pb == null) return Number(b.token_id) - Number(a.token_id);
    if (pa == null) return 1;
    if (pb == null) return -1;
    if (pa !== pb) return key === "price_asc" ? pa - pb : pb - pa;
    return Number(b.token_id) - Number(a.token_id);
  }
  if (key === "transfer_desc") {
    var ta = Date.parse(itemLatestTransferAt(a) || 0) || 0;
    var tb = Date.parse(itemLatestTransferAt(b) || 0) || 0;
    if (tb !== ta) return tb - ta;
    return Number(b.token_id) - Number(a.token_id);
  }
  return Number(b.token_id) - Number(a.token_id);
}

/* === Core Browse Logic (filter + sort + collection scoping) === */
/** Apply searchQuery, activeFilter, sortKey, activeCollection, and optional galleryCollectorView scope.
 *  Collection filter added for Part 1; falls back gracefully for legacy data.
 */
function getFilteredItems() {
  if (!galleryData || !galleryData.items) return [];
  var items = galleryData.items.slice();
  if (galleryCollectorView) {
    var addr = (galleryCollectorView.address || "").toLowerCase();
    var tidSet = galleryCollectorView.tokenIds || {};
    items = items.filter(function (i) {
      // Prioritize exact owner match from the item's owners list. This is critical for badges
      // (where token_id is a rep id and not unique/ownership token) to ensure only truly owned
      // series are shown, matching OpenSea data.
      var owners = (i.owners || {});
      var holders = owners.holders || owners.top_holders || [];
      var match = false;
      for (var j=0; j<holders.length; j++) {
        if ((holders[j].address || "").toLowerCase() === addr) {
          match = true;
          break;
        }
      }
      if (match) {
        // For multi-1of1 clubs, skip the series rep in portfolio; only the personal 1:1.
        // Edition clubs (identical copies, e.g. 100 Billion) keep the series card for holders.
        if (i.source_created_collection && /trillion|billion/i.test(i.source_created_collection) && i.is_series_rep && !i.edition_club) {
          return false;
        }
        // Agency: portfolio shows case files with real token #s, not rarity aggregates
        if (isAgencyRaritySeries(i)) return false;
        return true;
      }
      if (i.source_created_collection) {
        // badges: only trust owner match (token_ids collide across series, rep tokens not unique)
        return false;
      }
      // Fallback key match for main dacommunity style (using getItemKey to avoid collisions
      // with badge token_ids that may overlap numerically)
      var key = getItemKey(i);
      if (tidSet[key]) return true;
      return false;
    });
  }

  // In light/generic search (no active portfolio), deduplicate multi-1of1 custom series (trillion clubs)
  // ONLY the series_rep (is_series_rep) is shown for these slugs. It carries the generic title,
  // generic image, and aggregate holder_count (e.g. 3 for 9T).
  // Personalized 1:1s (with custom names/art) appear ONLY in the owner's portfolio view.
  // daGATO Agency: browse shows 5 rarity tiers only; case files appear in collector wallet.
  if (!galleryCollectorView) {
    items = items.filter(function (i) {
      if (i.source_created_collection && /trillion|billion/i.test(i.source_created_collection)) {
        // Light view: keep only the series rep (has aggregate stats + generic presentation)
        return !!i.is_series_rep;
      }
      if ((i.collection_id || "") === "dagato-agency") {
        return isAgencyRaritySeries(i);
      }
      return true;
    });
  } else {
    // Portfolio: never show agency rarity aggregates (show real case file token #s)
    items = items.filter(function (i) {
      return !isAgencyRaritySeries(i);
    });
  }
  // Collection filter (for multi-collection future; current data defaults to dacommunity)
  if (activeCollection && activeCollection !== "all") {
    items = items.filter(function (i) {
      return (i.collection_id || "dacommunity") === activeCollection;
    });
  }
  if (activeFilter === "listed") items = items.filter(function (i) { return i.listed; });
  if (activeFilter === "not_listed") items = items.filter(function (i) { return !i.listed; });
  if (activeFilter === "activity") items = items.filter(function (i) { return hasRecentActivity(i); });
  if (searchQuery) {
    var q = searchQuery.toLowerCase();
    items = items.filter(function (i) { return itemMatchesSearch(i, q); });
  }
  // Final safety dedup by composite key. Prevents any random duplicate cards from
  // state/merge timing (prefer series_rep if a collision somehow occurs for a club slug).
  var final = [];
  var seenKey = {};
  items.forEach(function (i) {
    var k = getItemKey(i);
    if (!seenKey[k]) {
      seenKey[k] = i;
      final.push(i);
    } else if (i.is_series_rep && !seenKey[k].is_series_rep) {
      // upgrade: replace previous non-series with this series rep
      seenKey[k] = i;
      // find and replace in final (small list)
      for (var fi = 0; fi < final.length; fi++) {
        if (getItemKey(final[fi]) === k) {
          final[fi] = i;
          break;
        }
      }
    }
  });
  items = final;
  items.sort(compareItems);
  return items;
}

/**
 * Apply the exact same dedup logic used in getFilteredItems for light/generic search
 * (keep only series_rep for trillion/billion clubs). This ensures "Pieces" stat
 * matches exactly what's shown in the grid.
 */
function getDedupedPiecesCount(allItems) {
  if (!allItems || !allItems.length) return 0;
  var items = allItems.slice();
  if (!galleryCollectorView) {
    items = items.filter(function (i) {
      if (i.source_created_collection && /trillion|billion/i.test(i.source_created_collection)) {
        return !!i.is_series_rep;
      }
      if ((i.collection_id || "") === "dagato-agency") {
        return isAgencyRaritySeries(i);
      }
      return true;
    });
  } else {
    items = items.filter(function (i) {
      return !isAgencyRaritySeries(i);
    });
  }
  return items.length;
}

/** Compute the display pieces count for badges using the exact same dedup logic
 *  as the light/generic search view (series_rep only for clubs, unique sources).
 *  This ensures the "Pieces" stat and browse totals match what's shown in the grid.
 */
function getBadgePiecesCount(allItems) {
  // Delegate to deduped logic (collection filter no-op when items are badges-only)
  return getDedupedPiecesCount(allItems);
}

function resetBrowseView() {
  clearGalleryCollectorView({ clearResult: true });
  activeFilter = "all";
  searchQuery = "";
  sortKey = "token_desc";
  var search = $("#search");
  var sort = $("#sort-select");
  var colSel = $("#collection-select");
  if (search) search.value = "";
  if (sort) sort.value = "token_desc";
  if (colSel) colSel.value = "all";
  // To force reload of full 'all' data (dacom + badges merge) when clearing from a collection filter,
  // temporarily set active to something else so the change handler runs the load.
  if (colSel) {
    var prev = activeCollection;
    activeCollection = (prev === "all" ? "badges" : prev); // temp different to trigger
    colSel.dispatchEvent(new Event('change'));
    activeCollection = "all"; // will be set again in handler
  } else {
    activeCollection = "all";
  }
  document.querySelectorAll(".filter").forEach(function (btn) {
    var on = btn.dataset.filter === "all";
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  refreshView();
  // Clean URL and hash so we don't stay stuck on ?collection=badges#wallet-panel
  try {
    var params = new URLSearchParams(window.location.search);
    params.delete("collection");
    var qs = params.toString();
    var newUrl = window.location.pathname + (qs ? "?" + qs : "");
    history.replaceState(null, "", newUrl);
  } catch (e) {}
}

function renderBrowseMeta(filtered, total) {
  var countEl = $("#results-count");
  var chips = $("#active-filters");
  var clearBtn = $("#clear-filters");
  var collectorClearBtn = $("#collector-clear-filters");
  var panel = $("#browse-controls");
  if (countEl) {
    if (galleryCollectorView) {
      countEl.textContent =
        "Showing " +
        filtered +
        " of " +
        galleryCollectorView.pieceCount +
        " pieces";
    } else if (filtered === total) {
      countEl.textContent = total + " piece" + (total === 1 ? "" : "s") + " in the archive";
    } else {
      countEl.textContent =
        "Showing " + filtered + " of " + total + " pieces in the archive";
    }
  }
  var parts = [];
  if (searchQuery) {
    parts.push({ key: "search", label: 'Search: "' + searchQuery + '"' });
  }
  if (activeCollection && activeCollection !== "all") {
    parts.push({ key: "collection", label: getCollectionName(activeCollection) });
  }
  if (activeFilter !== "all") {
    parts.push({ key: "filter", label: FILTER_LABELS[activeFilter] || activeFilter });
  }
  if (sortKey !== "token_desc") {
    parts.push({ key: "sort", label: SORT_LABELS[sortKey] || sortKey });
  }
  if (panel) {
    panel.classList.toggle("is-filtered", parts.length > 0 && !galleryCollectorView);
    panel.classList.toggle("is-collector-filtered", !!galleryCollectorView);
  }
  if (collectorClearBtn) {
    collectorClearBtn.hidden = !galleryCollectorView || !parts.length;
  }
  if (!chips || !clearBtn) return;
  if (!parts.length) {
    chips.hidden = true;
    chips.innerHTML = "";
    clearBtn.hidden = !!galleryCollectorView;
    if (!galleryCollectorView) clearBtn.textContent = "Clear all";
    return;
  }
  chips.hidden = false;
  if (galleryCollectorView) {
    clearBtn.hidden = true;
  } else {
    clearBtn.hidden = false;
    clearBtn.textContent = "Clear all";
  }
  chips.innerHTML = parts
    .map(function (p) {
      return (
        '<span class="filter-chip">' +
        escapeHtml(p.label) +
        '<button type="button" data-clear="' +
        escapeHtml(p.key) +
        '" aria-label="Remove ' +
        escapeHtml(p.label) +
        '">×</button></span>'
      );
    })
    .join("");
  chips.querySelectorAll("button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var k = btn.getAttribute("data-clear");
      if (k === "collector") {
        exitCollectorView();
      } else if (k === "search") {
        searchQuery = "";
        var inp = $("#search");
        if (inp) inp.value = "";
      } else if (k === "filter") {
        activeFilter = "all";
        document.querySelectorAll(".filter").forEach(function (b) {
          var on = b.dataset.filter === "all";
          b.classList.toggle("active", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        });
      } else if (k === "sort") {
        sortKey = "token_desc";
        var sel = $("#sort-select");
        if (sel) sel.value = "token_desc";
      } else if (k === "collection") {
        activeCollection = "all";
        var colSel = $("#collection-select");
        if (colSel) {
          colSel.value = "all";
          // dispatch to trigger load of merged data for all
          colSel.dispatchEvent(new Event('change'));
        }
      }
      refreshView();
    });
  });
}

function renderGallerySkeletons(count) {
  var list = $("#gallery-list");
  var empty = $("#gallery-empty");
  if (!list) return;
  if (empty) empty.hidden = true;
  list.innerHTML = "";
  for (var i = 0; i < count; i++) {
    var row = document.createElement("div");
    row.className = "gallery-row is-skeleton";
    row.setAttribute("aria-hidden", "true");
    row.innerHTML =
      '<div class="gallery-thumb-wrap"></div>' +
      '<div class="gallery-meta"><h3>&nbsp;</h3><p>&nbsp;</p></div>' +
      '<div class="gallery-side"><span class="token-pill">&nbsp;</span></div>';
    list.appendChild(row);
  }
}

function renderGallery(items) {
  var list = $("#gallery-list");
  var empty = $("#gallery-empty");
  if (!list) return;
  if (galleryCollectorView) {
    list.classList.add("holdings-grid", "collector-collection-grid", "gallery-list--collector");
  } else {
    list.classList.remove("holdings-grid", "collector-collection-grid", "gallery-list--collector");
  }
  list.innerHTML = "";
  if (!items.length) {
    if (empty) {
      empty.hidden = false;
      var lead = empty.querySelector(".gallery-empty-lead");
      if (lead && galleryCollectorView) {
        lead.textContent =
          "Nothing matches for " +
          galleryCollectorView.label +
          " with the current filters. Clear collector view or relax your search.";
      } else if (lead) {
        lead.textContent = "Nothing matched that search. Try different words or clear your filters.";
      }
    }
    return;
  }
  if (empty) empty.hidden = true;

  if (galleryCollectorView) {
    items.forEach(function (item) {
      var holding = {
        token_id: item.token_id,
        display_name: item.local_slug || item.name,
      };
      var card = createHoldingCard(item, holding);
      card.classList.add("holding-card--cinema");
      card.setAttribute("data-token-id", getItemKey(item));
      list.appendChild(card);
    });
    return;
  }

  items.forEach(function (item, idx) {
    var row = document.createElement("button");
    row.className = "gallery-row";
    if (fullDataStatus === "loading_full" && !item.description && !cleanStoryText(item)) {
      row.classList.add("is-pending-story");
    }
    row.type = "button";
    row.style.animationDelay = Math.min(idx * 0.025, 0.75) + "s";
    var title = itemTitle(item);
    var listedBadge = item.listed
      ? '<span class="badge-listed">' + (item.listing ? formatEth(item.listing.amount_eth) + " ETH" : "Listed") + "</span>"
      : "";
    var rarityBadge = formatRarityBadgeHtml(item);
    var videoBadge = isVideoItem(item) ? '<span class="thumb-video-badge">▶</span>' : "";
    // Agency rarity series: rank lives in the title — no # pill on browse (wallet keeps real token #s)
    var tokenPill = isAgencyRaritySeries(item)
      ? ""
      : '<span class="token-pill">#' + escapeHtml(itemTokenPillLabel(item)) + "</span>";
    var excerpt = displayExcerpt(item);
    if (!excerpt && fullDataStatus === "loading_full") {
      excerpt = "Story loading from snapshot…";
    }
    row.innerHTML =
      '<div class="gallery-thumb-wrap"><div class="gallery-thumb-slot"></div>' + videoBadge + "</div>" +
      '<div class="gallery-meta"><h3>' + formatPieceTitleHtml(title) + "</h3><p>" + escapeHtml(excerpt || "No excerpt yet.") + "</p></div>" +
      '<div class="gallery-side">' + tokenPill + rarityBadge + listedBadge + "</div>";
    fillMediaSlot(row.querySelector(".gallery-thumb-slot"), item, { controls: false });
    var thumb = row.querySelector(".gallery-thumb-slot img, .gallery-thumb-slot video");
    if (thumb && thumb.tagName === "IMG" && item.opensea_image_url && resolveMediaUrl(item.image_url) !== resolveMediaUrl(item.opensea_image_url)) {
      thumb.addEventListener("error", function () { thumb.src = resolveMediaUrl(item.opensea_image_url); }, { once: true });
    }
    row.setAttribute("data-token-id", getItemKey(item));
    list.appendChild(row);
  });
}

function activityTypeLabel(type) {
  if (type === "transfer") return "Transfer";
  if (type === "sale") return "Sale";
  if (type === "mint") return "Mint";
  return type || "Activity";
}

/** Drop duplicate ERC-1155 activity rows (same as backend dedupe_activity_rows). */
function dedupeActivityRows(rows) {
  if (!rows || !rows.length) return [];
  var seen = {};
  var out = [];
  rows.forEach(function (row) {
    var key =
      (row.type || "") +
      "|" +
      (row.at || "") +
      "|" +
      (row.from || "").toLowerCase() +
      "|" +
      (row.to || "").toLowerCase() +
      "|" +
      (row.quantity || 1);
    if (seen[key]) return;
    seen[key] = true;
    out.push(row);
  });
  return out;
}

/** Most recent mint/transfer/sale — from owners.latest_change or recent_activity. */
function getLatestChange(item) {
  if (item.owners && item.owners.latest_change) return item.owners.latest_change;
  var rows = dedupeActivityRows(item.recent_activity || []);
  return rows.length ? rows[0] : null;
}

/** Wallet that received the latest mint or transfer (same treatment for both). */
function currentOwnerAddress(item) {
  var change = getLatestChange(item);
  if (!change || !change.to) return null;
  if (change.type === "mint" || change.type === "transfer") {
    return String(change.to).toLowerCase();
  }
  return null;
}

function formatLatestChangePreview(change) {
  if (!change) return "";
  var qty = change.quantity > 1 ? " ×" + change.quantity : "";
  var when = formatMintDate(change.at);
  var label =
    change.type === "transfer"
      ? "Latest transfer"
      : change.type === "sale"
        ? "Latest sale"
        : change.type === "mint"
          ? "Latest mint"
          : activityTypeLabel(change.type);
  if (change.type === "mint") {
    return (
      label +
      (when ? " · " + when : "") +
      " · to " +
      shortenAddress(change.to || "") +
      qty
    );
  }
  return (
    label +
    (when ? " · " + when : "") +
    " · " +
    shortenAddress(change.from || "") +
    " → " +
    shortenAddress(change.to || "") +
    qty
  );
}

function setActivityDisclosureOpen(open) {
  var toggle = $("#detail-activity-toggle");
  var panel = $("#detail-activity-panel");
  if (!toggle || !panel) return;
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.classList.toggle("is-open", open);
  panel.hidden = !open;
}

function formatActivityLine(row) {
  var qty = row.quantity > 1 ? " ×" + row.quantity : "";
  if (row.type === "mint") {
    return "Minted to " + addressActionHtml(row.to || "") + qty;
  }
  if (row.type === "transfer") {
    return addressActionHtml(row.from || "") + " → " + addressActionHtml(row.to || "") + qty;
  }
  if (row.type === "sale") {
    return "Sale · " + addressActionHtml(row.from || "") + " → " + addressActionHtml(row.to || "") + qty;
  }
  return activityTypeLabel(row.type) + qty;
}

function renderDetailActivity(item) {
  var block = $("#detail-activity");
  var list = $("#detail-activity-list");
  var osLink = $("#detail-activity-opensea");
  var countEl = $("#detail-activity-count");
  var previewEl = $("#detail-activity-preview");
  var rows = dedupeActivityRows(item.recent_activity || []);
  if (!rows.length) {
    block.hidden = true;
    setActivityDisclosureOpen(false);
    return;
  }
  block.hidden = false;
  setActivityDisclosureOpen(false);
  if (countEl) countEl.textContent = "(" + rows.length + ")";
  var preview = formatLatestChangePreview(getLatestChange(item));
  if (previewEl) {
    if (preview) {
      previewEl.hidden = false;
      previewEl.textContent = preview;
    } else {
      previewEl.hidden = true;
      previewEl.textContent = "";
    }
  }
  list.innerHTML = rows
    .map(function (row) {
      return (
        '<li class="activity-row activity-row-' +
        escapeHtml(row.type || "other") +
        '">' +
        '<span class="activity-type">' +
        escapeHtml(activityTypeLabel(row.type)) +
        "</span>" +
        '<span class="activity-when">' +
        escapeHtml(formatMintDate(row.at)) +
        "</span>" +
        '<span class="activity-detail">' +
        formatActivityLine(row) +
        "</span></li>"
      );
    })
    .join("");
  bindAddressActions(list);
  if (item.opensea_url) {
    var sep = item.opensea_url.indexOf("?") >= 0 ? "&" : "?";
    osLink.href =
      item.opensea_url + sep + "activityTypes=sale,mint,transfer";
    osLink.hidden = false;
  } else {
    osLink.hidden = true;
  }
}

function renderDetailOwners(item) {
  var ownersBlock = $("#detail-owners");
  var chipsEl = $("#detail-owner-chips");
  var leadEl = $("#detail-owners-lead");
  var explore = $("#collector-explore");
  explore.hidden = true;
  activeCollectorAddress = null;
  var owners = item.owners || {};
  var holders = resolveHoldersList(item);
  if (!holders.length) {
    ownersBlock.hidden = true;
    return;
  }
  ownersBlock.hidden = false;
  var displayCount = effectiveHolderCount(item);
  if (leadEl) {
    leadEl.hidden = false;
    var incomplete =
      displayCount > holders.length
        ? " · loading full holder list…"
        : "";
    leadEl.textContent =
      displayCount +
      " holders · " +
      nvl(owners.circulating_copies, "—") +
      " copies" +
      incomplete;
  }
  var highlightAddr = holderHighlightAddress(item);
  chipsEl.innerHTML = holders
    .map(function (h) {
      var meta = addressDisplayMeta(h.address);
      var isHighlighted = highlightAddr && meta.address === highlightAddr;
      var label = holderChipLabelHtml(meta) + " · " + h.quantity;
      if (isHighlighted) {
        label +=
          ' <span class="owner-chip-note">' +
          escapeHtml(holderHighlightNote(item, highlightAddr)) +
          "</span>";
      }
      return (
        '<span class="owner-chip-wrap">' +
        '<button type="button" class="owner-chip' +
        (isHighlighted ? " owner-chip-current" : "") +
        '" data-address="' +
        escapeHtml(meta.address) +
        '" title="View all pieces held by ' +
        escapeHtml(meta.display) +
        '">' +
        label +
        "</button>" +
        '<button type="button" class="owner-view-link" data-address="' +
        escapeHtml(meta.address) +
        '">View collector</button>' +
        '<button type="button" class="addr-action-copy owner-chip-copy" data-copy="' +
        escapeHtml(meta.address) +
        '" title="Copy full address">Copy</button></span>'
      );
    })
    .join("");
  chipsEl.querySelectorAll(".owner-chip, .owner-view-link").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      applyCollectorView(btn.dataset.address);
    });
  });
  bindAddressActions(chipsEl);
}

function refreshDetailPanel(item) {
  if (!item) return;
  renderDetailDescription(item);
  renderDetailActivity(item);
  renderDetailOwners(item);
}

function openDetail(item) {
  if (!item) return;
  closeCollectorsModal();
  activeDetailTokenId = getItemKey(item);
  var panel = $("#detail-panel");
  if (!panel) return;
  fillMediaSlot($("#detail-media-slot"), item, { autoplay: true, controls: true });
  $("#detail-title").innerHTML = formatPieceTitleHtml(itemTitle(item));
  if (isAgencyRaritySeries(item)) {
    var nFiles = item.case_file_count || (item.case_files && item.case_files.length) || 0;
    $("#detail-token").textContent =
      "Token rank #" +
      (item.token_rank != null ? item.token_rank : itemTokenPillLabel(item)) +
      " of 5 · " +
      nFiles +
      " case file" +
      (nFiles === 1 ? "" : "s");
  } else {
    $("#detail-token").textContent =
      "Token #" + item.token_id + (item.local_slug ? " · " + item.local_slug : "");
  }
  var mintEl = $("#detail-mint");
  if (item.minted_at) {
    mintEl.hidden = false;
    mintEl.textContent = "First minted · " + formatMintDate(item.minted_at);
  } else {
    mintEl.hidden = true;
    mintEl.textContent = "";
  }
  renderDetailDescription(item);
  $("#detail-opensea").href = item.opensea_url || "#";

  // Optional film hub link (e.g. Collector Cat badge ↔ teaser trailer)
  var relatedFilmEl = $("#detail-related-film");
  if (relatedFilmEl) {
    var filmLink = relatedFilmForItem(item);
    if (filmLink && filmLink.href) {
      relatedFilmEl.href = filmLink.href;
      relatedFilmEl.textContent = filmLink.label || "Watch related film";
      relatedFilmEl.hidden = false;
    } else {
      relatedFilmEl.removeAttribute("href");
      relatedFilmEl.textContent = "";
      relatedFilmEl.hidden = true;
    }
  }

  var badge = $("#detail-badge");
  if (item.listed) {
    badge.hidden = false;
    badge.textContent = item.listing ? "For sale · " + formatEth(item.listing.amount_eth) + " ETH" : "For sale";
  } else {
    badge.hidden = true;
  }

  var stats = $("#detail-stats");
  var chips = [];
  var rarityLabel = itemRarityLabel(item);
  if (rarityLabel) {
    chips.push(
      '<span class="rarity-badge ' +
        rarityBadgeClass(rarityLabel) +
        '">' +
        escapeHtml(rarityLabel) +
        "</span>"
    );
  }
  if (isAgencyRaritySeries(item) && item.case_file_count) {
    chips.push(
      '<span class="chip"><strong>' +
        item.case_file_count +
        "</strong> case file" +
        (item.case_file_count === 1 ? "" : "s") +
        "</span>"
    );
  }
  if (item.owners) {
    var oc = item.owners;
    chips.push('<span class="chip"><strong>' + effectiveHolderCount(item) + "</strong> holders</span>");
    var circ = (oc.circulating_copies != null ? oc.circulating_copies : (oc.holder_count || 0));
    chips.push('<span class="chip"><strong>' + circ + "</strong> copies</span>");
  }
  if (item.listed && item.listing) {
    chips.push('<span class="chip">List <strong>' + formatEth(item.listing.amount_eth) + " ETH</strong></span>");
  }
  stats.innerHTML = chips.length ? chips.join("") : '<span class="chip">Community piece</span>';
  renderDetailActivity(item);
  renderDetailOwners(item);
  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeDetail() {
  var panel = $("#detail-panel");
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
  activeDetailTokenId = null;
  if (!$("#collectors-modal").classList.contains("open")) {
    document.body.style.overflow = "";
  }
  $("#collector-explore").hidden = true;
  setActivityDisclosureOpen(false);
  // Stop any video playing in the detail slot to prevent background audio after close
  var detailSlot = $("#detail-media-slot");
  if (detailSlot) {
    var vid = detailSlot.querySelector("video");
    if (vid) {
      vid.pause();
      vid.currentTime = 0;
    }
  }
}

function refreshView() {
  if (!galleryData) return;
  // Use deduped count so "Pieces" / "X of Y" matches exactly what's shown in the grid
  // (dacommunity items + deduped badges = 64 + 15 when All)
  var total = getDedupedPiecesCount(galleryData.items);
  var filtered = getFilteredItems();
  renderBrowseMeta(filtered.length, total);
  renderGallery(filtered);
}

var searchDebounceTimer = null;

/** Show/hide × on search or wallet field; onClear runs after value is cleared. */
function bindClearableField(input, clearBtn, onClear) {
  if (!input || !clearBtn) return;
  function syncClear() {
    clearBtn.hidden = !input.value.trim();
  }
  input.addEventListener("input", syncClear);
  clearBtn.addEventListener("click", function () {
    input.value = "";
    if (onClear) onClear();
    syncClear();
    input.focus();
  });
  syncClear();
}

function populateCollectionSelect() {
  var sel = $("#collection-select");
  if (!sel) return;
  var live = getLiveCollections();
  sel.innerHTML = '<option value="all">All collections</option>';
  live.forEach(function(c){
    var o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name || c.id;
    sel.appendChild(o);
  });
  sel.value = activeCollection || "all";
}

function bindUi() {
  document.querySelectorAll(".filter").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".filter").forEach(function (b) {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      activeFilter = btn.dataset.filter;
      syncBrowseParamsToUrl();
      refreshView();
    });
  });
  var searchInput = $("#search");
  if (searchInput) {
    searchInput.addEventListener("input", function (e) {
      clearTimeout(searchDebounceTimer);
      var val = e.target.value.trim();
      searchDebounceTimer = setTimeout(function () {
        searchQuery = val;
        syncBrowseParamsToUrl();
        refreshView();
      }, 120);
    });
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        searchInput.value = "";
        searchQuery = "";
        syncBrowseParamsToUrl();
        refreshView();
        var sc = $("#search-clear");
        if (sc) sc.hidden = true;
        searchInput.blur();
      }
    });
    bindClearableField(searchInput, $("#search-clear"), function () {
      searchQuery = "";
      syncBrowseParamsToUrl();
      refreshView();
    });
  }
  var walletInput = $("#wallet-input");
  bindClearableField(walletInput, $("#wallet-clear"), function () {
    if (galleryCollectorView) {
      clearGalleryCollectorView({ clearResult: true });
    }
    resetWalletLookupHub();
    refreshView();
  });
  var browseToggle = $("#browse-advanced-toggle");
  if (browseToggle && !browseToggle.dataset.bound) {
    browseToggle.dataset.bound = "1";
    browseToggle.addEventListener("click", function () {
      var adv = $("#browse-advanced");
      if (!adv) return;
      var collapsed = adv.classList.toggle("is-collapsed");
      browseToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      browseToggle.dataset.userToggled = "1";
    });
  }
  if (typeof browseAdvancedMq.addEventListener === "function") {
    browseAdvancedMq.addEventListener("change", onBrowseAdvancedMqChange);
  } else if (typeof browseAdvancedMq.addListener === "function") {
    browseAdvancedMq.addListener(onBrowseAdvancedMqChange);
  }
  window.addEventListener("resize", onBrowseAdvancedMqChange);
  syncBrowseAdvancedPanel();
  var sortSelect = $("#sort-select");
  if (sortSelect) {
    sortSelect.value = sortKey;
    sortSelect.addEventListener("change", function (e) {
      sortKey = e.target.value;
      syncBrowseParamsToUrl();
      refreshView();
    });
  }

  // Collection filter (dropdown from live entries in registry; only shown for live collections)
  populateCollectionSelect();
  var collectionSelect = $("#collection-select");
  if (collectionSelect) {
    collectionSelect.addEventListener("change", async function (e) {
      var newCol = e.target.value;
      if (newCol === activeCollection) return;
      activeCollection = newCol;
      syncBrowseParamsToUrl();

      var col = getCurrentCollection();
      var hasWallet = !col || (col.features || []).indexOf("wallet_lookup") !== -1;

      var urls = getCollectionDataUrls(activeCollection);
      var loadEl = $("#load-state");
      if (loadEl) loadEl.hidden = false;

      try {
        if (urls) {
          // badges / BIG KIX: prefer full JSON so activity + holders match daCommunity detail UX
          CATALOG_URL = urls.catalog;
          FULL_DATA_URL = urls.full;
          var newData = await loadSecondaryCollectionData(urls);
          galleryData = newData;
          if (galleryData && Array.isArray(galleryData.items)) {
            var cid = activeCollection || (galleryData.collection && galleryData.collection.id) || (galleryData.collection && galleryData.collection.slug) || "dacommunity";
            galleryData.items.forEach(function (item) {
              if (!item.collection_id) item.collection_id = cid;
            });
          }
          dataSource =
            (galleryData.source || "").indexOf("catalog") >= 0 ? "catalog" : "full";
          indexItems(galleryData);
          rebuildCollectorsForCurrentView();
          renderStats(galleryData.collection);
          renderDataFreshness();
          refreshView();
          syncCollectorViewToCurrentItems();
          adaptHeaderForCollection();
          applyCollectionUI();

          // Load wallet index for ENS on owner chips (do not clobber collectors for bigkix/badges)
          loadWalletIndex().then(function () {
            if (galleryData && Array.isArray(galleryData.items)) {
              var byAddr = (walletIndex && walletIndex.by_address) || {};
              galleryData.items.forEach(function (item) {
                var os = item.owners || {};
                ["holders", "top_holders"].forEach(function (k) {
                  (os[k] || []).forEach(function (o) {
                    var e = byAddr[(o.address || "").toLowerCase()];
                    if (e && e.ens_name) o.ens_name = e.ens_name;
                  });
                });
              });
            }
            rebuildCollectorsForCurrentView();
            if (galleryCollectorView) {
              expandCollectorHoldingsFromLoadedData();
              renderCollectorFocusUi();
            }
            renderStats(galleryData.collection);
            refreshView();
            if (activeDetailTokenId) {
              var openItem = itemsById.get(activeDetailTokenId);
              if (openItem) refreshDetailPanel(openItem);
            }
          });
        } else {
          // primary dacommunity or "all": reset to default data URLs and reload
          initDataUrls();
          var newData = await loadCatalogFirst();
          galleryData = newData;
          if (galleryData && Array.isArray(galleryData.items)) {
            var cid = activeCollection || (galleryData.collection && galleryData.collection.slug) || "dacommunity";
            galleryData.items.forEach(function (item) {
              if (!item.collection_id) item.collection_id = cid;
            });
          }
          dataSource = galleryData.source === "gallery_catalog" ? "catalog" : "full";
          indexItems(galleryData);
          // For "all" after switch: merge badges + BIG KIX (+ future secondaries)
          if (!activeCollection || activeCollection === "all") {
            await mergeSecondaryCatalogsIntoGallery();
          }
          // Keep filter/sort chips in sync (e.g. stay on "For sale" when leaving BIG KIX)
          document.querySelectorAll(".filter").forEach(function (btn) {
            var on = btn.dataset.filter === activeFilter;
            btn.classList.toggle("active", on);
            btn.setAttribute("aria-selected", on ? "true" : "false");
          });
          rebuildCollectorsForCurrentView();
          renderStats(
            (galleryData && galleryData.collection) || null
          );
          renderDataFreshness();
          refreshView();
          syncCollectorViewToCurrentItems();
          adaptHeaderForCollection();
          applyCollectionUI();
          // re-load wallet/collector data and background enrich for main archive
          if (dataSource === "catalog") {
            refreshFullDataInBackground();
          }
          if (hasWallet) {
            loadWalletIndex().then(function () {
              rebuildCollectorsForCurrentView();
              // Portfolio open: re-expand after wallet index so daCommunity + secondaries show
              if (galleryCollectorView) {
                expandCollectorHoldingsFromLoadedData();
                renderCollectorFocusUi();
              }
              renderStats(
                (galleryData && galleryData.collection) || null
              );
              refreshView();
              if (activeDetailTokenId) {
                var openItem = itemsById.get(activeDetailTokenId);
                if (openItem) refreshDetailPanel(openItem);
              }
              // do not auto-apply wallet from url on manual switch to avoid side effects
            });
          } else {
            clearGalleryCollectorView({ clearResult: true });
            if (typeof collectorsList !== "undefined") collectorsList = [];
            var btn = $("#view-collectors-btn");
            if (btn) btn.hidden = true;
          }
        }
      } catch (err) {
        console.error("Collection data switch failed", err);
        if (loadEl) loadEl.hidden = true;
        refreshView();
        adaptHeaderForCollection();
        applyCollectionUI();
      } finally {
        if (loadEl) loadEl.hidden = true;
      }
    });
  }

  // Apply any parsed state from URL (?collection=...&filter=... etc) to the controls
  var searchInputForState = $("#search");
  if (searchInputForState && searchQuery) searchInputForState.value = searchQuery;
  if (activeFilter !== "all") {
    document.querySelectorAll(".filter").forEach(function (b) {
      var on = b.dataset.filter === activeFilter;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
  }
  var sortForState = $("#sort-select");
  if (sortForState) sortForState.value = sortKey;
  var colForState = $("#collection-select");
  if (colForState) colForState.value = activeCollection || "all";
  var clearBtn = $("#clear-filters");
  if (clearBtn) clearBtn.addEventListener("click", resetBrowseView);
  var emptyReset = $("#gallery-empty-reset");
  if (emptyReset) emptyReset.addEventListener("click", resetBrowseView);
  bindFreshnessToggle();
  bindCollectorExitUi();
  bindCollectorHeaderActions();
  bindCollectorHubNav();
  bindGalleryListClicks();

  // Archive view share (includes collection + current filters/sort/search)
  var archiveShare = $("#archive-share-btn");
  if (archiveShare && !archiveShare.dataset.bound) {
    archiveShare.dataset.bound = "1";
    archiveShare.addEventListener("click", function () {
      // Use the standard share modal for archive view (same as main gallery)
      showShareModal();
    });
  }
  renderCollectorFocusUi();
  var cs = $("#collectors-search");
  if (cs) cs.addEventListener("input", function (e) { renderCollectors(e.target.value); });
  var viewBtn = $("#view-collectors-btn");
  if (viewBtn) viewBtn.addEventListener("click", openCollectorsModal);
  $("#collectors-modal-close").addEventListener("click", closeCollectorsModal);
  $("#collectors-modal-backdrop").addEventListener("click", closeCollectorsModal);
  // Share modal close
  var shareClose = $("#share-modal-close");
  if (shareClose) shareClose.addEventListener("click", closeShareModal);
  var shareBackdrop = $("#share-modal-backdrop");
  if (shareBackdrop) shareBackdrop.addEventListener("click", closeShareModal);
  $("#wallet-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("#wallet-input").value.trim();
    if (v) renderWalletLookup(v, { updateUrl: true, scroll: false });
  });
  $("#detail-close").addEventListener("click", closeDetail);
  $("#detail-backdrop").addEventListener("click", closeDetail);
  var activityToggle = $("#detail-activity-toggle");
  if (activityToggle && !activityToggle.dataset.bound) {
    activityToggle.dataset.bound = "1";
    activityToggle.addEventListener("click", function () {
      var open = activityToggle.getAttribute("aria-expanded") === "true";
      setActivityDisclosureOpen(!open);
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    handleEscapeKey();
  });
}

/* === Boot & Bind (wires everything after initial data load; also handles URL param restore for collection/filters) === */
/** Turn loaded JSON into UI: clear loaders, stats, gallery rows, event handlers. */
function bootGallery(data) {
  galleryData = data;
  // Tag items with collection_id for multi-collection filtering (future-proof; current data is dacommunity)
  if (galleryData && Array.isArray(galleryData.items)) {
    var cid =
      activeCollection ||
      (galleryData.collection && galleryData.collection.id) ||
      (galleryData.collection && galleryData.collection.slug) ||
      "dacommunity";
    if (cid === "all") cid = "dacommunity";
    galleryData.items.forEach(function (item) {
      if (!item.collection_id) item.collection_id = cid;
    });
  }
  indexItems(galleryData);
  // Secondary collections: collectors before first paint of stats tiles
  if (activeCollection && activeCollection !== "all" && activeCollection !== "dacommunity") {
    rebuildCollectorsForCurrentView();
  }
  var loadEl = $("#load-state");
  if (loadEl) loadEl.hidden = true;
  renderStats(galleryData.collection);
  renderDataFreshness();
  bindUi();
  refreshView();
  updateCollectorsButton();
}

function syncSiteHeaderHeight() {
  var header = document.querySelector(".site-header");
  if (!header) return;
  var h = Math.ceil(header.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--site-header-h", h + "px");
}

function bindHeaderHeightSync() {
  syncSiteHeaderHeight();
  var header = document.querySelector(".site-header");
  if (header && typeof ResizeObserver !== "undefined") {
    var ro = new ResizeObserver(syncSiteHeaderHeight);
    ro.observe(header);
  }
  window.addEventListener("resize", syncSiteHeaderHeight);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncSiteHeaderHeight);
  }
}

/* Main entry (called at bottom). Orchestrates data loads + early URL param parsing (for ?collection= etc). */
async function init() {
  bindHeaderHeightSync();

  initDataUrls();

  if (isFileProtocol()) {
    showFatalError(
      "Open the gallery through the local server",
      "Double-clicking index.html blocks data loading. Use start-gallery.bat instead.",
      "start-gallery.bat  →  http://localhost:8080"
    );
    return;
  }

  try {
    // Load meta early (small file, no-store via fetchJson) so that the initial
    // data-freshness banner reflects the real pull timestamp from the latest
    // refresh, not just the catalog's generated_at. This helps after manual
    // data pulls.
    loadGalleryMeta();

    // Parse any collection/filter/sort/search from URL (supports pre-filter from /collections/ + share links)
    parseBrowseParamsFromUrl();

    // Load registry early for collection filter UI (only live ones shown)
    await loadCollectionsRegistry().catch(function(){});
    populateCollectionSelect();

    // If URL asked for a different live collection that has its own data files (e.g. ?collection=badges),
    // switch the globals *before* the first fetch so the existing load path just works.
    var initialColUrls = getCollectionDataUrls(activeCollection);
    if (initialColUrls) {
      CATALOG_URL = initialColUrls.catalog;
      FULL_DATA_URL = initialColUrls.full;
      // Prefer full JSON for secondaries so transfers/holders work on first paint
      galleryData = await loadSecondaryCollectionData(initialColUrls);
    } else {
      galleryData = await loadCatalogFirst();
    }
    dataSource =
      galleryData.source === "gallery_catalog" ||
      (galleryData.source || "").indexOf("catalog") >= 0
        ? "catalog"
        : "full";
    if (activeCollection && activeCollection !== "all" && activeCollection !== "dacommunity") {
      rebuildCollectorsForCurrentView();
    }
    bootGallery(galleryData);
    adaptHeaderForCollection();
    applyCollectionUI();
    // Open ?piece= detail as soon as catalog is ready (film hub NFT deep-links, share URLs).
    // Wallet index path re-calls this after enrichment; safe to run twice.
    applyPieceFromUrl();
    if (activeCollection && activeCollection !== "all" && activeCollection !== "dacommunity") {
      rebuildCollectorsForCurrentView();
    }

    // For "all collections", merge secondary catalogs (badges + BIG KIX) into the grid
    if (!activeCollection || activeCollection === "all") {
      await mergeSecondaryCatalogsIntoGallery();
    }

    if (!activeCollection || activeCollection === "all") {
      rebuildCollectorsForCurrentView();
    }

    if (dataSource === "catalog") {
      refreshFullDataInBackground();
    } else {
      setFullDataStatus("live");
    }

    // The early loadGalleryMeta will call render when it arrives.
    // Keep the .then for footer etc in case.
    loadGalleryMeta().then(function () {
      updateFooterMaintenance(galleryMeta);
    });

    var initCol = getCurrentCollection();
    var hasWalletInit = !initCol || (initCol.features || []).indexOf("wallet_lookup") !== -1;
    if (hasWalletInit) {
      loadWalletIndex().then(function () {
        // Enrich owners with ENS from walletIndex for display
        if (galleryData && Array.isArray(galleryData.items)) {
          var byAddr = (walletIndex && walletIndex.by_address) || {};
          galleryData.items.forEach(function (item) {
            var os = item.owners || {};
            ["holders", "top_holders"].forEach(function (k) {
              (os[k] || []).forEach(function (o) {
                var e = byAddr[(o.address || "").toLowerCase()];
                if (e && e.ens_name) o.ens_name = e.ens_name;
              });
            });
          });
        }
        // Force collectors for active collection (esp. ?collection=bigkix cold load)
        rebuildCollectorsForCurrentView();
        renderStats(galleryData.collection);
        updateCollectorsButton();
        if (activeDetailTokenId) {
          var openItem = itemsById.get(activeDetailTokenId);
          if (openItem) refreshDetailPanel(openItem);
        }
        applyWalletFromUrl();
        applyPieceFromUrl();
      }).catch(function () {
        rebuildCollectorsForCurrentView();
        renderStats(galleryData && galleryData.collection);
        updateCollectorsButton();
      });
    } else {
      clearGalleryCollectorView({ clearResult: true });
      rebuildCollectorsForCurrentView();
      updateCollectorsButton();
    }

    // Guarantee collectors rail/tile after paint for secondary collections (no wallet required)
    if (activeCollection && activeCollection !== "all" && activeCollection !== "dacommunity") {
      rebuildCollectorsForCurrentView();
      updateCollectorsButton();
      renderTopCollectors();
    }

    if (window.location.hash === "#wallet-panel" && !parseWalletFromUrl()) {
      setTimeout(scrollToCollectorHub, 600);
 