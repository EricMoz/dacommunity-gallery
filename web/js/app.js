/**
 * Gallery core (vanilla). Browse, collector wallet (?wallet=), multi-collection
 * (?collection=), detail/activity, share URLs. Boot: catalog → paint → wallet/name indexes.
 */

/* Film deep links from NFT detail (slug → film hub). */
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

/* Data URLs + cache-bust (?v= from <meta name="site-build">) */
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

/** Deploy stamp for ?v= on JSON/CSS/JS (bump_deploy_version.py). */
function getBuildStamp() {
  try {
    var meta = document.querySelector('meta[name="site-build"]');
    if (meta && meta.getAttribute("content")) {
      return meta.getAttribute("content");
    }
  } catch (e) {}
  return "dev-" + Math.floor(Date.now() / 1000).toString(36);
}

let CATALOG_URL = "";
let FULL_DATA_URL = "";
let WALLET_URL = "";
let META_URL = "";
let REGISTRY_URL = "";
let NAME_INDEX_URL = "";
let galleryMeta = null;
function initDataUrls() {
  var prefix = getDataPrefix();
  var stamp = getBuildStamp();
  var q = "?v=" + stamp;
  CATALOG_URL = prefix + "data/gallery_catalog.json" + q;
  FULL_DATA_URL = prefix + "data/gallery_data.json" + q;
  WALLET_URL = prefix + "data/wallet_index.json" + q;
  // Bust meta every boot: health banner must not stick on a cached "failed" snapshot
  // after a green daily refresh + Pages deploy (SW / edge can lag one stamp).
  META_URL = prefix + "data/gallery_meta.json" + q + "&m=" + Date.now().toString(36);
  REGISTRY_URL = prefix + "data/collections_registry.json" + q;
  NAME_INDEX_URL = prefix + "data/name_index.json" + q;
}

const $ = (sel, root = document) => root.querySelector(sel);

/* Global state */
let galleryData = null;
let walletIndex = null;
/** Base names from weekly enrich (name_index.json). */
let nameIndex = null;
/** Session identity for addresses outside wallet_index (secondary holders + ensdata reverse). */
let extraIdentityByAddress = {};
let reverseEnsPending = {};
let reverseEnsFailed = {};
let identityUiRefreshTimer = null;
let collectorsList = [];
let itemsById = new Map();
let activeFilter = "all";
let searchQuery = "";
let sortKey = "token_desc";
let dataSource = "catalog";
let fullDataStatus = "catalog"; // catalog | loading_full | live | error
let activeCollectorAddress = null;
/** Portfolio mode: grid scoped to this wallet. */
let galleryCollectorView = null;

let originalHeroTitle = null;
let originalHeroLead = null;
/** Open detail key (getItemKey), not bare token id. */
let activeDetailTokenId = null;
let activeCollection = "all";

/** Stable id for share links + indexes. Agency keys require volume (or contract). */
function getItemKey(item) {
  if (!item) return "";
  if (item.source_created_collection) {
    return item.source_created_collection + "-" + item.token_id;
  }
  var cid = item.collection_id || "dacommunity";
  // Vol 1/2 reuse token #s on different contracts — never invent volume 1 when missing
  if (cid === "dagato-agency") {
    if (item.volume != null && item.volume !== "") {
      return cid + "-v" + item.volume + "-" + String(item.token_id);
    }
    var contract = item.contract ? String(item.contract).toLowerCase() : "";
    if (contract) {
      return cid + "-" + contract + "-" + String(item.token_id);
    }
    return cid + "-orphan-" + String(item.token_id);
  }
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

/** Pill label: rank 1–5 for agency series; hat series # from OpenSea title when present. */
function itemTokenPillLabel(item) {
  if (!item) return "";
  if (item.token_rank != null && isAgencyRaritySeries(item)) return String(item.token_rank);
  // HATS n' daCATs: prefer #NNN from exact OpenSea title (token_id can differ from series #)
  if ((item.collection_id || "") === "hats-n-dacats") {
    var title = item.display_name || item.name || "";
    var m = String(title).match(/#\s*(\d+)/);
    if (m) return m[1];
  }
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
  rarity_desc: "Rarity: High to Low",
  rarity_asc: "Rarity: Low to High",
};

let collectionsRegistry = null;

function getLiveCollections() {
  if (!collectionsRegistry || !collectionsRegistry.collections) {
    return [{ id: "dacommunity", name: "daCommunity NFTs", status: "live" }];
  }
  return collectionsRegistry.collections.filter(function (c) {
    return c.status === "live";
  });
}

function getCollectionName(id) {
  if (!id || id === "all") return "All collections";
  var list = (collectionsRegistry && collectionsRegistry.collections) || [];
  var found = list.find(function (c) { return c.id === id; });
  return found ? collectionSelectLabel(found) : id;
}

/** Dropdown / chip label — drop volume suffixes (multi-volume Agency stays one site collection). */
function collectionSelectLabel(col) {
  if (!col) return "";
  if (col.id === "dagato-agency") return "daGATO Detective Agency";
  if (col.id === "dacommunity") return "daCommunity NFTs";
  var n = col.name || col.id || "";
  // Strip trailing ": Volume N" / "Volume N" if present on future registry names
  n = String(n).replace(/\s*[:·-]?\s*Volume\s*\d+\s*$/i, "").trim();
  // Legacy registry/catalog wording
  if (/^daCommunity NFT Archive$/i.test(n)) return "daCommunity NFTs";
  return n || col.id;
}

/** Human collection label for an item (registry name or known ids). */
function itemCollectionLabel(item) {
  if (!item) return "";
  var cid = item.collection_id || "dacommunity";
  var list = (collectionsRegistry && collectionsRegistry.collections) || [];
  var found = list.find(function (c) {
    return c.id === cid;
  });
  if (found) return collectionSelectLabel(found);
  if (cid === "bigkix") return "BIG KIX";
  if (cid === "badges") return "daCAT Badges";
  if (cid === "dagato-agency") return "daGATO Detective Agency";
  if (cid === "hats-n-dacats") return "HATS n' daCATs";
  if (cid === "dacommunity") return "daCommunity NFTs";
  return cid;
}

/** Return per-collection catalog/full data URLs (with current prefix + build stamp) when the
 *  registry entry for a live collection specifies its own data files (e.g. badges_*).
 *  Returns null for the primary daCommunity / "all" so the default gallery_* URLs are used.
 */
function getCollectionDataUrls(colId) {
  var id = colId === "all" ? "all" : normalizeCollectionId(colId || "");
  if (!colId || colId === "all" || id === "dacommunity") return null;
  var list = (collectionsRegistry && collectionsRegistry.collections) || [];
  var col = list.find(function (c) { return c.id === colId; });
  // Hard fallbacks so a stale registry never drops secondary listings/activity files
  var FALLBACK_DATA = {
    "hats-n-dacats": { catalog: "hats_n_dacats_catalog.json", gallery: "hats_n_dacats_data.json" },
    bigkix: { catalog: "bigkix_catalog.json", gallery: "bigkix_data.json" },
    "dagato-agency": { catalog: "dagato_agency_catalog.json", gallery: "dagato_agency_data.json" },
    badges: { catalog: "badges_catalog.json", gallery: "badges_data.json" },
  };
  var catalog =
    (col && col.data && col.data.catalog) ||
    (FALLBACK_DATA[colId] && FALLBACK_DATA[colId].catalog);
  var gallery =
    (col && col.data && col.data.gallery) ||
    (FALLBACK_DATA[colId] && FALLBACK_DATA[colId].gallery);
  if (!catalog || !gallery) return null;
  var prefix = getDataPrefix();
  var stamp = getBuildStamp();
  var q = "?v=" + stamp;
  return {
    catalog: prefix + "data/" + catalog + q,
    full: prefix + "data/" + gallery + q,
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
  var isHats = activeCollection === "hats-n-dacats";
  var isDacommunity = activeCollection === "dacommunity";
  var isAll = !activeCollection || activeCollection === "all";
  document.body.classList.toggle("is-badges-view", isBadges);
  document.body.classList.toggle("is-bigkix-view", isBigKix);
  document.body.classList.toggle("is-dagato-agency-view", isAgency);
  document.body.classList.toggle("is-hats-n-dacats-view", isHats);
  document.body.classList.toggle("is-dacommunity-view", isDacommunity);
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
      lead.textContent =
        "Personal 1:1 awards. Series images shown in the grid (generic photos to keep discovery clean, no 1:1 dupes). Your specific named copy appears in the collector wallet lookup when you hold it.";
    } else if (isBigKix) {
      h1.innerHTML = 'BIG <span class="accent">KIX</span>';
      lead.textContent =
        "Ridiculously BIG sneakers and original DACAT WORLD characters. Collect what you love, connect with fellow fans and creators, and enjoy a collector-first experience where every mint matters.";
    } else if (isAgency) {
      h1.innerHTML = 'daGATO <span class="accent">Detective Agency</span>';
      lead.textContent =
        "Enter the shadows of Cyber City. Volumes 1 and 2 case files span distinctive detective identities, cyber-noir environments, and rarity tiers from Common operatives to legendary 1:1 creations. Browse shows five rarity tiers per volume; your wallet shows every case file you hold. The city hides the truth. daGATO finds it. Stealth. Style. Supremacy.";
    } else if (isHats) {
      h1.innerHTML = "HATS n' <span class=\"accent\">daCATs</span>";
      lead.textContent =
        "333 unique daCATs, each defined by a legendary hat. True 1:1s with no rarity tiers. Every hat stands on its own. Released in waves; Batch 01 is live. Every hat has a story. Legends Wear Hats.";
    } else if (isDacommunity) {
      // Scoped Base archive (hub cards + dropdown: daCommunity NFTs)
      h1.innerHTML = 'daCommunity <span class="accent">NFTs</span>';
      lead.textContent =
        "Telegram-born dacat.* stories on Base. Browse the archive, find your pieces, and share a collector link.";
    } else if (isAll) {
      // Find your daCATs / bare /dacommunity/ → all collections
      h1.innerHTML = 'Find your <span class="accent">daCATs</span>';
      lead.textContent =
        "Browse every live daCAT collection in one place. Search the archive, look up a wallet, and find the pieces you hold.";
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
  // Always clear first — success after a failed snapshot must remove the red banner
  // (previously we only *showed* on failure, so a sticky/cached fail never hid).
  hideStaleBanner();
  if (!meta) return;
  var refresh = meta.refresh || {};
  var key = meta.opensea_key || {};
  var dataAt = meta.data_generated_at || (galleryData && galleryData.generated_at);
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
  // Healthy refresh: keep banner hidden even if data is slightly old (<30h is fine)
  if (refresh.status === "ok" || refresh.status === "success") {
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

/** Re-fetch gallery_meta after boot so a just-finished deploy clears a fail banner. */
function scheduleMetaRefresh() {
  if (isFileProtocol()) return;
  var delays = [8000, 25000, 60000];
  delays.forEach(function (ms) {
    setTimeout(function () {
      try {
        initDataUrls(); // new &m= cache buster
        loadGalleryMeta();
      } catch (e) {
        /* non-fatal */
      }
    }, ms);
  });
}

/**
 * Fetch gallery_meta with a hard cache-bust URL.
 * If the first payload says refresh failed (stale SW/edge), immediately re-fetch
 * once — live server is often already ok after a green daily job.
 */
async function fetchGalleryMetaOnce() {
  var prefix = getDataPrefix();
  var stamp = getBuildStamp();
  var url =
    prefix +
    "data/gallery_meta.json?v=" +
    stamp +
    "&m=" +
    Date.now().toString(36) +
    "&r=" +
    Math.random().toString(36).slice(2, 8);
  return await fetchJson(url, 8000);
}

async function loadGalleryMeta() {
  if (isFileProtocol()) return;
  try {
    var meta = await fetchGalleryMetaOnce();
    // Double-check fail snapshots: one retry often gets the post-deploy ok file
    if (
      meta &&
      meta.refresh &&
      meta.refresh.status === "failed" &&
      /key|mint|rate.?limit|empty store/i.test(
        String((meta.refresh && meta.refresh.error) || (meta.opensea_key && meta.opensea_key.hint) || "")
      )
    ) {
      try {
        await new Promise(function (r) {
          setTimeout(r, 400);
        });
        var again = await fetchGalleryMetaOnce();
        if (again && again.refresh && again.refresh.status === "ok") {
          meta = again;
        }
      } catch (e2) {
        /* keep first payload */
      }
    }
    galleryMeta = meta;
    applyGalleryMeta(galleryMeta);
    // Force the "last updated" / data-freshness banner (and footer) to always reflect the
    // authoritative data_generated_at from gallery_meta.json (the real pull timestamp),
    // not a potentially stale generated_at that may have been embedded in the catalog/full JSON.
    renderDataFreshness();
    updateFooterMaintenance(galleryMeta);
  } catch (e) {
    console.warn("gallery_meta.json not loaded:", e);
    // Do not leave a sticky fail banner if meta cannot be loaded
    hideStaleBanner();
  }
}

function pieceSlug(item) {
  return (item.local_slug || item.name || "").toLowerCase();
}

function findItemBySlug(slug) {
  if (!slug || !galleryData) return null;
  var q = String(slug).trim();
  var qLow = q.toLowerCase();
  // Share links use getItemKey (e.g. badges-…, dagato-agency-v1-12)
  if (typeof itemsById !== "undefined" && itemsById) {
    if (itemsById.has(q)) return itemsById.get(q);
    if (itemsById.has(qLow)) return itemsById.get(qLow);
  }
  var bareTokenHits = [];
  for (var i = 0; i < galleryData.items.length; i++) {
    var it = galleryData.items[i];
    var key = getItemKey(it);
    if (key === q || String(key).toLowerCase() === qLow) return it;
    if (pieceSlug(it) === qLow) return it;
    // Bare numeric token_id — only safe when unique (Agency reuses #s across volumes)
    if (String(it.token_id) === q || String(it.token_id) === qLow) {
      bareTokenHits.push(it);
    }
  }
  if (bareTokenHits.length === 1) return bareTokenHits[0];
  return null;
}

function parsePieceFromUrl() {
  return (new URLSearchParams(window.location.search).get("piece") || "").trim();
}

/**
 * Absolute share URL for one NFT. Opens detail on load via ?piece= + optional collection
 * so secondary catalogs (badges / BIG KIX / Agency) load the right data set.
 */
function pieceShareUrl(item) {
  if (!item) return dacommunityBaseUrl().toString();
  var url = dacommunityBaseUrl();
  url.search = "";
  var cid = item.collection_id || "dacommunity";
  if (cid && cid !== "all") url.searchParams.set("collection", cid);
  url.searchParams.set("piece", getItemKey(item));
  return url.toString();
}

function applyPieceFromUrl() {
  var slug = parsePieceFromUrl();
  if (!slug) return;
  var item = findItemBySlug(slug);
  if (item) {
    // Deep-link restore: replace, don't push a second history entry
    openDetail(item, { noPush: true });
    return;
  }
  // Retry once items index is warm (secondary catalogs / wallet merge)
  if (!applyPieceFromUrl._retried) {
    applyPieceFromUrl._retried = true;
    window.setTimeout(function () {
      applyPieceFromUrl._retried = false;
      var again = findItemBySlug(slug);
      if (again) openDetail(again, { noPush: true });
    }, 600);
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
    const isOurData = /\/data\/(gallery_(data|meta|catalog|wallet_index)|name_index|videos|badges_(data|catalog)|bigkix_(data|catalog)|dagato_agency_(data|catalog)|hats_n_dacats_(data|catalog)|collections_registry)\.json(\?|$)/i.test(url);
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

/** Multi-1:1 trillion/billion club series card (generic art only — not personal editions). */
function isBadgeMultiSeriesRep(item) {
  return !!(
    item &&
    item.is_series_rep &&
    !item.edition_club &&
    item.source_created_collection &&
    /trillion|billion/i.test(item.source_created_collection)
  );
}

/** Force generic local PNG for club series cards; keep personal art only on non-rep rows. */
function normalizeBadgeSeriesImages(item) {
  if (!isBadgeMultiSeriesRep(item)) return;
  var slug = (item.local_slug || "").trim();
  if (slug) {
    item.image_url = "assets/badges/" + slug + ".png";
    item.media_type = "image";
  }
  // Never fall back to a personal 1:1 OpenSea image on the series card
  item.opensea_image_url = null;
}

function indexItems(data) {
  if (data && data.collection) seedIdentityFromCollectionMeta(data.collection);
  itemsById.clear();
  (data.items || []).forEach(function (i) {
    if (!i.display_name) {
      i.display_name = i.local_slug || (i.name && i.name.toLowerCase().indexOf("dacat.") === 0 ? i.name : null);
    }
    normalizeBadgeSeriesImages(i);
    // Personal editions only: promote remote image_url to opensea_image_url when missing
    if (
      !isBadgeMultiSeriesRep(i) &&
      !i.opensea_image_url &&
      i.image_url &&
      i.image_url.indexOf("http") === 0
    ) {
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

async function loadNameIndex() {
  // Always re-fetch when URL stamp changes; allow one successful load per page
  if (nameIndex && nameIndex.by_address && Object.keys(nameIndex.by_address).length) {
    return nameIndex;
  }
  if (typeof NAME_INDEX_URL === "undefined" || !NAME_INDEX_URL) return null;
  try {
    nameIndex = await fetchJson(NAME_INDEX_URL, 12000);
    if (!nameIndex || !nameIndex.by_address) {
      nameIndex = { by_address: {}, name_aliases: {} };
    }
  } catch (e) {
    console.warn("name_index load failed (Base names optional):", e);
    nameIndex = { by_address: {}, name_aliases: {} };
  }
  return nameIndex;
}

function nameIndexEntry(address) {
  var key = (address || "").toLowerCase();
  if (!key) return null;
  if (nameIndex && nameIndex.by_address && nameIndex.by_address[key]) {
    return nameIndex.by_address[key];
  }
  return null;
}

async function loadWalletIndex() {
  // daCommunity wallet_index is shared for ENS on all collections (secondaries have no own index)
  try {
    if (!walletIndex) {
      var w = await fetchJson(WALLET_URL, 20000);
      walletIndex = (w && w.holders_index) || w || null;
    }
  } catch (e) {
    console.warn("Wallet index load failed:", e);
    if (!walletIndex) walletIndex = (galleryData && galleryData.holders_index) || null;
  }
  try {
    await loadNameIndex();
  } catch (e2) {}

  if (walletIndex && walletIndex.by_address && nameIndex && nameIndex.by_address) {
    Object.keys(walletIndex.by_address).forEach(function (a) {
      var e = walletIndex.by_address[a];
      var ni = nameIndex.by_address[a] || nameIndex.by_address[a.toLowerCase()];
      if (e && ni && ni.base_name && !e.base_name) e.base_name = ni.base_name;
    });
  }
  if (walletIndex && nameIndex && nameIndex.name_aliases) {
    if (!walletIndex.ens_aliases) walletIndex.ens_aliases = {};
    Object.keys(nameIndex.name_aliases).forEach(function (n) {
      if (!walletIndex.ens_aliases[n]) {
        walletIndex.ens_aliases[n] = nameIndex.name_aliases[n];
      }
    });
  }
  // Never derive ENS from badge NFT titles — reverse resolve only

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
    collectionsRegistry = { collections: [{ id: "dacommunity", name: "daCommunity NFTs", status: "live" }] };
    return;
  }
  try {
    collectionsRegistry = await fetchJson(REGISTRY_URL, 10000);
  } catch (e) {
    console.warn("Collections registry load failed, using fallback:", e);
    collectionsRegistry = { collections: [{ id: "dacommunity", name: "daCommunity NFTs", status: "live" }] };
  }
}

function buildCollectorsFromIndex(idx) {
  if (!idx || !idx.by_address) return [];
  return Object.values(idx.by_address)
    .map(function (e) {
      var holdings = e.holdings || [];
      var uq = Number(nvl(e.unique_pieces, holdings.length)) || 0;
      var cq = Number(e.collection_quantity);
      // Prefer explicit qty; else sum holding quantities; else fall back to unique
      if (isNaN(cq) || cq <= 0) {
        cq = 0;
        holdings.forEach(function (h) {
          var q = Number(h && h.quantity);
          cq += !isNaN(q) && q > 0 ? q : 1;
        });
      }
      if (cq < uq) cq = uq;
      var ni = nameIndexEntry(e.address);
      return {
        address: e.address,
        ens_name: e.ens_name,
        base_name: e.base_name || (ni && ni.base_name) || null,
        username: e.username,
        unique_pieces: uq,
        collection_quantity: cq,
      };
    })
    .sort(function (a, b) {
      var ua = Number(a.unique_pieces) || 0;
      var ub = Number(b.unique_pieces) || 0;
      if (ub !== ua) return ub - ua;
      return (Number(b.collection_quantity) || 0) - (Number(a.collection_quantity) || 0);
    });
}

/**
 * Canonical collection ids used by the dropdown / ?collection= URLs.
 * OpenSea / catalog meta still use slug "dacommunity-archive" — map that back so
 * hub links (?collection=dacommunity) don't filter to an empty grid.
 */
function normalizeCollectionId(cid) {
  if (cid == null || cid === "") return "dacommunity";
  var id = String(cid).trim();
  if (!id || id === "all") return "dacommunity";
  if (id === "dacommunity-archive" || id === "dacommunity_archive") return "dacommunity";
  return id;
}

/** Stamp missing collection_id. Never use "all" (breaks secondary vs archive splits). */
function stampMissingCollectionId(items, preferredId) {
  var cid = normalizeCollectionId(preferredId || "dacommunity");
  (items || []).forEach(function (item) {
    if (!item.collection_id) {
      item.collection_id = cid;
    } else {
      // Repair legacy / catalog-slug stamps so archive filter matches hub links
      item.collection_id = normalizeCollectionId(item.collection_id);
    }
  });
}

function paintCollectorsUi() {
  rebuildCollectorsForCurrentView();
  enrichCollectorsListNames();
  renderTopCollectors();
  updateCollectorsButton();
}

/** "N unique · M copies" for modal / profile. */
function formatCollectorHoldLabel(c) {
  var uq = Number(c && c.unique_pieces) || 0;
  var cq = Number(c && c.collection_quantity) || 0;
  if (cq < uq) cq = uq;
  if (!uq && !cq) return "0 unique · 0 copies";
  return uq + " unique · " + cq + " copies";
}

/** Compact pill meta: "N·M" (unique · copies). */
function formatCollectorHoldMeta(c) {
  var uq = Number(c && c.unique_pieces) || 0;
  var cq = Number(c && c.collection_quantity) || 0;
  if (cq < uq) cq = uq;
  if (!uq && !cq) return "0";
  return uq + "·" + cq;
}

function cleanIdentityName(v) {
  if (v == null || v === "") return null;
  var s = String(v).trim();
  return s || null;
}

/** Merge into extraIdentityByAddress (does not overwrite stronger values). */
function seedIdentityHint(address, fields) {
  var key = String(address || "")
    .toLowerCase()
    .trim();
  if (!key || key.indexOf("0x") !== 0) return;
  fields = fields || {};
  if (!extraIdentityByAddress[key]) extraIdentityByAddress[key] = {};
  var e = extraIdentityByAddress[key];
  var ens = cleanIdentityName(fields.ens_name);
  var base = cleanIdentityName(fields.base_name);
  var user = cleanIdentityName(fields.username);
  if (ens && !e.ens_name) e.ens_name = ens.toLowerCase();
  if (base && !e.base_name) e.base_name = base;
  if (user && !e.username && !/^0x[a-fA-F0-9]{10,}$/i.test(user)) e.username = user;
}

function seedIdentityFromCollectionMeta(col) {
  if (!col) return;
  var cw = col.creator_wallet;
  if (!cw) return;
  if (typeof cw === "string") {
    seedIdentityHint(cw, {});
    return;
  }
  seedIdentityHint(cw.address || cw.wallet, {
    ens_name: cw.ens_name,
    username: cw.username,
    base_name: cw.base_name,
  });
}

function seedIdentitiesFromLoadedData() {
  if (galleryData && galleryData.collection) {
    seedIdentityFromCollectionMeta(galleryData.collection);
  }
}

/** ensdata reverse-primary for holders not in wallet_index. Uses ens_primary only. */
function fetchReverseEns(address) {
  var key = String(address || "")
    .toLowerCase()
    .trim();
  if (!key || !/^0x[a-f0-9]{40}$/.test(key)) return Promise.resolve(null);
  if (reverseEnsFailed[key]) return Promise.resolve(null);
  var known = resolveCollectorIdentity(key);
  if (known.ens_name) return Promise.resolve(known.ens_name);
  if (reverseEnsPending[key]) return reverseEnsPending[key];

  reverseEnsPending[key] = fetch("https://ensdata.net/" + encodeURIComponent(key), {
    credentials: "omit",
  })
    .then(function (r) {
      if (!r.ok) throw new Error("ensdata " + r.status);
      return r.json();
    })
    .then(function (data) {
      delete reverseEnsPending[key];
      if (!data) {
        reverseEnsFailed[key] = 1;
        return null;
      }
      // Reverse-primary only (same rule as backend opensea_client.resolve_ens_name)
      var ens = data.ens_primary;
      if (!ens) {
        reverseEnsFailed[key] = 1;
        return null;
      }
      ens = String(ens).toLowerCase().trim();
      var eth = "";
      if (data.wallets && data.wallets.eth) eth = String(data.wallets.eth).toLowerCase();
      else if (data.address) eth = String(data.address).toLowerCase();
      if (eth && eth !== key) {
        reverseEnsFailed[key] = 1;
        return null;
      }
      seedIdentityHint(key, { ens_name: ens });
      return ens;
    })
    .catch(function () {
      delete reverseEnsPending[key];
      reverseEnsFailed[key] = 1;
      return null;
    });
  return reverseEnsPending[key];
}

/** True when we only have a short/full 0x label (worth a reverse lookup). */
function identityNeedsReverseLookup(addressOrRow) {
  var id = resolveCollectorIdentity(addressOrRow);
  if (id.ens_name || id.base_name || id.username) return false;
  if (!id.address || !/^0x[a-f0-9]{40}$/.test(id.address)) return false;
  if (reverseEnsFailed[id.address] || reverseEnsPending[id.address]) return false;
  return true;
}

/**
 * For collector pills / wallet / modal: reverse-resolve missing names, then refresh UI once.
 */
function ensureNamesForAddresses(addresses) {
  var need = [];
  var seen = {};
  (addresses || []).forEach(function (a) {
    var key = String(a || "")
      .toLowerCase()
      .trim();
    if (!key || seen[key]) return;
    seen[key] = 1;
    if (identityNeedsReverseLookup(key)) need.push(key);
  });
  if (!need.length) return;
  Promise.all(need.map(fetchReverseEns)).then(function (results) {
    if (results.some(Boolean)) scheduleIdentityUiRefresh();
  });
}

function scheduleIdentityUiRefresh() {
  if (identityUiRefreshTimer) return;
  identityUiRefreshTimer = window.setTimeout(function () {
    identityUiRefreshTimer = null;
    enrichCollectorsListNames();
    if (galleryData && Array.isArray(galleryData.items)) {
      stampAllOwnerIdentities(galleryData.items);
    }
    // Refresh list UIs that already painted short 0x labels
    renderTopCollectors._fromIdentityRefresh = true;
    renderTopCollectors();
    renderTopCollectors._fromIdentityRefresh = false;
    var modal = $("#collectors-modal");
    if (modal && !modal.hidden) {
      var filterEl = $("#collectors-filter");
      renderCollectors(filterEl ? filterEl.value : "");
    }
    if (galleryCollectorView && galleryCollectorView.address) {
      var id = resolveCollectorIdentity(galleryCollectorView.address);
      galleryCollectorView.label = id.display;
      renderCollectorFocusUi();
    }
    var nameEl = document.querySelector(".collector-profile-name");
    if (nameEl && galleryCollectorView && galleryCollectorView.address) {
      nameEl.textContent = resolveCollectorIdentity(galleryCollectorView.address).display;
    }
    if (activeDetailTokenId) {
      var openItem = itemsById.get(activeDetailTokenId);
      if (openItem) refreshDetailPanel(openItem);
    }
  }, 80);
}

/**
 * Display name priority: reverse ENS → Base → OpenSea username → short 0x.
 * Prefer wallet_index / ensdata reverse; never NFT title text.
 */
function resolveCollectorIdentity(addressOrRow) {
  var key = "";
  var row = null;
  if (addressOrRow && typeof addressOrRow === "object") {
    row = addressOrRow;
    key = String(row.address || "").toLowerCase().trim();
  } else {
    key = String(addressOrRow || "").toLowerCase().trim();
  }
  if (!key) {
    return {
      address: "",
      ens_name: null,
      base_name: null,
      username: null,
      display: "",
      lookupValue: "",
      full: "",
      showFullHex: false,
    };
  }

  var entry =
    walletIndex && walletIndex.by_address && walletIndex.by_address[key]
      ? walletIndex.by_address[key]
      : null;
  var extra = extraIdentityByAddress[key] || null;
  var ni = nameIndexEntry(key);

  var ens =
    cleanIdentityName(entry && entry.ens_name) ||
    cleanIdentityName(extra && extra.ens_name) ||
    cleanIdentityName(row && row.ens_name) ||
    cleanIdentityName(ni && ni.ens_name) ||
    null;
  if (ens) ens = ens.toLowerCase();

  // Drop ENS if aliases map it to a different address
  if (ens && walletIndex && walletIndex.ens_aliases) {
    var mapped = walletIndex.ens_aliases[ens];
    if (mapped && String(mapped).toLowerCase() !== key) {
      ens = null;
    }
  }

  var base =
    cleanIdentityName(entry && entry.base_name) ||
    cleanIdentityName(extra && extra.base_name) ||
    cleanIdentityName(ni && ni.base_name) ||
    cleanIdentityName(row && row.base_name) ||
    null;

  var username =
    cleanIdentityName(entry && entry.username) ||
    cleanIdentityName(extra && extra.username) ||
    cleanIdentityName(row && row.username) ||
    cleanIdentityName(ni && ni.username) ||
    null;
  if (username && /^0x[a-fA-F0-9]{10,}$/i.test(username)) username = null;

  var display = ens || base || username || shortenAddress(key);
  var lookupValue = ens || base || username || key;

  return {
    address: key,
    ens_name: ens,
    base_name: base,
    username: username,
    display: display,
    lookupValue: lookupValue,
    full: key,
    showFullHex: display !== key,
  };
}

/** Display name: ENS → Base name → OpenSea username → short 0x */
function formatCollectorDisplayName(c) {
  if (!c) return "";
  return resolveCollectorIdentity(c).display;
}

/** Attach resolved identity fields onto a collectors / entry row. */
function enrichCollectorRowNames(c) {
  if (!c || !c.address) return c;
  var id = resolveCollectorIdentity(c);
  c.ens_name = id.ens_name;
  c.base_name = id.base_name;
  c.username = id.username;
  return c;
}

/** Stamp owner chip rows from wallet_index + name_index (full identity, not ENS-only). */
function stampOwnerIdentity(o) {
  if (!o || !o.address) return o;
  var id = resolveCollectorIdentity(o);
  o.ens_name = id.ens_name;
  o.base_name = id.base_name;
  o.username = id.username;
  return o;
}

function stampAllOwnerIdentities(items) {
  (items || []).forEach(function (item) {
    var os = item && item.owners;
    if (!os) return;
    ["holders", "top_holders"].forEach(function (k) {
      (os[k] || []).forEach(stampOwnerIdentity);
    });
  });
}

function enrichCollectorsListNames() {
  (collectorsList || []).forEach(enrichCollectorRowNames);
}

/** True if collector matches free-text query (ENS / Base / OS username / 0x). */
function collectorMatchesQuery(c, q) {
  if (!q) return true;
  var hay = [
    c.ens_name,
    c.base_name,
    c.username,
    c.address,
    formatCollectorDisplayName(c),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.indexOf(q) >= 0;
}

/**
 * Build suggestion rows for typeahead: ENS / Base / OpenSea / 0x.
 * One row per wallet address (merged names, no duplicates).
 */
function collectNameSuggestions(query, limit) {
  limit = limit || 8;
  var q = (query || "").trim().toLowerCase();
  if (q.length < 1) return [];

  // Distinct wallets: merge every source into one map by address
  var byAddr = {};
  function absorb(addr, ens, base, user) {
    var a = String(addr || "")
      .toLowerCase()
      .trim();
    if (!a || a.indexOf("0x") !== 0 || a.length < 10) return;
    if (!byAddr[a]) {
      byAddr[a] = {
        address: addr,
        ens_name: null,
        base_name: null,
        username: null,
      };
    }
    var r = byAddr[a];
    if (ens && !r.ens_name) r.ens_name = ens;
    if (base && !r.base_name) r.base_name = base;
    if (user && !r.username) r.username = user;
  }

  (collectorsList || []).forEach(function (c) {
    enrichCollectorRowNames(c);
    absorb(c.address, c.ens_name, c.base_name, c.username);
  });
  if (walletIndex && walletIndex.by_address) {
    Object.keys(walletIndex.by_address).forEach(function (a) {
      var e = walletIndex.by_address[a];
      absorb(e.address || a, e.ens_name, e.base_name, e.username);
    });
  }
  if (nameIndex && nameIndex.by_address) {
    Object.keys(nameIndex.by_address).forEach(function (a) {
      var e = nameIndex.by_address[a];
      absorb(e.address || a, e.ens_name, e.base_name, e.username);
    });
  }
  // Aliases map name → address; fold into the same wallet rows
  function absorbAlias(name, addr) {
    var n = String(name || "")
      .toLowerCase()
      .trim();
    if (!n || n.indexOf(q) < 0) return;
    var isBase = n.indexOf(".base.") >= 0 || n.endsWith(".base.eth");
    absorb(addr, isBase ? null : n, isBase ? n : null, null);
  }
  if (walletIndex && walletIndex.ens_aliases) {
    Object.keys(walletIndex.ens_aliases).forEach(function (n) {
      absorbAlias(n, walletIndex.ens_aliases[n]);
    });
  }
  if (nameIndex && nameIndex.name_aliases) {
    Object.keys(nameIndex.name_aliases).forEach(function (n) {
      absorbAlias(n, nameIndex.name_aliases[n]);
    });
  }

  var out = [];
  var seenLookup = {};
  Object.keys(byAddr).forEach(function (a) {
    var row = byAddr[a];
    enrichCollectorRowNames(row);
    if (!collectorMatchesQuery(row, q) && a.indexOf(q) < 0) return;
    var id = resolveCollectorIdentity(row);
    var label = id.display;
    var lookup = id.lookupValue || a;
    var lk = String(lookup).toLowerCase();
    if (seenLookup[lk] || seenLookup[a]) return;
    seenLookup[lk] = true;
    seenLookup[a] = true;
    var bits = [];
    if (row.ens_name && row.ens_name !== label) bits.push(row.ens_name);
    if (row.base_name && row.base_name !== label) bits.push(row.base_name);
    if (row.username && row.username !== label) bits.push(row.username);
    bits.push(shortenAddress(row.address || a));
    out.push({
      address: row.address || a,
      label: label,
      sub: bits.join(" · "),
      lookup: lookup,
      // Prefer prefix matches when sorting
      _rank: String(label).toLowerCase().indexOf(q) === 0 ? 0 : 1,
    });
  });

  out.sort(function (a, b) {
    if (a._rank !== b._rank) return a._rank - b._rank;
    return String(a.label).localeCompare(String(b.label));
  });
  return out.slice(0, limit);
}

function ensureSuggestBox(inputEl, boxId) {
  if (!inputEl || !inputEl.parentNode) return null;
  var box = document.getElementById(boxId);
  if (box) {
    // Re-bind scroll-safe handlers if box was recreated without them
    bindSuggestBoxKeepOpen(box, inputEl, boxId);
    return box;
  }
  var wrap =
    inputEl.closest(".lookup-field") ||
    inputEl.closest(".wallet-input-wrap") ||
    inputEl.parentNode;
  if (wrap && getComputedStyle(wrap).position === "static") {
    wrap.style.position = "relative";
  }
  box = document.createElement("div");
  box.id = boxId;
  box.className = "name-suggest-box";
  box.hidden = true;
  box.setAttribute("role", "listbox");
  if (wrap) wrap.appendChild(box);
  else inputEl.insertAdjacentElement("afterend", box);
  bindSuggestBoxKeepOpen(box, inputEl, boxId);
  return box;
}

/**
 * Hit-test for the typeahead panel including the native scrollbar.
 * Scrollbar clicks often report event.target as <html>/<body>, so contains()
 * alone is not enough — that made the list vanish when grabbing the thumb.
 */
function isPointerInSuggestUI(e, box, inputEl) {
  if (!e) return false;
  var x = e.clientX;
  var y = e.clientY;
  if (typeof x !== "number" || typeof y !== "number") {
    // Fallback: DOM containment only
    var t0 = e.target;
    if (box && box.contains(t0)) return true;
    if (inputEl && (t0 === inputEl || (inputEl.contains && inputEl.contains(t0)))) return true;
    return false;
  }
  function inRect(el) {
    if (!el || el.hidden) return false;
    var r = el.getBoundingClientRect();
    // 2px pad so edge/scrollbar clicks still count as inside
    return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
  }
  if (box && inRect(box)) return true;
  if (inputEl && inRect(inputEl)) return true;
  var wrap =
    inputEl &&
    (inputEl.closest(".lookup-field") || inputEl.closest(".wallet-input-wrap"));
  if (wrap && inRect(wrap)) return true;
  var t = e.target;
  if (box && t && box.contains(t)) return true;
  if (inputEl && t && (t === inputEl || (inputEl.contains && inputEl.contains(t)))) return true;
  if (wrap && t && wrap.contains(t)) return true;
  return false;
}

/**
 * Keep the typeahead open while the user scrolls/clicks inside it.
 * Dismiss only on true outside pointerdown or Escape.
 */
function bindSuggestBoxKeepOpen(box, inputEl, boxId) {
  if (!box || box.dataset.keepOpenBound === "1") return;
  box.dataset.keepOpenBound = "1";
  // Mark interaction so any residual blur handlers never race-close mid-scroll
  box.addEventListener(
    "pointerdown",
    function () {
      box.dataset.suggestPointer = "1";
    },
    true
  );
  box.addEventListener(
    "pointerup",
    function () {
      setTimeout(function () {
        if (box) box.dataset.suggestPointer = "";
      }, 0);
    },
    true
  );

  if (!document.documentElement.dataset["suggestOutside_" + boxId]) {
    document.documentElement.dataset["suggestOutside_" + boxId] = "1";
    document.addEventListener(
      "pointerdown",
      function (e) {
        var b = document.getElementById(boxId);
        if (!b || b.hidden) return;
        // Geometry hit-test includes scrollbar track/thumb
        if (isPointerInSuggestUI(e, b, inputEl)) return;
        hideNameSuggest(boxId);
      },
      true
    );
  }
}

function hideNameSuggest(boxId) {
  var box = document.getElementById(boxId);
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
    box.dataset.suggestPointer = "";
  }
}

function renderNameSuggest(inputEl, boxId, onPick) {
  if (!inputEl) return;
  var box = ensureSuggestBox(inputEl, boxId);
  if (!box) return;
  var q = inputEl.value.trim();
  if (q.length < 1) {
    hideNameSuggest(boxId);
    return;
  }
  // More rows so the scrollbar is actually useful for "da" style prefixes
  var rows = collectNameSuggestions(q, 16);
  if (!rows.length) {
    hideNameSuggest(boxId);
    return;
  }
  box.hidden = false;
  box.innerHTML = rows
    .map(function (r, i) {
      return (
        '<button type="button" class="name-suggest-item" role="option" data-i="' +
        i +
        '" data-lookup="' +
        escapeHtml(r.lookup) +
        '" data-address="' +
        escapeHtml(r.address) +
        '"><span class="name-suggest-label">' +
        escapeHtml(r.label) +
        '</span><span class="name-suggest-sub">' +
        escapeHtml(r.sub) +
        "</span></button>"
      );
    })
    .join("");
  box.querySelectorAll(".name-suggest-item").forEach(function (btn) {
    // mousedown + preventDefault: pick without blurring/closing via focus loss
    btn.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var lookup = btn.getAttribute("data-lookup");
      var addr = btn.getAttribute("data-address");
      hideNameSuggest(boxId);
      if (onPick) onPick(lookup, addr);
    });
  });
}

/** No-op kept for call sites that refreshed suggestions after data load. */
function renderNameSuggestDatalists() {
  // Native <datalist> removed — it doubled the custom dropdown and showed
  // an empty/side helper before typing. Custom name-suggest-box only.
  document.querySelectorAll("#wallet-name-datalist, #collectors-name-datalist").forEach(function (dl) {
    if (dl && dl.parentNode) dl.parentNode.removeChild(dl);
  });
  var walletInput = $("#wallet-input");
  if (walletInput) walletInput.removeAttribute("list");
  var cs = $("#collectors-search");
  if (cs) cs.removeAttribute("list");
}

function bindNameSuggestInputs() {
  var walletInput = $("#wallet-input");
  if (walletInput && !walletInput.dataset.suggestBound) {
    walletInput.dataset.suggestBound = "1";
    // Kill browser datalist helper if anything re-added it
    walletInput.removeAttribute("list");
    walletInput.setAttribute("autocomplete", "off");
    walletInput.addEventListener("input", function () {
      renderNameSuggest(walletInput, "wallet-name-suggest", function (lookup, addr) {
        // Always resolve via 0x when we have it (OpenSea / ENS labels alone used to 404)
        if (addr) {
          runWalletLookupFromAddress(addr, lookup);
        } else {
          walletInput.value = lookup;
          renderWalletLookup(lookup, { updateUrl: true, scroll: false });
        }
      });
    });
    walletInput.addEventListener("focus", function () {
      // Only show after the user has typed something
      if (walletInput.value.trim().length >= 1) {
        renderNameSuggest(walletInput, "wallet-name-suggest", function (lookup, addr) {
          if (addr) {
            runWalletLookupFromAddress(addr, lookup);
          } else {
            walletInput.value = lookup;
            renderWalletLookup(lookup, { updateUrl: true, scroll: false });
          }
        });
      }
    });
    // Do not hide on blur — scrollbar/item clicks blur the input and were
    // killing the list. Outside pointerdown (bindSuggestBoxKeepOpen) handles dismiss.
    walletInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") hideNameSuggest("wallet-name-suggest");
    });
  }

  var cs = $("#collectors-search");
  if (cs && !cs.dataset.suggestBound) {
    cs.dataset.suggestBound = "1";
    cs.removeAttribute("list");
    cs.setAttribute("autocomplete", "off");
    cs.addEventListener("input", function () {
      renderCollectors(cs.value);
      renderNameSuggest(cs, "collectors-name-suggest", function (lookup, addr) {
        cs.value = lookup;
        renderCollectors(lookup);
        hideNameSuggest("collectors-name-suggest");
        if (addr) {
          closeCollectorsModal();
          runWalletLookupFromAddress(addr, lookup);
        }
      });
    });
    cs.addEventListener("keydown", function (e) {
      if (e.key === "Escape") hideNameSuggest("collectors-name-suggest");
    });
  }
}

/** Merge collector rows by address, summing unique + copies (for All collections). */
function mergeCollectorRows(lists) {
  var map = {};
  (lists || []).forEach(function (list) {
    (list || []).forEach(function (c) {
      if (!c || !c.address) return;
      var k = String(c.address).toLowerCase();
      var pieces = Number(c.unique_pieces) || 0;
      var qty = Number(c.collection_quantity) || 0;
      if (qty < pieces) qty = pieces;
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
    });
  });
  return Object.values(map).sort(function (a, b) {
    var ua = Number(a.unique_pieces) || 0;
    var ub = Number(b.unique_pieces) || 0;
    if (ub !== ua) return ub - ua;
    return (Number(b.collection_quantity) || 0) - (Number(a.collection_quantity) || 0);
  });
}

/**
 * Badge top-collector stats. Skip multi-1:1 series_rep (browse-only), same as wallet holdings.
 * Count personal 1:1s + edition_club rows only.
 */
function buildCollectorsFromBadgeItems(items) {
  var byAddr = {};
  (items || []).forEach(function (item) {
    if (!item.source_created_collection) return;
    if (isBadgeMultiSeriesRep(item)) return;
    var slug = item.source_created_collection;
    var itemKey = getItemKey(item);
    var os = item.owners || {};
    var list = os.holders || os.top_holders || [];
    list.forEach(function (h) {
      var a = (h.address || "").toLowerCase();
      if (!a) return;
      if (!byAddr[a]) {
        byAddr[a] = {
          address: h.address,
          ens_name: h.ens_name || null,
          username: h.username || null,
          unique_pieces: 0,
          collection_quantity: 0,
          _slugs: {},
          _keys: {},
        };
      } else {
        if (h.ens_name && !byAddr[a].ens_name) byAddr[a].ens_name = h.ens_name;
        if (h.username && !byAddr[a].username) byAddr[a].username = h.username;
      }
      var q = Number(h.quantity);
      byAddr[a].collection_quantity += !isNaN(q) && q > 0 ? q : 1;
      if (slug) byAddr[a]._slugs[slug] = true;
      if (itemKey) byAddr[a]._keys[itemKey] = true;
    });
  });
  Object.keys(byAddr).forEach(function (a) {
    enrichCollectorRowNames(byAddr[a]);
  });
  return Object.values(byAddr)
    .map(function (e) {
      var keyCount = e._keys ? Object.keys(e._keys).length : 0;
      var slugCount = e._slugs ? Object.keys(e._slugs).length : 0;
      e.unique_pieces = keyCount || slugCount || e.collection_quantity;
      delete e._slugs;
      delete e._keys;
      return e;
    })
    .sort(function (a, b) {
      var ua = Number(a.unique_pieces) || 0;
      var ub = Number(b.unique_pieces) || 0;
      if (ub !== ua) return ub - ua;
      return (Number(b.collection_quantity) || 0) - (Number(a.collection_quantity) || 0);
    });
}

/** Attach reverse-resolved ENS / Base / OpenSea onto collectors (never from NFT titles). */
function enrichHoldersAndCollectorsWithENS() {
  if (!collectorsList || !collectorsList.length) return;
  collectorsList.forEach(enrichCollectorRowNames);
  if (galleryData && Array.isArray(galleryData.items)) {
    stampAllOwnerIdentities(galleryData.items);
  }
}

/** Steward/issuer wallets excluded from collector rankings (BIG KIX + badges data already omit them). */
function excludedCollectorAddresses(items) {
  var out = {};
  var col =
    (galleryData && galleryData.collection) ||
    (items && items[0] && null) ||
    null;
  if (galleryData && galleryData.collection) col = galleryData.collection;
  if (col && col.creator_excluded_from_stats) {
    var cw = col.creator_wallet || {};
    if (cw.address) out[String(cw.address).toLowerCase()] = true;
  }
  // BIG KIX steward (fetch_bigkix CREATOR_ADDRESS)
  if (
    (col && (col.id === "bigkix" || col.slug === "bigkix")) ||
    activeCollection === "bigkix"
  ) {
    out["0xa6d5c9602a49afddff9873cf51db2991dec2c9ee"] = true;
  }
  // HATS n' daCATs project mint wallet (hatsndacats.eth) — not a collector
  if (
    (col && (col.id === "hats-n-dacats" || col.slug === "hats-n-dacats")) ||
    activeCollection === "hats-n-dacats"
  ) {
    out["0xd23ace74f9749eb5040311e5d8654bce88d0cfb8"] = true;
  }
  return out;
}

/**
 * Build collectors list from currently loaded gallery items.
 * Uses the same per-item ownership rules as buildHoldingsFromCurrentItems so the
 * collectors-modal "N pieces" count matches the collector wallet view when both
 * daCommunity + badges are loaded ("All collections").
 *
 * opts.rankByCopies — rank by total quantity held (BIG KIX multi-copy editions).
 */
function buildCollectorsFromLoadedItems(items, opts) {
  opts = opts || {};
  var rankByCopies = opts.rankByCopies === true;
  var exclude = excludedCollectorAddresses(items);
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
      if (!a || exclude[a]) return;
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
  return Object.values(byAddr)
    .map(enrichCollectorRowNames)
    .sort(function (a, b) {
      if (rankByCopies) {
        var qa = Number(a.collection_quantity) || 0;
        var qb = Number(b.collection_quantity) || 0;
        if (qb !== qa) return qb - qa;
        return (Number(b.unique_pieces) || 0) - (Number(a.unique_pieces) || 0);
      }
      var ua = Number(a.unique_pieces) || 0;
      var ub = Number(b.unique_pieces) || 0;
      if (ub !== ua) return ub - ua;
      return (Number(b.collection_quantity) || 0) - (Number(a.collection_quantity) || 0);
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
    } else if (activeCollection === "bigkix") {
      // BIG KIX: rank by total copies held (not unique designs)
      collectorsList = buildCollectorsFromLoadedItems(items, { rankByCopies: true });
    } else {
      collectorsList = buildCollectorsFromLoadedItems(items);
    }
    updateCollectorsButton();
    return;
  }
  if (!activeCollection || activeCollection === "all") {
    // All collections: daCommunity from wallet index (full Base qty) + every other
    // collection from item owners (badges / BIG KIX / Agency). Sum uniques + copies.
    var allItems = (galleryData && galleryData.items) || [];
    var secondaryItems = allItems.filter(function (i) {
      return normalizeCollectionId(i.collection_id || "dacommunity") !== "dacommunity";
    });
    var dacomItems = allItems.filter(function (i) {
      return normalizeCollectionId(i.collection_id || "dacommunity") === "dacommunity";
    });
    var dacomCols = [];
    if (walletIndex && (walletIndex.by_address || walletIndex.collectors)) {
      dacomCols = buildCollectorsFromIndex(walletIndex);
    }
    if (!dacomCols.length && dacomItems.length) {
      dacomCols = buildCollectorsFromLoadedItems(dacomItems);
    }
    var badgeCols = buildCollectorsFromBadgeItems(secondaryItems);
    var otherCols = buildCollectorsFromLoadedItems(
      secondaryItems.filter(function (i) {
        return !i.source_created_collection;
      })
    );
    collectorsList = mergeCollectorRows([dacomCols, badgeCols, otherCols]);
  } else if (activeCollection === "dacommunity") {
    collectorsList = buildCollectorsFromIndex(walletIndex);
    if (!collectorsList.length && galleryData && galleryData.items) {
      collectorsList = buildCollectorsFromLoadedItems(galleryData.items);
    }
  }
  enrichCollectorsListNames();
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

/**
 * Normalize HATS titles so series # is always first: "#015 - Name".
 * OpenSea mid-batch titles sometimes use "HATS n' daCATs #015".
 */
function normalizeHatsDisplayTitle(raw, tokenId, traits) {
  var s = String(raw || "").trim();
  var tid = tokenId != null ? String(tokenId) : "";
  function traitVal(names) {
    var list = traits || [];
    var want = {};
    names.forEach(function (n) {
      want[String(n).toLowerCase()] = true;
    });
    for (var i = 0; i < list.length; i++) {
      var tt = String((list[i] && list[i].trait_type) || "")
        .trim()
        .toLowerCase();
      if (!want[tt]) continue;
      var v = String((list[i] && list[i].value) || "").trim();
      if (v && v.toLowerCase() !== "none" && v.toLowerCase() !== "n/a") return v;
    }
    return "";
  }
  function fmt(num, rest) {
    var n = String(parseInt(num, 10));
    if (isNaN(Number(n))) n = String(num || tid || "");
    while (n.length < 3) n = "0" + n;
    rest = String(rest || "").replace(/\s+/g, " ").trim();
    return rest ? "#" + n + " - " + rest : "#" + n;
  }
  var m = s.match(/^#\s*(\d+)\s*[-–—:]\s*(.+)$/);
  if (m) return fmt(m[1], m[2]);
  var m2 = s.match(/^(.+?)\s*#\s*(\d+)\s*$/);
  if (m2) {
    var prefix = m2[1].trim();
    var gear = traitVal(["Gear Name", "Hat", "Name", "Title"]);
    var head = traitVal(["Headwear Type"]);
    var rest = "";
    if (gear) rest = gear;
    else if (prefix && !/^hats\s*n['’]?\s*dacats$/i.test(prefix)) rest = prefix;
    else if (head) rest = head;
    else rest = prefix;
    return fmt(m2[2], rest);
  }
  var m3 = s.match(/^#?\s*(\d+)\s*$/);
  if (m3) return fmt(m3[1], traitVal(["Gear Name", "Hat", "Name", "Title"]) || traitVal(["Headwear Type"]));
  if ((arguments.length && tid) || s) {
    // leave non-hat-looking strings alone when called without hat context
  }
  return s;
}

function itemTitle(item) {
  if (!item) return "Token #";
  if ((item.collection_id || "") === "hats-n-dacats") {
    var raw = item.display_name || item.name || item.opensea_name || "";
    var normalized = normalizeHatsDisplayTitle(raw, item.token_id, item.traits);
    if (normalized) return normalized;
  }
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
  // HATS n' daCATs: "#020 - Cosmic Commander Helmet" → accent number + name
  // Separator is its own span with preserved spaces — trailing " · " inside
  // .piece-prefix collapses when flex-wrap puts the name on the next line.
  var hatM = t.match(/^#\s*(\d+)\s*[-–—]\s*(.+)$/);
  if (hatM) {
    return (
      '<span class="piece-title piece-title-hat"><span class="piece-prefix">#' +
      escapeHtml(String(parseInt(hatM[1], 10))) +
      '</span><span class="piece-sep" aria-hidden="true"> · </span><span class="piece-name">' +
      escapeHtml(hatM[2].trim()) +
      "</span></span>"
    );
  }
  // Trailing number fallback (pre-normalize data): "HATS n' daCATs #015"
  var hatTrail = t.match(/^(.+?)\s*#\s*(\d+)\s*$/);
  if (hatTrail) {
    return (
      '<span class="piece-title piece-title-hat"><span class="piece-prefix">#' +
      escapeHtml(String(parseInt(hatTrail[2], 10))) +
      '</span><span class="piece-sep" aria-hidden="true"> · </span><span class="piece-name">' +
      escapeHtml(hatTrail[1].trim()) +
      "</span></span>"
    );
  }
  return escapeHtml(t);
}

/**
 * Circulating supply from live owner stats (same numbers shown on detail chips).
 * Prefer owners.circulating_copies; fall back to holder qty sum / edition_size.
 */
function effectiveCirculatingCopies(item) {
  if (!item) return null;
  var owners = item.owners || {};
  if (owners.circulating_copies != null && owners.circulating_copies !== "") {
    var n = Number(owners.circulating_copies);
    if (!isNaN(n) && n >= 0) return n;
  }
  var holders = resolveHoldersList(item);
  if (holders.length) {
    var sum = 0;
    holders.forEach(function (h) {
      var q = parseInt(h.quantity, 10);
      sum += isNaN(q) ? 1 : q;
    });
    if (sum > 0) return sum;
  }
  if (item.edition_size != null && item.edition_size !== "") {
    var e = Number(item.edition_size);
    if (!isNaN(e) && e > 0) return e;
  }
  if (owners.holder_count != null && owners.holder_count !== "") {
    var h = Number(owners.holder_count);
    if (!isNaN(h) && h >= 0) return h;
  }
  return null;
}

/** Normalize Agency rarity trait / field strings. */
function normalizeAgencyRarityLabel(raw) {
  if (raw == null || raw === "") return null;
  var s = String(raw).trim();
  var key = s.toLowerCase().replace(/\s+/g, "");
  if (key === "1:1" || key === "1of1" || key === "1/1" || key === "oneofone") return "1:1";
  if (key === "common") return "Common";
  if (key === "uncommon") return "Uncommon";
  if (key === "epic") return "Epic";
  if (key === "legendary") return "Legendary";
  return s;
}

/**
 * Rarity label for badges / gallery cards / detail.
 * - HATS n' daCATs: always true 1:1 (owner or steward).
 * - Detective Agency: authored trait rarity (Common → Legendary → 1:1).
 * - BIG KIX: no supply rarity tags (large steward inventories / ~333 editions).
 * - Badges + daCommunity archive: live supply tiers from website stats —
 *     1 copy → 1:1 · ≤5 → Ultra Rare · ≤10 → Rare.
 * Stale is_1_of_1 flags are ignored when circulating supply contradicts them.
 */
function itemRarityLabel(item) {
  if (!item) return null;
  var cid = item.collection_id || "";

  // HATS: every piece is a unique 1:1 by design
  if (cid === "hats-n-dacats") return "1:1";

  // BIG KIX: skip supply tiers — creator still holds large stacks of most editions
  if (cid === "bigkix") return null;

  // Agency: keep trait / rarity field (supply tiers would mislabel Legendary editions)
  if (cid === "dagato-agency" || isAgencyRaritySeries(item)) {
    if (item.rarity) return normalizeAgencyRarityLabel(item.rarity);
    var traits = item.traits || [];
    for (var i = 0; i < traits.length; i++) {
      var tt = (traits[i].trait_type || "").toLowerCase();
      if (tt === "rarity" && traits[i].value) {
        return normalizeAgencyRarityLabel(traits[i].value);
      }
    }
    return null;
  }

  // Supply-based tiers (badges, daCommunity, etc.) from holder/copy stats on the piece
  var copies = effectiveCirculatingCopies(item);
  if (copies != null) {
    if (copies <= 1) return "1:1";
    if (copies <= 5) return "Ultra Rare";
    if (copies <= 10) return "Rare";
    return null;
  }

  // No owner stats yet — never invent 1:1 from a stale catalog flag
  return null;
}

/** Empty / placeholder trait values (OpenSea often sends Gear: "None"). */
function isEmptyTraitValue(v) {
  var s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  return !s || s === "none" || s === "n/a" || s === "null" || s === "-" || s === "—";
}

/**
 * Traits for cards / detail.
 * opts.mode: "card" | "detail" (default detail-ish)
 * HATS cards prefer Production → Headwear Type → Theme (3 chips), never "None".
 */
function itemTraitChips(item, maxN, opts) {
  opts = opts || {};
  maxN = maxN != null ? maxN : 4;
  var traits = (item && item.traits) || [];
  var isHats = item && (item.collection_id || "") === "hats-n-dacats";
  var mode = opts.mode || (isHats && maxN <= 3 ? "card" : "all");

  function usable(tr) {
    if (!tr) return false;
    var tt = String(tr.trait_type || "").trim();
    var tv = String(tr.value != null ? tr.value : "").trim();
    if (isEmptyTraitValue(tv)) return false;
    var ttL = tt.toLowerCase();
    if (/(_id|id)$/i.test(ttL) && /^\d+$/.test(tv)) return false;
    if (/^\d{6,}$/.test(tv)) return false;
    if (ttL === "rarity") return false;
    return true;
  }

  var cleaned = [];
  traits.forEach(function (tr) {
    if (!usable(tr)) return;
    cleaned.push({
      trait_type: String(tr.trait_type || "").trim() || "Trait",
      value: String(tr.value != null ? tr.value : "").trim(),
    });
  });

  // HATS: Production → Headwear Type → Theme first (card = top 3; detail = full list)
  if (isHats) {
    var preferred = ["production", "headwear type", "theme"];
    var out = [];
    var used = {};
    preferred.forEach(function (key) {
      if (out.length >= maxN) return;
      for (var i = 0; i < cleaned.length; i++) {
        var ttL = cleaned[i].trait_type.toLowerCase();
        if (ttL === key && !used[ttL]) {
          out.push(cleaned[i]);
          used[ttL] = true;
          break;
        }
      }
    });
    for (var j = 0; j < cleaned.length && out.length < maxN; j++) {
      var k = cleaned[j].trait_type.toLowerCase();
      if (used[k]) continue;
      out.push(cleaned[j]);
      used[k] = true;
    }
    return out;
  }

  return cleaned.slice(0, maxN);
}

function formatTraitChipsHtml(item, maxN) {
  var chips = itemTraitChips(item, maxN != null ? maxN : 3, { mode: "card" });
  if (!chips.length) return "";
  return chips
    .map(function (c) {
      var label = c.trait_type ? c.trait_type + ": " + c.value : c.value;
      return (
        '<span class="trait-chip" title="' +
        escapeHtml(label) +
        '">' +
        escapeHtml(c.value) +
        "</span>"
      );
    })
    .join("");
}

function rarityBadgeClass(label) {
  if (!label) return "";
  var k = String(label).toLowerCase().replace(/\s+/g, "");
  if (k === "1:1" || k === "1of1" || k === "1/1") return "rarity-badge-1of1";
  if (k === "ultrarare") return "rarity-badge-ultra-rare";
  if (k === "rare") return "rarity-badge-rare";
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
  if (isBadgeMultiSeriesRep(item)) {
    var local =
      item.image_url && String(item.image_url).indexOf("assets/badges/") === 0
        ? item.image_url
        : item.local_slug
          ? "assets/badges/" + item.local_slug + ".png"
          : item.image_url;
    return resolveMediaUrl(local || "");
  }
  return resolveMediaUrl(item.image_url || item.opensea_image_url || "");
}

function shortenAddress(addr) {
  if (!addr || addr.length < 12) return addr;
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function holderLabel(address) {
  return resolveCollectorIdentity(address).display;
}

/** Alias for resolveCollectorIdentity (owner chips, activity, collector nav). */
function addressDisplayMeta(addressOrRow) {
  return resolveCollectorIdentity(addressOrRow);
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
    var ids = galleryCollectorView.tokenIds || {};
    // Composite key only — bare token_id collides across collections (HATS vs archive)
    if (ids[getItemKey(item)]) {
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
  // Keep "dacommunity" (not only badges/bigkix) so hub cards land on a real scoped archive
  if (col) {
    // "all" stays all; archive slug aliases → dacommunity
    activeCollection =
      col === "all" ? "all" : normalizeCollectionId(col) || col;
  }
  var f = params.get("filter");
  if (f && FILTER_LABELS[f]) activeFilter = f;
  var s = params.get("sort");
  if (s && SORT_LABELS[s]) sortKey = s;
  var q = params.get("q") || params.get("search");
  if (q) searchQuery = q;
}

/**
 * Read deep-link hints from the address bar WITHOUT requiring in-memory UI state.
 * Critical: history replace/push must never invent a bare /dacommunity/ URL when the
 * user arrived via ?collection=… or ?wallet=… (that was wiping hub + share links).
 */
function readUrlNavHints() {
  var params = new URLSearchParams(window.location.search);
  return {
    collection: params.get("collection") || params.get("col") || "",
    q: params.get("q") || params.get("search") || "",
    filter: params.get("filter") || "",
    sort: params.get("sort") || "",
    wallet: (params.get("wallet") || params.get("ens") || "").trim(),
    piece: (params.get("piece") || "").trim(),
  };
}

function syncBrowseParamsToUrl() {
  try {
    // Keep wallet / piece history stack in sync (replace current entry)
    replaceNavState(
      activeDetailTokenId
        ? "detail"
        : galleryCollectorView || parseWalletFromUrl()
          ? "collector"
          : "browse"
    );
  } catch (e) {}
}

/* --- In-app history: browse ↔ collector wallet ↔ piece detail (browser Back works) --- */
var NAV_KIND = "dacatGallery";
var navSuppressPush = false;
/** How many in-app pushState steps we took this session (so ← Back won't leave the site). */
var navStackDepth = 0;
/** True after URL params have been applied into globals (safe to seed history). */
var navUrlParsed = false;

function currentNavSnapshot(view) {
  var hints = readUrlNavHints();
  // Prefer live UI state; fall back to URL so early replaceState cannot strip deep links
  var wallet =
    (galleryCollectorView && galleryCollectorView.address) ||
    hints.wallet ||
    null;
  var piece = activeDetailTokenId || hints.piece || null;
  // After URL parse, trust live UI — including cleared search / All collections.
  // Falling back to hints.q when searchQuery=="" re-stuck ?q= after Clear filters.
  var collection;
  var q;
  var filter;
  var sort;
  if (navUrlParsed) {
    collection = activeCollection || "all";
    q = searchQuery || "";
    filter = activeFilter || "all";
    sort = sortKey || "token_desc";
  } else {
    collection =
      activeCollection && activeCollection !== "all"
        ? activeCollection
        : hints.collection || activeCollection || "all";
    q = searchQuery || hints.q || "";
    filter =
      activeFilter && activeFilter !== "all"
        ? activeFilter
        : hints.filter || activeFilter || "all";
    sort =
      sortKey && sortKey !== "token_desc"
        ? sortKey
        : hints.sort || sortKey || "token_desc";
  }
  if (!collection) collection = "all";
  if (collection !== "all") collection = normalizeCollectionId(collection);

  var v = view;
  if (!v) {
    if (piece && (galleryCollectorView || wallet)) v = "detail";
    else if (piece) v = "detail";
    else if (galleryCollectorView || wallet) v = "collector";
    else v = "browse";
  }
  return {
    kind: NAV_KIND,
    view: v,
    wallet: wallet ? String(wallet).toLowerCase() : null,
    piece: piece || null,
    collection: collection || "all",
    q: q,
    filter: filter || "all",
    sort: sort || "token_desc",
  };
}

function urlFromNavState(st) {
  st = st || currentNavSnapshot();
  var params = new URLSearchParams();
  // Include dacommunity (and every non-all collection) so hub cards keep a stable slug
  if (st.collection && st.collection !== "all") {
    params.set("collection", st.collection);
  }
  if (st.q) params.set("q", st.q);
  if (st.filter && st.filter !== "all") params.set("filter", st.filter);
  if (st.sort && st.sort !== "token_desc") params.set("sort", st.sort);
  if (st.wallet) params.set("wallet", String(st.wallet).toLowerCase());
  if (st.piece) params.set("piece", st.piece);
  var qs = params.toString();
  // Only pin #wallet-panel when a wallet is in the URL (collector theater / share links)
  var hash = st.wallet ? "#wallet-panel" : "";
  return window.location.pathname + (qs ? "?" + qs : "") + hash;
}

function pushNavState(view, extra) {
  if (navSuppressPush) return;
  try {
    var st = Object.assign(currentNavSnapshot(view), extra || {});
    history.pushState(st, "", urlFromNavState(st));
    navStackDepth += 1;
  } catch (e) {}
}

function replaceNavState(view, extra) {
  try {
    var st = Object.assign(currentNavSnapshot(view), extra || {});
    history.replaceState(st, "", urlFromNavState(st));
  } catch (e) {}
}

/** True when Back should step our SPA stack (not leave the site). */
function canHistoryBackInApp() {
  return (
    navStackDepth > 0 &&
    history.state &&
    history.state.kind === NAV_KIND
  );
}

function applyBrowseControlsFromState() {
  var search = $("#search");
  if (search) search.value = searchQuery || "";
  var sort = $("#sort-select");
  if (sort) sort.value = sortKey || "token_desc";
  var colSel = $("#collection-select");
  if (colSel) colSel.value = activeCollection || "all";
  document.querySelectorAll(".filter").forEach(function (btn) {
    var on = btn.dataset.filter === activeFilter;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
}

/**
 * Browse filters (collection / search / listed / sort) are GLOBAL session state.
 *
 * CONTRACT — do not "clean up" filters when opening a wallet (product requirement):
 * - Archive / collection search → open NFT → "View collector" MUST keep the same
 *   filters in the portfolio so the grid stays scoped (e.g. Badges + a search term).
 * - Manual wallet lookup also leaves filters alone unless the user clears them.
 * - ONLY these paths may wipe or change filters:
 *     • Clear filters / Clear all (clearCollectorFilters, resetBrowseView)
 *     • Removing one filter chip (onBrowseFilterChipCleared — one key only)
 *     • Escape-key cascade in archive (handleEscapeKey)
 * - Clearing the collection chip reloads multi-collection data but keeps remaining chips.
 * Engineers: if a new entry path into collector view appears, call
 * captureBrowseFilterState() before side effects and reaffirmBrowseFilters() after —
 * never default to resetFilters / activeCollection = "all" on enter.
 */
function captureBrowseFilterState() {
  return {
    collection: activeCollection || "all",
    q: searchQuery || "",
    filter: activeFilter || "all",
    sort: sortKey || "token_desc",
  };
}

function applyBrowseFilterState(state) {
  if (!state) return;
  activeCollection = state.collection || "all";
  searchQuery = state.q || "";
  activeFilter = state.filter || "all";
  sortKey = state.sort || "token_desc";
  applyBrowseControlsFromState();
}

/** Re-sync filter globals → form controls + URL chips after entering collector view. */
function reaffirmBrowseFilters(preserved) {
  if (preserved) applyBrowseFilterState(preserved);
  else applyBrowseControlsFromState();
  try {
    syncBrowseParamsToUrl();
  } catch (e) {}
}

async function applyNavState(st) {
  if (!st || st.kind !== NAV_KIND) {
    parseBrowseParamsFromUrl();
    applyBrowseControlsFromState();
    if (parseWalletFromUrl()) {
      await applyWalletFromUrl();
    } else if (galleryCollectorView) {
      exitCollectorView({ fromPopstate: true, scrollToHub: false, keepLookup: false });
    }
    applyPieceFromUrl();
    refreshView();
    return;
  }

  activeCollection = st.collection || "all";
  searchQuery = st.q || "";
  activeFilter = st.filter || "all";
  sortKey = st.sort || "token_desc";
  applyBrowseControlsFromState();

  if (st.view === "browse") {
    closeDetail({ fromPopstate: true });
    if (galleryCollectorView) {
      exitCollectorView({
        fromPopstate: true,
        scrollToHub: false,
        keepLookup: false,
      });
    }
    refreshView();
    replaceNavState("browse");
    return;
  }

  // Collector wallet (and optional piece detail on top of wallet)
  if (st.wallet) {
    closeDetail({ fromPopstate: true });
    var inputW = $("#wallet-input");
    if (inputW) inputW.value = st.wallet;
    // History state filters already applied above — pass through so wallet open
    // cannot clobber them (see captureBrowseFilterState CONTRACT).
    var histFilters = {
      collection: st.collection || "all",
      q: st.q || "",
      filter: st.filter || "all",
      sort: st.sort || "token_desc",
    };
    await renderWalletLookup(st.wallet, {
      updateUrl: false,
      noPush: true,
      scrollBehavior: "instant",
      preserveFilters: histFilters,
    });
    reaffirmBrowseFilters(histFilters);
    if (!activeCollection || activeCollection === "all") {
      expandCollectorHoldingsFromLoadedData();
      renderCollectorFocusUi();
      refreshView();
    }
    if (st.view === "detail" && st.piece) {
      var itemW =
        itemsById.get(st.piece) ||
        findItemBySlug(st.piece) ||
        null;
      if (itemW) openDetail(itemW, { noPush: true });
    }
    return;
  }

  // Piece detail opened from archive / collection search (no wallet in stack)
  if (st.view === "detail" && st.piece) {
    closeDetail({ fromPopstate: true });
    if (galleryCollectorView) {
      exitCollectorView({
        fromPopstate: true,
        scrollToHub: false,
        keepLookup: false,
      });
    }
    refreshView();
    var itemA =
      itemsById.get(st.piece) ||
      findItemBySlug(st.piece) ||
      null;
    if (itemA) openDetail(itemA, { noPush: true });
    return;
  }

  closeDetail({ fromPopstate: true });
  if (galleryCollectorView) {
    exitCollectorView({ fromPopstate: true, scrollToHub: false });
  }
  refreshView();
}

function bindGalleryPopState() {
  if (bindGalleryPopState._bound) return;
  bindGalleryPopState._bound = true;
  window.addEventListener("popstate", function (e) {
    if (navStackDepth > 0) navStackDepth -= 1;
    navSuppressPush = true;
    Promise.resolve(applyNavState(e.state))
      .catch(function (err) {
        console.warn("popstate nav failed", err);
      })
      .then(function () {
        navSuppressPush = false;
      });
  });
  // Do NOT seed/replace URL here — activeCollection/wallet globals may still be defaults
  // and would rewrite ?collection=badges → bare /dacommunity/. Seed after parse in init.
}

/**
 * After parseBrowseParamsFromUrl(): attach NAV_KIND state without dropping deep links.
 * Call once per page load once URL → globals is done.
 */
function seedGalleryNavStateFromUrl() {
  if (seedGalleryNavStateFromUrl._done) return;
  seedGalleryNavStateFromUrl._done = true;
  navUrlParsed = true;
  try {
    var wallet = parseWalletFromUrl();
    var piece = parsePieceFromUrl();
    var view = wallet ? "collector" : piece ? "detail" : "browse";
    var st = Object.assign(currentNavSnapshot(view), {
      wallet: wallet ? wallet.toLowerCase() : null,
      piece: piece || null,
      collection: activeCollection || "all",
      q: searchQuery || "",
      filter: activeFilter || "all",
      sort: sortKey || "token_desc",
    });
    // replaceState only — never strip params that are already in the address bar
    history.replaceState(st, "", urlFromNavState(st));
  } catch (e) {
    console.warn("seedGalleryNavStateFromUrl failed", e);
  }
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

function syncWalletShareUrl(address, opts) {
  opts = opts || {};
  if (!address || !/^0x[a-fA-F0-9]{40}$/i.test(address)) return;
  if (bindCollectorHubNav._bound) bindCollectorHubNav._suppressHash = true;
  if (opts.push) {
    pushNavState("collector", { wallet: address.toLowerCase(), piece: null });
  } else {
    replaceNavState("collector", { wallet: address.toLowerCase(), piece: null });
  }
  if (bindCollectorHubNav._bound) bindCollectorHubNav._suppressHash = false;
}

function clearWalletShareUrl() {
  // Drop wallet from URL; keep browse filters on the current history entry
  replaceNavState("browse", { wallet: null, piece: null });
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
  // Never wipe browse filters here — see captureBrowseFilterState CONTRACT above.
  if (opts.preserveFilters) {
    applyBrowseFilterState(opts.preserveFilters);
  }
  enrichCollectorRowNames(entry);
  var idLabel = resolveCollectorIdentity(entry);
  var label = idLabel.display;
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
  // Keep filter chips / inputs visible & correct in portfolio browse strip
  applyBrowseControlsFromState();
  refreshView();
  // When portfolio opens under "All collections", expand holdings from loaded data.
  // If a collection (or other) filter is active, do NOT force multi-collection expand —
  // user came from a scoped archive search and expects that scope to stick until they
  // clear the chip (onBrowseFilterChipCleared / clearCollectorFilters).
  if (!activeCollection || activeCollection === "all") {
    expandCollectorHoldingsFromLoadedData();
    renderCollectorFocusUi();
    applyBrowseControlsFromState();
    refreshView();
  }
  // Fill ranks for collections not in current filter (async catalogs / wallet index)
  refreshCollectorRankBadgesAsync();
  // History entry must embed the same filters so Back/Forward restores them
  var filterSnap = captureBrowseFilterState();
  var navExtra = {
    wallet: addr,
    piece: null,
    collection: filterSnap.collection,
    q: filterSnap.q,
    filter: filterSnap.filter,
    sort: filterSnap.sort,
  };
  if (!opts.noPush) {
    var cur = history.state;
    if (
      cur &&
      cur.kind === NAV_KIND &&
      cur.view === "collector" &&
      cur.wallet === addr &&
      !cur.piece
    ) {
      replaceNavState("collector", navExtra);
    } else {
      pushNavState("collector", navExtra);
    }
  } else {
    replaceNavState("collector", navExtra);
  }
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

/**
 * Load multi-collection catalog for portfolio so every NFT in the wallet can show.
 * Same data path as Clear filters; resetFilters wipes search/listed/sort chips.
 */
async function reloadPortfolioBrowseData(opts) {
  opts = opts || {};
  if (!galleryCollectorView) return;
  var colSel = $("#collection-select");
  if (opts.resetFilters) {
    activeFilter = "all";
    searchQuery = "";
    sortKey = "token_desc";
    var search = $("#search");
    var sort = $("#sort-select");
    if (search) search.value = "";
    if (sort) sort.value = "token_desc";
    document.querySelectorAll(".filter").forEach(function (btn) {
      var on = btn.dataset.filter === "all";
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }
  // Expand scope to all collections so holdings outside a single collection reappear
  activeCollection = "all";
  if (colSel) colSel.value = "all";
  applyBrowseControlsFromState();

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

  var loadEl = $("#load-state");
  if (loadEl) loadEl.hidden = false;
  try {
    await loadAllCollectionsForPortfolio();
    afterAllDataReady();
    if (dataSource === "catalog") refreshFullDataInBackground();
    try {
      await loadWalletIndex();
      expandCollectorHoldingsFromLoadedData();
      renderCollectorFocusUi();
      refreshView();
    } catch (e) {}
  } catch (err) {
    console.error("reloadPortfolioBrowseData failed", err);
    afterAllDataReady();
  } finally {
    if (loadEl) loadEl.hidden = true;
  }
}

/**
 * After removing one filter chip: refresh like Clear filters when needed,
 * but keep any remaining chips (search + collection + listed, etc.).
 */
function onBrowseFilterChipCleared(clearedKey) {
  if (galleryCollectorView) {
    if (clearedKey === "collection") {
      // Leaving a single-collection scope → load all collections so wallet shows every NFT
      // while keeping search / listed / sort chips.
      reloadPortfolioBrowseData({ resetFilters: false });
      return;
    }
    // search / listed / sort only: re-expand holdings then re-apply remaining filters
    expandCollectorHoldingsFromLoadedData();
    renderCollectorFocusUi();
    refreshView();
    syncBrowseParamsToUrl();
    return;
  }
  // Archive (non-collector)
  if (clearedKey === "collection") {
    loadCollectionScope("all");
    return;
  }
  refreshView();
  syncBrowseParamsToUrl();
}

/** Reset all search/filter/sort inside collector view; reload all collections so full wallet shows. */
function clearCollectorFilters() {
  if (!galleryCollectorView) return;
  reloadPortfolioBrowseData({ resetFilters: true });
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
  // Prefer browser history when we pushed a collector/detail step this session
  // (collection search → wallet → NFT → Back steps correctly; won't leave the site).
  if (
    !opts.fromPopstate &&
    !opts.forceExit &&
    canHistoryBackInApp() &&
    (history.state.view === "collector" || history.state.view === "detail")
  ) {
    try {
      history.back();
      return;
    } catch (e) {}
  }
  var keepLookup = opts.keepLookup === true;
  closeDetail({ fromPopstate: true });
  clearGalleryCollectorView({ clearResult: keepLookup ? false : true });
  if (!keepLookup) {
    resetWalletLookupHub();
  } else if (opts.clearInput) {
    var input = $("#wallet-input");
    if (input) input.value = "";
  }
  if (!opts.fromPopstate) {
    replaceNavState("browse", { wallet: null, piece: null });
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
      : "name, rarity, #21, ENS…";
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
              short: collectionRankShortName(
                activeCollection && activeCollection !== "all"
                  ? activeCollection
                  : "dacommunity"
              ),
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
  // Snapshot filters BEFORE any UI side effects (NFT → wallet must keep them).
  // See captureBrowseFilterState CONTRACT — do not clear filters on this path.
  var preservedFilters = captureBrowseFilterState();
  // Keep detail history entry so browser Back can return to the NFT
  closeDetail({ fromPopstate: true });
  closeCollectorsModal();
  var input = $("#wallet-input");
  if (input) input.value = meta.lookupValue || meta.address;
  // Rank + holdings from current loaded collection (badges / BIG KIX / all)
  rebuildCollectorsForCurrentView();
  var synthHoldings = buildHoldingsFromCurrentItems(key);
  if (synthHoldings.length > 0) {
    // Identity only via resolveCollectorIdentity (ENS → Base → OpenSea → 0x)
    var id = resolveCollectorIdentity(key);
    var synthStats = summarizeHoldingsStats(synthHoldings);
    var entry = {
      address: key,
      holdings: synthHoldings,
      unique_pieces: synthStats.unique_pieces,
      collection_quantity: synthStats.collection_quantity,
      ens_name: id.ens_name,
      base_name: id.base_name,
      username: id.username,
    };
    // Pushes history: archive/collection search → wallet (Back restores prior step)
    renderWalletSuccess(entry, {
      scrollBehavior: "smooth",
      noPush: false,
      preserveFilters: preservedFilters,
    });
    reaffirmBrowseFilters(preservedFilters);
    return;
  }
  var entry = walletIndex && walletIndex.by_address && walletIndex.by_address[key];
  if (entry) {
    renderWalletSuccess(entry, {
      scrollBehavior: "smooth",
      noPush: false,
      preserveFilters: preservedFilters,
    });
    reaffirmBrowseFilters(preservedFilters);
    return;
  }
  runWalletLookupFromAddress(address, meta.lookupValue, {
    preserveFilters: preservedFilters,
  });
}

/**
 * Canonical shareable collector portfolio link (absolute).
 * Always includes ?wallet=…#wallet-panel so openers land in collector theater.
 *
 * Filters (collection / search / listed / sort) are included by default so someone
 * can share “just my Badges” or a search-scoped slice of a wallet. Pass
 * { includeFilters: false } only when you explicitly want the full portfolio link.
 *
 * Examples:
 *   …/dacommunity/?wallet=0x…#wallet-panel
 *   …/dacommunity/?collection=badges&wallet=0x…#wallet-panel
 *   …/dacommunity/?collection=bigkix&q=kix&wallet=0x…#wallet-panel
 */
function walletShareUrl(address, opts) {
  opts = opts || {};
  if (!address) return dacommunityBaseUrl().toString();
  var url = dacommunityBaseUrl();
  url.search = "";
  var includeFilters = opts.includeFilters !== false;
  if (includeFilters) {
    var snap =
      opts.filters ||
      captureBrowseFilterState() ||
      {
        collection: activeCollection || "all",
        q: searchQuery || "",
        filter: activeFilter || "all",
        sort: sortKey || "token_desc",
      };
    if (snap.collection && snap.collection !== "all") {
      url.searchParams.set("collection", snap.collection);
    }
    if (snap.q) url.searchParams.set("q", snap.q);
    if (snap.filter && snap.filter !== "all") {
      url.searchParams.set("filter", snap.filter);
    }
    if (snap.sort && snap.sort !== "token_desc") {
      url.searchParams.set("sort", snap.sort);
    }
  }
  url.searchParams.set("wallet", String(address).toLowerCase());
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
      // Keep NAV_KIND state; force #wallet-panel for the lookup hub scroll target
      try {
        var st = Object.assign(
          currentNavSnapshot(galleryCollectorView ? "collector" : "browse"),
          galleryCollectorView
            ? { wallet: galleryCollectorView.address, piece: null }
            : { wallet: null, piece: null }
        );
        var href = urlFromNavState(st);
        if (href.indexOf("#") < 0) href += "#wallet-panel";
        history.replaceState(st, "", href);
      } catch (e) {}
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

function runWalletLookupFromAddress(address, lookupValue, opts) {
  opts = opts || {};
  var input = $("#wallet-input");
  if (!input) return;
  var meta = addressDisplayMeta(address);
  input.value = lookupValue || meta.lookupValue || meta.address;
  // Keep prior detail/browse history entry so Back can return to it
  closeDetail({ fromPopstate: true });
  closeCollectorsModal();
  // Always pass the canonical 0x address (from data-address in pills etc) to lookup
  // so synth path works directly without relying on ENS resolve (which can hang on external service).
  // The input keeps the nice ENS name for display.
  renderWalletLookup(address, {
    updateUrl: true,
    scrollBehavior: "smooth",
    preserveFilters: opts.preserveFilters || captureBrowseFilterState(),
  });
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
  // Shared wallet links open full portfolio theater (not archive trait search).
  // Deep-link: replace current history entry (don't add a dead Back step off-site).
  await renderWalletLookup(q, {
    updateUrl: false,
    noPush: true,
    scrollBehavior: "instant",
    // Keep collection/q from URL if present; otherwise captureBrowseFilterState is fine
    preserveFilters: captureBrowseFilterState(),
  });
  // Ensure address bar still has ?wallet= after open (defense against any replace wipe)
  try {
    replaceNavState("collector", {
      wallet: /^0x[a-fA-F0-9]{40}$/i.test(q) ? q.toLowerCase() : (galleryCollectorView && galleryCollectorView.address) || q.toLowerCase(),
      piece: null,
    });
  } catch (e) {}
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
  if (colId === "hats-n-dacats") return "HATS";
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
    } else if (cid === "bigkix") {
      collectionRankingCache[cid] = buildCollectorsFromLoadedItems(byCol[cid], {
        rankByCopies: true,
      });
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
      // Secondary: badges / bigkix / agency / hats / future
      var catFile =
        (col.data && col.data.catalog) ||
        (col.id === "badges" ? "badges_catalog.json" : null) ||
        (col.id === "bigkix" ? "bigkix_catalog.json" : null) ||
        (col.id === "dagato-agency" ? "dagato_agency_catalog.json" : null) ||
        (col.id === "hats-n-dacats" ? "hats_n_dacats_catalog.json" : null);
      if (!catFile) continue;
      var data = await fetchJson(prefix + "data/" + catFile + q, 20000);
      if (!data || !data.items || !data.items.length) continue;
      data.items.forEach(function (it) {
        if (!it.collection_id) it.collection_id = col.id;
      });
      if (col.id === "badges") {
        collectionRankingCache[col.id] = buildCollectorsFromBadgeItems(data.items);
      } else if (col.id === "bigkix") {
        collectionRankingCache[col.id] = buildCollectorsFromLoadedItems(data.items, {
          rankByCopies: true,
        });
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
    var wantCol = normalizeCollectionId(colId);
    items = items.filter(function (i) {
      return normalizeCollectionId(i.collection_id || "dacommunity") === wantCol;
    });
  }
  if (colId === "badges") return buildCollectorsFromBadgeItems(items);
  if (colId === "bigkix") {
    return buildCollectorsFromLoadedItems(items, { rankByCopies: true });
  }
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
  if (colId === "hats-n-dacats") return "rank-badge-hats-n-dacats";
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
        else if (r.id === "hats-n-dacats") short = "HAT";
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
    } else if (activeCollection === "hats-n-dacats") {
      labelEl.textContent = "Heavy collectors in HATS n' daCATs";
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
      enrichCollectorRowNames(c);
      var id = resolveCollectorIdentity(c);
      var label = id.display;
      var lookup = id.lookupValue;
      return (
        '<button type="button" class="top-collector-pill" data-address="' +
        escapeHtml(c.address) +
        '" data-lookup="' +
        escapeHtml(lookup) +
        '" title="' +
        escapeHtml(label + " · " + formatCollectorHoldLabel(c)) +
        '">' +
        escapeHtml(label) +
        '<span class="meta">' +
        escapeHtml(formatCollectorHoldMeta(c)) +
        "</span></button>"
      );
    })
    .join("");
  track.querySelectorAll(".top-collector-pill").forEach(function (btn) {
    btn.addEventListener("click", function () {
      runWalletLookupFromAddress(btn.getAttribute("data-address"), btn.getAttribute("data-lookup"));
    });
  });
  // Secondary collections: holders often missing from wallet_index — reverse-resolve live
  if (!renderTopCollectors._fromIdentityRefresh) {
    ensureNamesForAddresses(
      top.map(function (c) {
        return c.address;
      })
    );
  }
}

function createHoldingCard(item, holding) {
  var btn = document.createElement("button");
  btn.className = "holding-card";
  btn.type = "button";
  var title = item ? itemTitle(item) : holding.display_name || holding.name || "#" + holding.token_id;
  var listedBadge =
    item && isItemListed(item)
      ? '<span class="badge-listed">' +
        (item.listing && item.listing.amount_eth != null
          ? formatEth(item.listing.amount_eth) + " ETH"
          : "Listed") +
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
      !isBadgeMultiSeriesRep(item) &&
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
  // Prefer the in-page share sheet when present (gallery)
  if ($("#share-modal")) {
    showShareModal(url, {
      shareText: title || "Check this out on daCommunity Gallery",
      toast: "Link copied",
    });
    return;
  }
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
      '<button type="button" class="social-close" aria-label="Close">×</button>' +
      '<button type="button" class="share-copy-btn social-btn copy" data-type="copy">Copy link</button>' +
      '<p class="share-socials-label">Or share via</p>' +
      '<div class="share-socials social-buttons">' +
        '<a class="share-social-btn social-btn" data-type="x" target="_blank" rel="noopener">X</a>' +
        '<a class="share-social-btn social-btn" data-type="tg" target="_blank" rel="noopener">Telegram</a>' +
        '<a class="share-social-btn social-btn" data-type="fb" target="_blank" rel="noopener">Facebook</a>' +
        '<button type="button" class="share-social-btn social-btn" data-type="ig">Instagram</button>' +
      "</div>" +
    "</div>";

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

  var ig = modal.querySelector('[data-type="ig"]');
  if (ig) {
    ig.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          if (typeof showCopyToast === "function") {
            showCopyToast("Link copied — paste into Instagram");
          }
          close();
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

  var copyBtn = modal.querySelector('[data-type="copy"]');
  copyBtn.addEventListener("click", function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        copyBtn.textContent = "Copied!";
        copyBtn.classList.add("is-copied");
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
  // Wallet deep-link + current portfolio filters (collection / search / listed / sort).
  // Recipients open collector theater scoped the same way (e.g. Badges-only share).
  showShareModal(walletShareUrl(address, { includeFilters: true }));
}

/* === Share Modal (Part 1) — copyable URL with current collection + filters + social quick-links.
 * Mobile bottom-sheet via CSS; desktop centered. Reuses existing toast / URL helpers.
 */
function buildCurrentViewUrl() {
  // Collector portfolio → wallet deep-link + active filters (stable for Telegram / external apps)
  if (galleryCollectorView && galleryCollectorView.address) {
    return walletShareUrl(galleryCollectorView.address, { includeFilters: true });
  }
  var urlWallet = parseWalletFromUrl();
  if (urlWallet && !galleryCollectorView) {
    // Deep-link still resolving — prefer wallet URL (+ filters from bar) over bare archive
    return walletShareUrl(urlWallet, { includeFilters: true });
  }
  syncBrowseParamsToUrl();
  return window.location.href;
}

/**
 * Minimal share sheet: Copy link + platform rows. No explainer copy, no URL field.
 * @param {string} [forcedUrl]
 * @param {{ shareText?: string, toast?: string }} [opts]
 */
function showShareModal(forcedUrl, opts) {
  opts = opts || {};
  var modal = $("#share-modal");
  if (!modal) return;
  var url = forcedUrl || buildCurrentViewUrl();
  showShareModal._lastUrl = url;
  showShareModal._shareText =
    opts.shareText ||
    (url.indexOf("piece=") >= 0
      ? "Check out this daCAT NFT"
      : url.indexOf("wallet=") >= 0
        ? "Check out these daCATs"
        : "daCAT archive view");
  showShareModal._toast = opts.toast || "Link copied";

  var copyBtn = $("#share-copy-btn");
  if (copyBtn) {
    copyBtn.textContent = "Copy link";
    copyBtn.classList.remove("is-copied");
    copyBtn.onclick = function () {
      function afterCopy() {
        copyBtn.textContent = "Copied!";
        copyBtn.classList.add("is-copied");
        showCopyToast(showShareModal._toast || "Link copied");
        window.setTimeout(function () {
          closeShareModal();
        }, 650);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(afterCopy).catch(function () {
          showCopyToast("Copy: " + url);
          closeShareModal();
        });
      } else {
        try {
          var ta = document.createElement("textarea");
          ta.value = url;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          afterCopy();
        } catch (e) {
          showCopyToast("Copy: " + url);
          closeShareModal();
        }
      }
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
  if (copyBtn && window.matchMedia && window.matchMedia("(min-width: 700px)").matches) {
    window.setTimeout(function () {
      try {
        copyBtn.focus();
      } catch (e) {}
    }, 30);
  }
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
  var text = encodeURIComponent(
    showShareModal._shareText || "Check this out on daCommunity Gallery"
  );
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
    showCopyToast("Link copied. Paste into Instagram story or post");
    closeShareModal();
    return;
  }
  if (href) {
    window.open(href, "_blank", "noopener");
  }
  closeShareModal();
}

/** Share one NFT (detail drawer) — deep link to ?piece= with collection context. */
function shareDetailPiece(item) {
  if (!item) {
    // Fallback: open piece from current detail id
    item =
      (activeDetailTokenId && itemsById.get(activeDetailTokenId)) ||
      findItemBySlug(activeDetailTokenId) ||
      null;
  }
  if (!item) return;
  var title = itemTitle(item) || "daCAT NFT";
  showShareModal(pieceShareUrl(item), {
    title: "Share this NFT",
    lead: "Anyone with the link opens “" + title + "” in the gallery.",
    shareText: "Check out this daCAT: " + title,
    toast: "NFT link copied",
  });
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
  enrichCollectorRowNames(entry);
  var id = resolveCollectorIdentity(entry);
  var label = id.display;
  entry.ens_name = id.ens_name;
  entry.base_name = id.base_name;
  entry.username = id.username;
  // Secondary-only holders: reverse-resolve if still short 0x
  if (entry.address && identityNeedsReverseLookup(entry.address)) {
    ensureNamesForAddresses([entry.address]);
  }
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
  // Secondary line: show other known handles under the primary display name
  var secondaryBits = [];
  if (id.ens_name && id.ens_name !== label) secondaryBits.push(id.ens_name);
  if (id.base_name && id.base_name !== label) secondaryBits.push(id.base_name);
  if (id.username && id.username !== label) secondaryBits.push(id.username);
  var secondaryHtml = secondaryBits.length
    ? '<p class="collector-profile-ens">' +
      escapeHtml(secondaryBits.join(" · ")) +
      "</p>"
    : "";

  resultEl.hidden = false;
  resultEl.innerHTML =
    '<div class="collector-profile-card collector-profile-card--theater">' +
    '<div class="collector-profile-main">' +
    '<p class="collector-profile-eyebrow">Collector</p>' +
    '<p class="collector-profile-name">' +
    escapeHtml(label) +
    "</p>" +
    secondaryHtml +
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
  setGalleryCollectorView(entry, {
    scrollBehavior: opts && opts.scrollBehavior,
    noPush: !!(opts && opts.noPush),
    preserveFilters: opts && opts.preserveFilters,
  });
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

/**
 * Map ENS / Base / OpenSea username (or alias) → 0x address from local indexes.
 * Exact case-insensitive match only (avoids ambiguous prefix hits).
 */
function resolveCollectorNameToAddress(name) {
  var raw = (name || "").trim();
  if (!raw) return null;
  var key = raw.toLowerCase();

  function aliasHit(map) {
    if (!map) return null;
    if (map[key]) return String(map[key]).toLowerCase();
    if (map[raw]) return String(map[raw]).toLowerCase();
    var found = null;
    Object.keys(map).some(function (n) {
      if (String(n).toLowerCase() === key) {
        found = String(map[n]).toLowerCase();
        return true;
      }
      return false;
    });
    return found;
  }

  var fromAlias =
    aliasHit(walletIndex && walletIndex.ens_aliases) ||
    aliasHit(nameIndex && nameIndex.name_aliases);
  if (fromAlias && isEthAddress(fromAlias)) return fromAlias;

  var matches = [];
  function consider(addr, ens, base, user) {
    var a = String(addr || "")
      .toLowerCase()
      .trim();
    if (!a || !isEthAddress(a)) return;
    var fields = [ens, base, user];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f && String(f).toLowerCase() === key) {
        if (matches.indexOf(a) < 0) matches.push(a);
        return;
      }
    }
  }

  if (walletIndex && walletIndex.by_address) {
    Object.keys(walletIndex.by_address).forEach(function (a) {
      var e = walletIndex.by_address[a] || {};
      consider(e.address || a, e.ens_name, e.base_name, e.username);
    });
  }
  if (nameIndex && nameIndex.by_address) {
    Object.keys(nameIndex.by_address).forEach(function (a) {
      var e = nameIndex.by_address[a] || {};
      consider(e.address || a, e.ens_name, e.base_name, e.username);
    });
  }
  (collectorsList || []).forEach(function (c) {
    if (!c) return;
    consider(c.address, c.ens_name, c.base_name, c.username);
  });

  if (matches.length === 1) return matches[0];
  // Multiple addresses claim the same name (usually title-poisoned ENS). Never guess:
  // for .eth / Base names, only ens_aliases is authoritative; else live-resolve.
  if (matches.length > 1) {
    if (key.endsWith(".eth") || key.endsWith(".base.eth")) {
      return fromAlias && isEthAddress(fromAlias) ? fromAlias : null;
    }
    for (var mi = 0; mi < matches.length; mi++) {
      if (walletIndex && walletIndex.by_address && walletIndex.by_address[matches[mi]]) {
        return matches[mi];
      }
    }
    return matches[0];
  }
  return null;
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
      // Multi-1:1 series_rep is browse-only; edition_club series_rep is the real card
      if (item.is_series_rep && item.source_created_collection && /trillion|billion/i.test(item.source_created_collection) && !item.edition_club) return;
      if (isAgencyRaritySeries(item)) return;
      seen[key] = true;
      // volume + contract required for agency getItemKey
      holdings.push({
        token_id: item.token_id,
        name: item.display_name || item.name,
        display_name: item.display_name || item.name,
        image_url: item.image_url,
        opensea_url: item.opensea_url,
        source_created_collection: item.source_created_collection,
        collection_id: item.collection_id,
        contract: item.contract || null,
        volume: item.volume != null ? item.volume : null,
        volume_label: item.volume_label || null,
        rarity: item.rarity,
        is_edition_token: !!item.is_edition_token,
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
      error: "Paste an ENS, Base name, OpenSea username, or 0x address.",
      title: "Need an address",
    };
  }

  // Resolve name → 0x early so synth always gets an address (fails on bare ENS/OS strings)
  var address = raw.toLowerCase();
  var needsResolve = false;
  if (isEnsName(raw)) {
    var rawL = raw.toLowerCase();
    var alias =
      (walletIndex && walletIndex.ens_aliases && walletIndex.ens_aliases[rawL]) ||
      (nameIndex && nameIndex.name_aliases && nameIndex.name_aliases[rawL]) ||
      resolveCollectorNameToAddress(raw);
    if (alias) {
      address = alias.toLowerCase();
    } else {
      needsResolve = true;
    }
  } else if (isEthAddress(raw)) {
    address = raw.toLowerCase();
  } else {
    // OpenSea username or other local display name (e.g. MalteExe)
    var named = resolveCollectorNameToAddress(raw);
    if (named) {
      address = named;
    } else {
      return {
        error:
          "That name isn't in the archive snapshot. Try the full 0x address, or an ENS / Base / OpenSea name we index.",
        title: "Name not found",
        hint: "Example: MalteExe, mozvane.eth, or 0xabc…1234",
      };
    }
  }

  // Try synthetic holdings from whatever is currently loaded in galleryData (badges items have owners lists).
  // This works even if walletIndex is not loaded for this view. Always use resolved 0x here.
  var synth = buildHoldingsFromCurrentItems(address);
  if (synth.length > 0) {
    // Merge any owner-row stamps (badge reverse ENS) into identity resolve
    var seed = { address: address };
    (galleryData && galleryData.items || []).forEach(function (item) {
      var list = (item.owners || {}).holders || (item.owners || {}).top_holders || [];
      list.forEach(function (o) {
        if ((o.address || "").toLowerCase() !== address) return;
        if (o.ens_name && !seed.ens_name) seed.ens_name = o.ens_name;
        if (o.base_name && !seed.base_name) seed.base_name = o.base_name;
        if (o.username && !seed.username) seed.username = o.username;
      });
    });
    var id = resolveCollectorIdentity(seed);
    var synthStats = summarizeHoldingsStats(synth);
    return {
      entry: {
        address: address,
        holdings: synth,
        unique_pieces: synthStats.unique_pieces,
        collection_quantity: synthStats.collection_quantity,
        ens_name: id.ens_name,
        base_name: id.base_name,
        username: id.username,
      },
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
    activeCollection === "dagato-agency" ||
    activeCollection === "hats-n-dacats"
  ) {
    if (activeCollection === "badges") {
      collectorsList = buildCollectorsFromBadgeItems(galleryData ? galleryData.items : []);
    } else if (activeCollection === "bigkix") {
      collectorsList = buildCollectorsFromLoadedItems(galleryData ? galleryData.items : [], {
        rankByCopies: true,
      });
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
  // History: setGalleryCollectorView pushes (or replaces when noPush / deep-link).
  // Preserve archive filters unless this is a clean deep-link with no prior filters.
  var preserved =
    opts.preserveFilters ||
    (opts.resetFilters ? null : captureBrowseFilterState());
  renderWalletSuccess(entry, {
    scrollBehavior: opts.scrollBehavior,
    noPush: opts.noPush || opts.updateUrl === false,
    preserveFilters: preserved,
  });
  if (preserved) reaffirmBrowseFilters(preserved);
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
  enrichCollectorsListNames();
  if (!collectorsList.length) {
    list.innerHTML = "<p class='wallet-result empty'>No collectors indexed yet.</p>";
    return;
  }
  var q = (filter || "").trim().toLowerCase();
  var rows = collectorsList;
  if (q) {
    rows = rows.filter(function (c) {
      return collectorMatchesQuery(c, q);
    });
  }
  list.innerHTML = rows
    .map(function (c) {
      enrichCollectorRowNames(c);
      var id = resolveCollectorIdentity(c);
      var label = id.display;
      var sub = id.lookupValue;
      var lookup = id.lookupValue;
      return (
        '<button type="button" class="collector-row" data-address="' +
        escapeHtml(c.address) +
        '" data-lookup="' +
        escapeHtml(lookup) +
        '">' +
        '<div class="collector-info"><strong>' +
        escapeHtml(label) +
        '</strong><span class="meta">' +
        escapeHtml(sub) +
        "</span></div>" +
        '<span class="count">' +
        escapeHtml(formatCollectorHoldLabel(c)) +
        "</span></button>"
      );
    })
    .join("");
  list.querySelectorAll(".collector-row").forEach(function (btn) {
    btn.addEventListener("click", function () {
      closeCollectorsModal();
      runWalletLookupFromAddress(
        btn.dataset.address,
        btn.getAttribute("data-lookup") || btn.dataset.address
      );
    });
  });
  ensureNamesForAddresses(
    rows.map(function (c) {
      return c.address;
    })
  );
}

function fillMediaSlot(slot, item, opts) {
  opts = opts || {};
  slot.innerHTML = "";
  var src = imgSrc(item);
  var seriesGeneric = isBadgeMultiSeriesRep(item);
  // Prefer opensea video source for video items (e.g. gem nova green in generic search/detail)
  // or personalized art in portfolio for real editions. Never for multi-1:1 series cards.
  if (
    !seriesGeneric &&
    item &&
    item.opensea_image_url &&
    /^https?:/i.test(item.opensea_image_url) &&
    /\.(mp4|mov|webm)/i.test(item.opensea_image_url)
  ) {
    if (isVideoItem(item) || galleryCollectorView || (opts && (opts.autoplay || opts.controls))) {
      src = resolveMediaUrl(item.opensea_image_url);
    }
  } else if (
    !seriesGeneric &&
    galleryCollectorView &&
    item &&
    item.opensea_image_url &&
    /^https?:/i.test(item.opensea_image_url)
  ) {
    // Wallet view: show personalized 1:1 art for that holder's copy
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
    // Error fallback to personal OpenSea art only for real editions — not series cards
    if (
      !seriesGeneric &&
      item.opensea_image_url &&
      resolveMediaUrl(item.image_url) !== resolveMediaUrl(item.opensea_image_url)
    ) {
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
      "Detective Agency case files on Ethereum (Volumes 1–2). Stewarded by " +
      '<strong class="steward-name">dagato.eth</strong>. All holders counted — five rarity tiers per volume in browse; real case-file #s in wallets.';
  } else if (collId === "hats-n-dacats") {
    html =
      "Legendary hats on Ethereum — true 1:1s, no rarity tiers (max 333). Released in waves. Stewarded by " +
      '<strong class="steward-name">hatsndacats.eth</strong>. Project mint wallet hidden from collectors until a piece is bought or transferred out.';
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
      if (isItemListed(it)) {
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
    activeCollection === "dagato-agency" ||
    activeCollection === "hats-n-dacats"
  ) {
    var kItems = (galleryData && galleryData.items) || [];
    // Prefer live list so stats match the grid + collectors modal
    rebuildCollectorsForCurrentView();
    // Agency browse grid = 5 rarity series per volume (not raw case files)
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
      if (isItemListed(it)) {
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

/** True when an NFT has an active sale listing (for sale filter + badge). */
function isItemListed(item) {
  if (!item) return false;
  if (item.listed === true || item.listed === 1 || item.listed === "true") return true;
  var L = item.listing;
  if (!L || typeof L !== "object") return false;
  if (L.amount_eth != null && !isNaN(Number(L.amount_eth))) return true;
  if (L.price_eth != null && !isNaN(Number(L.price_eth))) return true;
  if (String(L.status || "").toUpperCase() === "ACTIVE") return true;
  return false;
}

/** Sort activity newest-first; prefer sale over transfer over mint at the same timestamp. */
function sortActivityRows(rows) {
  var rank = { sale: 0, transfer: 1, mint: 2 };
  return (rows || []).slice().sort(function (a, b) {
    var ca = String((b && b.at) || "").localeCompare(String((a && a.at) || ""));
    if (ca !== 0) return ca;
    var ra = rank[(a && a.type) || ""] != null ? rank[a.type] : 9;
    var rb = rank[(b && b.type) || ""] != null ? rank[b.type] : 9;
    return ra - rb;
  });
}

/**
 * Latest sale/transfer timestamp (real movement). Mints alone do not count as a
 * "recent transfer" — that made listed inventory look transferred when it was not.
 */
function itemLatestMovementAt(item) {
  if (!item) return null;
  var rows = sortActivityRows(dedupeActivityRows(item.recent_activity || []));
  for (var i = 0; i < rows.length; i++) {
    var t = (rows[i] && rows[i].type) || "";
    if ((t === "sale" || t === "transfer") && rows[i].at) return rows[i].at;
  }
  var lc = item.owners && item.owners.latest_change;
  if (lc && lc.at && (lc.type === "sale" || lc.type === "transfer")) return lc.at;
  return null;
}

/**
 * Latest activity timestamp including mint (detail “latest change” fallback).
 * Not used for Newest sort — that uses itemMintTimeMs (first mint / release).
 */
function itemLatestTransferAt(item) {
  var move = itemLatestMovementAt(item);
  if (move) return move;
  var owners = item.owners || {};
  if (owners.latest_change && owners.latest_change.at) return owners.latest_change.at;
  var rows = sortActivityRows(dedupeActivityRows(item.recent_activity || []));
  if (rows.length && rows[0].at) return rows[0].at;
  return null;
}

function hasRecentActivity(item, withinDays) {
  withinDays = withinDays || 90;
  // Prefer sale/transfer so "Recent Transfers" matches purchases & sends
  var at = itemLatestMovementAt(item);
  if (!at) {
    // Brand-new mints still surface briefly (new wave drops)
    var rows = sortActivityRows(dedupeActivityRows((item && item.recent_activity) || []));
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].type === "mint" && rows[i].at) {
        at = rows[i].at;
        withinDays = Math.min(withinDays, 21);
        break;
      }
    }
  }
  if (!at) return false;
  var ageH = hoursSince(at);
  return ageH !== null && ageH <= withinDays * 24;
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Text match helper.
 * mode: "substr" | "word-prefix" (token must start a word) | "word" (whole word)
 */
function textHasSearchToken(text, token, mode) {
  if (text == null || text === "" || !token) return false;
  var s = String(text).toLowerCase();
  var t = String(token).toLowerCase();
  if (mode === "substr") return s.indexOf(t) >= 0;
  try {
    var boundary = "(^|[^a-z0-9_])";
    var re =
      mode === "word"
        ? new RegExp(boundary + escapeRegExp(t) + "([^a-z0-9_]|$)", "i")
        : new RegExp(boundary + escapeRegExp(t), "i"); // word-prefix
    return re.test(s);
  } catch (e) {
    return s.indexOf(t) >= 0;
  }
}

/** Pure digits / #N → match token ids and #padded numbers in titles only (not prose/hex). */
function itemMatchesNumericSearchToken(item, rawToken) {
  var token = String(rawToken || "").replace(/^#/, "");
  if (!/^\d+$/.test(token)) return false;

  var tid = item.token_id != null ? String(item.token_id) : "";
  var tidCore = tid.replace(/^rank-/i, "");
  // Exact token id (agency rank-3, badge #0, etc.)
  if (tid === token || tidCore === token) return true;
  if (/^\d+$/.test(tidCore)) {
    // "024" vs "24" — same numeric id
    try {
      if (String(Number(tidCore)) === String(Number(token))) return true;
    } catch (e) {}
  }

  // Single digit is too noisy against titles ("Vol 1", "1:1", "Season 1")
  // Only accept exact token_id matches above.
  if (token.length < 2) return false;

  var titles = [
    itemTitle(item),
    item.name,
    item.display_name,
    item.opensea_name,
    item.local_slug,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  // Digit-bounded match so "21" hits "#021" / "big-kix-021" but not random hex prose
  var n = String(Number(token));
  var patterns = [token];
  if (n !== token) patterns.push(n);
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i];
    var re = new RegExp("(?:^|[^0-9])#?0*" + escapeRegExp(p) + "(?:[^0-9]|$)", "i");
    if (re.test(titles)) return true;
  }
  return false;
}

/** Holder 0x match only when the user clearly typed an address fragment. */
function itemHasHolderAddressPrefix(item, token) {
  var t = String(token || "").toLowerCase();
  if (t.indexOf("0x") !== 0 || t.length < 8) return false;
  var holders = (item.owners && item.owners.holders) || [];
  for (var i = 0; i < holders.length; i++) {
    var addr = String((holders[i] && holders[i].address) || "").toLowerCase();
    if (addr && addr.indexOf(t) === 0) return true;
  }
  return false;
}

/** Collect human holder names (ENS / Base / OpenSea) — never raw 0x. */
function itemHolderSearchNames(item) {
  var names = [];
  var holders = (item.owners && item.owners.holders) || [];
  for (var i = 0; i < holders.length; i++) {
    var h = holders[i] || {};
    if (h.ens_name) names.push(h.ens_name);
    if (h.base_name) names.push(h.base_name);
    if (h.username) names.push(h.username);
    var addr = h.address || "";
    if (addr && walletIndex && walletIndex.by_address) {
      var entry = walletIndex.by_address[String(addr).toLowerCase()];
      if (entry) {
        if (entry.ens_name) names.push(entry.ens_name);
        if (entry.base_name) names.push(entry.base_name);
        if (entry.username) names.push(entry.username);
      }
    }
    var ni = nameIndexEntry(addr);
    if (ni) {
      if (ni.ens_name) names.push(ni.ens_name);
      if (ni.base_name) names.push(ni.base_name);
      if (ni.username) names.push(ni.username);
    }
  }
  return names;
}

/**
 * NFT free-text search — tuned for people, not substring accidents.
 *
 * Matches: titles, slugs, collection/rarity labels, holder names, meaningful traits.
 * Avoids: every 0x hex digit, "copy/copies" in stats excerpts, single-digit noise,
 *         giant trait ids, always-on steward label matching everything.
 * Wallet addresses only when the query itself looks like 0x…
 */
function itemMatchesSearch(item, q) {
  if (!q) return true;
  q = String(q).toLowerCase().trim();
  if (!q) return true;

  // Multi-token: every word must match (order-independent)
  var tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;

  for (var t = 0; t < tokens.length; t++) {
    if (!itemMatchesSearchToken(item, tokens[t])) return false;
  }
  return true;
}

function itemMatchesSearchToken(item, token) {
  if (!token) return true;

  // Explicit address lookup (wallet bar is better; still support intentional 0x search)
  if (token.indexOf("0x") === 0) {
    return itemHasHolderAddressPrefix(item, token);
  }

  // Pure number or #47 → token id / #NNN in title only
  if (/^#?\d+$/.test(token)) {
    return itemMatchesNumericSearchToken(item, token);
  }

  // --- Primary identity fields (substring is fine: catbot, kix, dacat.blast) ---
  var primary = [
    itemTitle(item),
    item.name,
    item.display_name,
    item.opensea_name,
    item.local_slug,
    itemCollectionLabel(item),
    item.collection_id,
    itemRarityLabel(item),
    item.volume_label,
  ];
  // "vol" / "volume" as words (without bare digit attachment that made "1" match Vol 1)
  if (item.volume != null && item.volume !== "") {
    primary.push("vol", "volume");
  }
  var i;
  for (i = 0; i < primary.length; i++) {
    if (textHasSearchToken(primary[i], token, "substr")) return true;
  }

  // --- Holder names (ENS / Base / OpenSea). Min 2 chars to limit noise. ---
  if (token.length >= 2) {
    var holderNames = itemHolderSearchNames(item);
    for (i = 0; i < holderNames.length; i++) {
      if (textHasSearchToken(holderNames[i], token, "substr")) return true;
    }
  }

  // --- Traits: searchable but low-noise (skip None; no short accidental hits) ---
  // Keep the same discipline as title/story search: min length + word match for short values.
  if (token.length >= 3) {
    var traits = item.traits || [];
    // Trait *types* that are too generic to match on type alone (value still matches)
    var noiseTraitTypes = {
      gear: true,
      hat: true,
      name: true,
      style: true,
      trait: true,
      value: true,
    };
    for (i = 0; i < traits.length; i++) {
      var tr = traits[i];
      if (!tr) continue;
      var tt = String(tr.trait_type || "");
      var tv = String(tr.value != null ? tr.value : "");
      var ttL = tt.toLowerCase();
      var tvTrim = tv.trim();
      if (isEmptyTraitValue(tvTrim)) continue;
      // Skip machine ids
      if (/(_id|id)$/i.test(ttL) && /^\d+$/.test(tvTrim)) continue;
      if (/^\d{6,}$/.test(tvTrim)) continue;
      // Short values ("Cap", "Hat", "Male"): whole-word only — avoids "ca"/"at" noise.
      // Longer values ("Batch 01", "Mythology", "Grumpy Legacy Hood"): substr ok.
      var traitMode = tvTrim.length <= 4 ? "word" : "substr";
      if (textHasSearchToken(tvTrim, token, traitMode)) return true;
      // Trait type labels: "production", "theme", "headwear" — not "gear"/"hat"
      if (
        token.length >= 4 &&
        tt &&
        !noiseTraitTypes[ttL] &&
        textHasSearchToken(tt, token, "substr")
      ) {
        return true;
      }
    }
  }

  // --- Story text: longer tokens only, whole words (not "cop"/"season" in "copies"/"seasoned") ---
  // Skip auto-generated excerpts (stats lines like "1 holder · 1 copy").
  if (token.length >= 4) {
    var story = item.description || "";
    if (story && textHasSearchToken(story, token, "word")) return true;
  }

  return false;
}

/** Series # from HATS title (#020 - …) or token_id fallback. */
function hatsSeriesNumber(item) {
  if (!item) return null;
  var t = item.display_name || item.name || "";
  var m = String(t).match(/#\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  var n = Number(item.token_id);
  return isNaN(n) ? null : n;
}

/**
 * First-mint / release timestamp for Newest + Oldest.
 * Uses minted_at only (not last sale/transfer) so release order stays distinct
 * from "Recently Transferred".
 */
function itemMintTimeMs(item) {
  if (!item) return 0;
  var mint = Date.parse(item.minted_at || 0) || 0;
  if (mint) return mint;
  // Earliest on-chain mint event if catalog mint stamp is missing
  var rows = (item.recent_activity || []).slice();
  var earliest = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || r.type !== "mint" || !r.at) continue;
    var t = Date.parse(r.at) || 0;
    if (t && (!earliest || t < earliest)) earliest = t;
  }
  if (earliest) return earliest;
  // Undated HATS: stable series-order anchor (release wave), not transfer time
  if (normalizeCollectionId(item.collection_id || "") === "hats-n-dacats") {
    var base = Date.parse("2026-08-02T00:00:00.000Z") || 0;
    var series = hatsSeriesNumber(item) || 0;
    return base + series * 60000;
  }
  return 0;
}

/** @deprecated Use itemMintTimeMs — kept as alias for any lingering callers. */
function itemSortTimeMs(item) {
  return itemMintTimeMs(item);
}

/**
 * When viewing a wallet: time this address acquired the piece (sale/transfer/mint to them).
 * Falls back to first-mint so undated rows still sort stably.
 */
function itemAcquiredAtMs(item, viewerAddr) {
  if (!item) return 0;
  var viewer = (viewerAddr || "").toLowerCase();
  if (viewer) {
    var rows = sortActivityRows(dedupeActivityRows(item.recent_activity || []));
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.at || !r.to) continue;
      if (String(r.to).toLowerCase() !== viewer) continue;
      if (r.type === "sale" || r.type === "transfer" || r.type === "mint") {
        var ta = Date.parse(r.at) || 0;
        if (ta) return ta;
      }
    }
  }
  return itemMintTimeMs(item);
}

/**
 * Numeric rarity weight for sort (higher = rarer).
 * Agency trait ladder sits above matching supply tiers where it carries perks:
 *   1:1 → Legendary → Ultra Rare → Epic → Rare → Uncommon → Common
 */
function itemRaritySortRank(item) {
  var label = itemRarityLabel(item);
  if (!label) return 0;
  var k = String(label)
    .toLowerCase()
    .replace(/\s+/g, "");
  if (k === "1:1" || k === "1of1" || k === "1/1") return 100;
  if (k === "legendary") return 90;
  if (k === "ultrarare") return 80;
  if (k === "epic") return 70;
  if (k === "rare") return 60;
  if (k === "uncommon") return 40;
  if (k === "common") return 20;
  return 10;
}

/** Circulating copies for rarity secondary sort (null if unknown / incomplete). */
function itemSortCopyCount(item) {
  var c = effectiveCirculatingCopies(item);
  if (c == null || c === "") return null;
  var n = Number(c);
  // 0 often means steward-only / laggy stats — don't let it beat real supply counts
  if (isNaN(n) || n <= 0) return null;
  return n;
}

/**
 * Token ordinal for stable sorts.
 * Prefers Agency token_rank; otherwise numeric token_id.
 * Token 0 (common badge series-rep id) always sorts last so it doesn't leapfrog real #1s.
 */
function itemTokenSortOrdinal(item) {
  if (!item) return Number.MAX_SAFE_INTEGER - 1;
  if (item.token_rank != null && item.token_rank !== "") {
    var tr = Number(item.token_rank);
    if (!isNaN(tr)) return tr === 0 ? Number.MAX_SAFE_INTEGER : tr;
  }
  var raw = item.token_id;
  if (raw === "" || raw == null) return Number.MAX_SAFE_INTEGER - 1;
  var id = Number(raw);
  if (isNaN(id)) return Number.MAX_SAFE_INTEGER - 1;
  if (id === 0) return Number.MAX_SAFE_INTEGER;
  return id;
}

/**
 * Compare by token rank / id. lowFirst=true → #1 before #2, with #0 last.
 * lowFirst=false → higher ids first, still keeping #0 last.
 */
function compareTokenOrdinal(a, b, lowFirst) {
  var oa = itemTokenSortOrdinal(a);
  var ob = itemTokenSortOrdinal(b);
  if (oa === ob) return 0;
  // Both non-sentinel: normal order
  var aLast = oa === Number.MAX_SAFE_INTEGER;
  var bLast = ob === Number.MAX_SAFE_INTEGER;
  if (aLast && !bLast) return 1;
  if (bLast && !aLast) return -1;
  return lowFirst ? oa - ob : ob - oa;
}

/** Tie-break after equal primary sort keys. */
function compareItemsTieBreak(a, b, newestFirst) {
  var cidA = normalizeCollectionId(a.collection_id || "dacommunity");
  var cidB = normalizeCollectionId(b.collection_id || "dacommunity");
  if (cidA === "hats-n-dacats" && cidB === "hats-n-dacats") {
    var sa = hatsSeriesNumber(a);
    var sb = hatsSeriesNumber(b);
    if (sa != null && sb != null && sa !== sb) {
      return newestFirst ? sb - sa : sa - sb;
    }
  }
  // Prefer mint time as secondary so equal-price still feels release-ordered
  var ma = itemMintTimeMs(a);
  var mb = itemMintTimeMs(b);
  if (ma !== mb) return newestFirst ? mb - ma : ma - mb;
  // Token rank / id — #0 always last (badge series reps)
  var tok = compareTokenOrdinal(a, b, !newestFirst);
  if (tok !== 0) return tok;
  return String(itemTitle(a) || "").localeCompare(String(itemTitle(b) || ""), undefined, {
    sensitivity: "base",
  });
}

/**
 * Badges + Agency: token_id / token_rank are poor rarity tie-breaks
 * (Agency ranks are rarity slots, not true ids; badge clubs keep minting new #s).
 * Sink both collections to the end of whatever rarity tier they're in.
 */
function rarityCollectionSinkPriority(item) {
  var cid = normalizeCollectionId((item && item.collection_id) || "dacommunity");
  if (cid === "badges" || cid === "dagato-agency") return 1;
  return 0;
}

function rarityUsesUnstableTokenIds(item) {
  return rarityCollectionSinkPriority(item) === 1;
}

/**
 * Rarity sort tie-break (same rarity tag):
 * 1) badges + Agency always last in the tier (All collections) — before copy count,
 *    otherwise a 3-copy badge Ultra Rare jumps ahead of a 4-copy archive piece
 * 2) fewer copies first when high→low
 * 3) mint/title (token id only for archive / HATS)
 */
function compareRarityTieBreak(a, b, highFirst) {
  // Within the same rarity tier: badges + Agency always last (All collections view)
  var sinkA = rarityCollectionSinkPriority(a);
  var sinkB = rarityCollectionSinkPriority(b);
  if (sinkA !== sinkB) return sinkA - sinkB;

  var ca = itemSortCopyCount(a);
  var cb = itemSortCopyCount(b);
  if (ca != null && cb != null && ca !== cb) {
    // High rarity first → lower supply first; low→high flips
    return highFirst ? ca - cb : cb - ca;
  }
  // Known supply before unknown when sorting rarest-first
  if (ca != null && cb == null) return highFirst ? -1 : 1;
  if (cb != null && ca == null) return highFirst ? 1 : -1;

  var cidA = normalizeCollectionId(a.collection_id || "dacommunity");
  var cidB = normalizeCollectionId(b.collection_id || "dacommunity");

  // Agency: volume, then mint (skip token_rank — not a true token id)
  if (cidA === "dagato-agency" && cidB === "dagato-agency") {
    var va = Number(a.volume) || 1;
    var vb = Number(b.volume) || 1;
    if (va !== vb) return va - vb;
    var maA = itemMintTimeMs(a);
    var mbA = itemMintTimeMs(b);
    if (maA !== mbA) return highFirst ? mbA - maA : maA - mbA;
    return String(itemTitle(a) || "").localeCompare(String(itemTitle(b) || ""), undefined, {
      sensitivity: "base",
    });
  }

  // Badges: mint then title (token #s shift as clubs grow — e.g. 100B)
  if (cidA === "badges" && cidB === "badges") {
    var maB = itemMintTimeMs(a);
    var mbB = itemMintTimeMs(b);
    if (maB !== mbB) return highFirst ? mbB - maB : maB - mbB;
    return String(itemTitle(a) || "").localeCompare(String(itemTitle(b) || ""), undefined, {
      sensitivity: "base",
    });
  }

  if (cidA === "hats-n-dacats" && cidB === "hats-n-dacats") {
    var sa = hatsSeriesNumber(a);
    var sb = hatsSeriesNumber(b);
    if (sa != null && sb != null && sa !== sb) {
      return highFirst ? sa - sb : sb - sa;
    }
  }

  // Archive / other: token id is meaningful — #0 last
  if (!rarityUsesUnstableTokenIds(a) && !rarityUsesUnstableTokenIds(b)) {
    var tok = compareTokenOrdinal(a, b, true);
    if (tok !== 0) return tok;
  }

  var ma = itemMintTimeMs(a);
  var mb = itemMintTimeMs(b);
  if (ma !== mb) return highFirst ? mb - ma : ma - mb;
  return String(itemTitle(a) || "").localeCompare(String(itemTitle(b) || ""), undefined, {
    sensitivity: "base",
  });
}

function compareItems(a, b) {
  var key = sortKey || "token_desc";
  var viewer =
    galleryCollectorView && galleryCollectorView.address
      ? galleryCollectorView.address
      : "";

  // Agency rarity series (browse grid): keep Vol → rank card order for mint sorts only.
  // Other sorts (rarity / price / transfers) should honor the selected key.
  if (
    (key === "token_desc" || key === "token_asc") &&
    isAgencyRaritySeries(a) &&
    isAgencyRaritySeries(b)
  ) {
    var va = Number(a.volume) || 1;
    var vb = Number(b.volume) || 1;
    if (va !== vb) return va - vb;
    if (a.token_rank != null && b.token_rank != null) {
      var ra = Number(a.token_rank) - Number(b.token_rank);
      if (ra !== 0) return ra;
    }
  }

  if (key === "token_desc" || key === "token_asc") {
    var newestFirst = key === "token_desc";
    // Archive: first-mint / release date. Wallet: when this address acquired it.
    var da = viewer ? itemAcquiredAtMs(a, viewer) : itemMintTimeMs(a);
    var db = viewer ? itemAcquiredAtMs(b, viewer) : itemMintTimeMs(b);
    if (da !== db) return newestFirst ? db - da : da - db;
    return compareItemsTieBreak(a, b, newestFirst);
  }
  if (key === "name_asc") {
    return itemTitle(a).localeCompare(itemTitle(b), undefined, { sensitivity: "base" });
  }
  if (key === "price_asc" || key === "price_desc") {
    var pa = isItemListed(a) && a.listing ? Number(a.listing.amount_eth) : null;
    var pb = isItemListed(b) && b.listing ? Number(b.listing.amount_eth) : null;
    if (pa == null && pb == null) return compareItemsTieBreak(a, b, true);
    if (pa == null) return 1;
    if (pb == null) return -1;
    if (pa !== pb) return key === "price_asc" ? pa - pb : pb - pa;
    return compareItemsTieBreak(a, b, true);
  }
  if (key === "transfer_desc") {
    // Real sales/transfers only — mint-only pieces sink (use Newest for release date)
    var ta = Date.parse(itemLatestMovementAt(a) || 0) || 0;
    var tb = Date.parse(itemLatestMovementAt(b) || 0) || 0;
    if (viewer) {
      var aa = itemAcquiredAtMs(a, viewer);
      var ab = itemAcquiredAtMs(b, viewer);
      if (aa && itemLatestMovementAt(a)) ta = Math.max(ta, aa);
      if (ab && itemLatestMovementAt(b)) tb = Math.max(tb, ab);
    }
    if (tb !== ta) return tb - ta;
    // No movement: stable mint-order sink (older mints first among never-moved)
    if (!ta && !tb) return compareItemsTieBreak(a, b, false);
    return compareItemsTieBreak(a, b, true);
  }
  if (key === "rarity_desc" || key === "rarity_asc") {
    var highFirst = key === "rarity_desc";
    var raR = itemRaritySortRank(a);
    var rbR = itemRaritySortRank(b);
    if (raR !== rbR) return highFirst ? rbR - raR : raR - rbR;
    // Same rarity tag (or both untagged): copy count, then token rank (#0 last)
    return compareRarityTieBreak(a, b, highFirst);
  }
  return compareItemsTieBreak(a, b, true);
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
      // Agency / HATS / BIG KIX: owner match only — never bare token_id
      // (archive #5 ≠ hats-n-dacats #5; bare id matching showed full HATS sets in wallets)
      var cid = i.collection_id || "dacommunity";
      if (
        cid === "dagato-agency" ||
        cid === "hats-n-dacats" ||
        cid === "bigkix" ||
        i.is_edition_token
      ) {
        return false;
      }
      // daCommunity only: composite key, with bare token_id fallback for legacy wallet_index rows
      var key = getItemKey(i);
      if (tidSet[key]) return true;
      if (cid === "dacommunity" && tidSet[String(i.token_id)]) return true;
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
  // Collection dropdown + free-text search:
  // Always honor the collection chip (All vs HATS / BIG KIX / …). Skipping scope when
  // a search term was present made "For sale" + "HATS n' daCATs" look empty / wrong
  // vs the same listed pieces under All collections.
  var qSearch = (searchQuery || "").trim();
  if (activeCollection && activeCollection !== "all") {
    var wantCol = normalizeCollectionId(activeCollection);
    items = items.filter(function (i) {
      return normalizeCollectionId(i.collection_id || "dacommunity") === wantCol;
    });
  }
  if (activeFilter === "listed") items = items.filter(function (i) { return isItemListed(i); });
  if (activeFilter === "not_listed") items = items.filter(function (i) { return !isItemListed(i); });
  if (activeFilter === "activity") items = items.filter(function (i) { return hasRecentActivity(i); });
  if (qSearch) {
    var q = qSearch.toLowerCase();
    items = items.filter(function (i) {
      return itemMatchesSearch(i, q);
    });
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
  activeCollection = "all";
  var search = $("#search");
  var sort = $("#sort-select");
  var colSel = $("#collection-select");
  if (search) search.value = "";
  if (sort) sort.value = "token_desc";
  if (colSel) colSel.value = "all";
  document.querySelectorAll(".filter").forEach(function (btn) {
    var on = btn.dataset.filter === "all";
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  // Reload multi-collection data; loadCollectionScope → syncBrowseParamsToUrl drops q/collection
  loadCollectionScope("all");
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
        return;
      }
      if (k === "search") {
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
        // Do not set activeCollection here — loadCollectionScope owns the reload.
        var colSel = $("#collection-select");
        if (colSel) colSel.value = "all";
      }
      // Collector wallet: expand holdings + re-apply remaining filters (not a no-op refresh)
      onBrowseFilterChipCleared(k);
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
    var listedBadge = isItemListed(item)
      ? '<span class="badge-listed">' +
        (item.listing && item.listing.amount_eth != null
          ? formatEth(item.listing.amount_eth) + " ETH"
          : "Listed") +
        "</span>"
      : "";
    var rarityBadge = formatRarityBadgeHtml(item);
    var traitStrip =
      (item.collection_id || "") === "hats-n-dacats"
        ? formatTraitChipsHtml(item, 3)
        : "";
    var videoBadge = isVideoItem(item) ? '<span class="thumb-video-badge">▶</span>' : "";
    // Agency series: #1–#5 (token_rank); case files / other cols: real token id
    var tokenPill =
      '<span class="token-pill">#' + escapeHtml(itemTokenPillLabel(item)) + "</span>";
    var excerpt = displayExcerpt(item);
    if (!excerpt && fullDataStatus === "loading_full") {
      excerpt = "Story loading from snapshot…";
    }
    row.innerHTML =
      '<div class="gallery-thumb-wrap"><div class="gallery-thumb-slot"></div>' + videoBadge + "</div>" +
      '<div class="gallery-meta"><h3>' +
      formatPieceTitleHtml(title) +
      "</h3><p>" +
      escapeHtml(excerpt || "No excerpt yet.") +
      "</p>" +
      (traitStrip ? '<div class="gallery-trait-row">' + traitStrip + "</div>" : "") +
      "</div>" +
      '<div class="gallery-side">' + tokenPill + rarityBadge + listedBadge + "</div>";
    fillMediaSlot(row.querySelector(".gallery-thumb-slot"), item, { controls: false });
    var thumb = row.querySelector(".gallery-thumb-slot img, .gallery-thumb-slot video");
    if (
      thumb &&
      thumb.tagName === "IMG" &&
      !isBadgeMultiSeriesRep(item) &&
      item.opensea_image_url &&
      resolveMediaUrl(item.image_url) !== resolveMediaUrl(item.opensea_image_url)
    ) {
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

function formatSalePriceBit(row) {
  if (!row || row.price_eth == null || isNaN(Number(row.price_eth))) return "";
  return " · " + formatEth(row.price_eth) + " ETH";
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
  var rows = sortActivityRows(dedupeActivityRows((item && item.recent_activity) || []));
  if (rows.length) {
    var top = rows[0];
    // Prefer sale/transfer over mint when timestamps are close
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].type === "sale" || rows[i].type === "transfer") {
        top = rows[i];
        break;
      }
    }
    return {
      type: top.type,
      at: top.at,
      from: top.from,
      to: top.to,
      quantity: top.quantity,
      price_eth: top.price_eth,
    };
  }
  if (item && item.owners && item.owners.latest_change) return item.owners.latest_change;
  return null;
}

/** Wallet that received the latest mint, transfer, or sale. */
function currentOwnerAddress(item) {
  var change = getLatestChange(item);
  if (!change || !change.to) return null;
  if (change.type === "mint" || change.type === "transfer" || change.type === "sale") {
    return String(change.to).toLowerCase();
  }
  return null;
}

function formatLatestChangePreview(change) {
  if (!change) return "";
  var qty = change.quantity > 1 ? " ×" + change.quantity : "";
  var when = formatMintDate(change.at);
  var priceBit = formatSalePriceBit(change);
  var label =
    change.type === "transfer"
      ? "Latest transfer"
      : change.type === "sale"
        ? "Latest sale"
        : change.type === "mint"
          ? "Latest mint"
          : activityTypeLabel(change.type);
  var toName = change.to ? resolveCollectorIdentity(change.to).display : "";
  var fromName = change.from ? resolveCollectorIdentity(change.from).display : "";
  if (change.type === "mint") {
    return (
      label +
      (when ? " · " + when : "") +
      " · to " +
      (toName || shortenAddress(change.to || "")) +
      qty
    );
  }
  if (change.type === "sale") {
    return (
      label +
      priceBit +
      (when ? " · " + when : "") +
      " · " +
      (fromName || shortenAddress(change.from || "")) +
      " → " +
      (toName || shortenAddress(change.to || "")) +
      qty
    );
  }
  return (
    label +
    (when ? " · " + when : "") +
    " · " +
    (fromName || shortenAddress(change.from || "")) +
    " → " +
    (toName || shortenAddress(change.to || "")) +
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
    // Show purchase price when OpenSea provided it (HATS + other collections)
    var priceBit = formatSalePriceBit(row);
    return (
      "Sold" +
      priceBit +
      " · " +
      addressActionHtml(row.from || "") +
      " → " +
      addressActionHtml(row.to || "") +
      qty
    );
  }
  return activityTypeLabel(row.type) + qty;
}

/** For Agency rarity rows: merge recent_activity from member case files if missing. */
function ensureAgencySeriesActivity(item) {
  if (!item || !isAgencyRaritySeries(item)) return item;
  if (item.recent_activity && item.recent_activity.length) return item;
  var wantIds = {};
  (item.member_token_ids || []).forEach(function (id) {
    wantIds[String(id)] = true;
  });
  var rarity = itemRarityLabel(item);
  // Scope member merge to this series' volume so Vol 1 #N activity never mixes into Vol 2
  var seriesVol =
    item.volume != null && item.volume !== "" ? String(item.volume) : null;
  var rows = [];
  ((galleryData && galleryData.items) || []).forEach(function (ed) {
    if (!ed || isAgencyRaritySeries(ed)) return;
    if ((ed.collection_id || "") !== "dagato-agency" && !ed.is_edition_token) return;
    if (seriesVol != null && String(ed.volume) !== seriesVol) return;
    var tid = String(ed.token_id);
    var match =
      (Object.keys(wantIds).length && wantIds[tid]) ||
      (!Object.keys(wantIds).length && rarity && itemRarityLabel(ed) === rarity);
    if (!match && rarity && itemRarityLabel(ed) === rarity) match = true;
    if (!match) return;
    (ed.recent_activity || []).forEach(function (r) {
      if (r) rows.push(r);
    });
  });
  if (!rows.length) return item;
  rows = dedupeActivityRows(rows);
  rows.sort(function (a, b) {
    return String(b.at || "").localeCompare(String(a.at || ""));
  });
  item.recent_activity = rows.slice(0, 12);
  return item;
}

function renderDetailActivity(item) {
  var block = $("#detail-activity");
  var list = $("#detail-activity-list");
  var osLink = $("#detail-activity-opensea");
  var countEl = $("#detail-activity-count");
  var previewEl = $("#detail-activity-preview");
  if (item) ensureAgencySeriesActivity(item);
  var rows = sortActivityRows(dedupeActivityRows(item.recent_activity || []));
  if (!rows.length) {
    block.hidden = true;
    setActivityDisclosureOpen(false);
    return;
  }
  block.hidden = false;
  // Always start collapsed (same as other collections) — preview line still
  // shows latest sale/transfer; tap to expand the full list.
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
        (row.type === "sale" && row.price_eth != null
          ? " · " + formatEth(row.price_eth) + " ETH"
          : "") +
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
      // Pass full holder row so badge reverse-ENS stamps participate in identity resolve
      var meta = addressDisplayMeta(h);
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

function openDetail(item, opts) {
  opts = opts || {};
  if (!item) return;
  closeCollectorsModal();
  activeDetailTokenId = getItemKey(item);
  if (!opts.noPush) {
    var curD = history.state;
    // Same piece already on stack → replace; otherwise push so Back returns here
    if (
      curD &&
      curD.kind === NAV_KIND &&
      curD.view === "detail" &&
      curD.piece === activeDetailTokenId
    ) {
      replaceNavState("detail", { piece: activeDetailTokenId });
    } else {
      pushNavState("detail", { piece: activeDetailTokenId });
    }
  } else {
    replaceNavState("detail", { piece: activeDetailTokenId });
  }
  var panel = $("#detail-panel");
  if (!panel) return;
  fillMediaSlot($("#detail-media-slot"), item, { autoplay: true, controls: true });
  $("#detail-title").innerHTML = formatPieceTitleHtml(itemTitle(item));
  if (isAgencyRaritySeries(item)) {
    // Attach transfer/sale history from case files when series row lacks activity
    ensureAgencySeriesActivity(item);
    var nFiles = item.case_file_count || (item.case_files && item.case_files.length) || 0;
    var rankN = item.token_rank != null ? item.token_rank : itemTokenPillLabel(item);
    var raritySub = itemRarityLabel(item) || "";
    $("#detail-token").textContent =
      "Token #" +
      rankN +
      (raritySub ? " · " + raritySub : "") +
      (nFiles
        ? " · " + nFiles + " case file" + (nFiles === 1 ? "" : "s")
        : "");
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
  var osBtn = $("#detail-opensea");
  if (osBtn) {
    if (item.opensea_url) {
      osBtn.href = item.opensea_url;
      osBtn.removeAttribute("aria-disabled");
      osBtn.classList.remove("is-disabled");
    } else {
      osBtn.href = "#";
      osBtn.setAttribute("aria-disabled", "true");
      osBtn.classList.add("is-disabled");
    }
  }
  // Share this piece (bound once in bindUi; always available for every NFT)
  var detailShare = $("#detail-share");
  if (detailShare) {
    detailShare.hidden = false;
    detailShare.dataset.pieceKey = getItemKey(item);
  }

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
  if (isItemListed(item)) {
    badge.hidden = false;
    badge.textContent =
      item.listing && item.listing.amount_eth != null
        ? "For sale · " + formatEth(item.listing.amount_eth) + " ETH"
        : "For sale";
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
  // HATS n' daCATs: all real traits in detail (never "None"); cards show top 3 only
  if ((item.collection_id || "") === "hats-n-dacats") {
    itemTraitChips(item, 24, { mode: "all" }).forEach(function (c) {
      var label = c.trait_type ? c.trait_type + ": " + c.value : c.value;
      chips.push(
        '<span class="chip trait-detail-chip" title="' +
          escapeHtml(label) +
          '">' +
          escapeHtml(c.trait_type ? c.trait_type + " · " + c.value : c.value) +
          "</span>"
      );
    });
  }
  if (item.owners) {
    chips.push('<span class="chip"><strong>' + effectiveHolderCount(item) + "</strong> holders</span>");
    var circ = effectiveCirculatingCopies(item);
    // True 1:1s (1 circulating copy): avoid redundant "1 copies" noise
    if (circ != null && circ <= 1) {
      chips.push('<span class="chip">Unique 1:1</span>');
    } else if (circ != null) {
      chips.push('<span class="chip"><strong>' + circ + "</strong> copies</span>");
    }
  }
  if (isItemListed(item) && item.listing && item.listing.amount_eth != null) {
    chips.push('<span class="chip">List <strong>' + formatEth(item.listing.amount_eth) + " ETH</strong></span>");
  }
  stats.innerHTML = chips.length ? chips.join("") : '<span class="chip">Community piece</span>';
  renderDetailActivity(item);
  renderDetailOwners(item);
  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  syncGalleryScrollNudge();
}

function closeDetail(opts) {
  opts = opts || {};
  var panel = $("#detail-panel");
  if (!panel) return;
  var wasOpen = panel.classList.contains("open") || !!activeDetailTokenId;
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
  activeDetailTokenId = null;
  if (!$("#collectors-modal").classList.contains("open")) {
    document.body.style.overflow = "";
  }
  var explore = $("#collector-explore");
  if (explore) explore.hidden = true;
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
  syncGalleryScrollNudge();
  // Browser Back from detail → collector/browse step; in-app close uses history when possible
  if (
    wasOpen &&
    !opts.fromPopstate &&
    canHistoryBackInApp() &&
    history.state &&
    history.state.view === "detail"
  ) {
    try {
      history.back();
      return;
    } catch (e) {}
  }
  if (!opts.fromPopstate) {
    replaceNavState(galleryCollectorView ? "collector" : "browse", { piece: null });
  }
}

/** Prefer shared scroll-nudge.js; fall back if that script is missing. */
function syncGalleryScrollNudge() {
  if (typeof window.syncSiteScrollNudge === "function") {
    window.syncSiteScrollNudge();
    return;
  }
  var btn = $("#gallery-scroll-nudge") || $("#site-scroll-nudge");
  if (!btn) return;
  var wide = window.innerWidth >= 900;
  var detailOpen =
    !!activeDetailTokenId ||
    !!(
      $("#detail-panel") &&
      $("#detail-panel").classList.contains("open")
    );
  var room =
    document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  btn.classList.toggle("is-away", !(wide && !detailOpen && room > 80));
}

function bindGalleryScrollNudge() {
  // Primary binding is web/js/scroll-nudge.js (loaded before app.js).
  // Keep a no-op-safe re-sync after grid paints.
  syncGalleryScrollNudge();
}

function refreshView() {
  if (!galleryData) return;
  // Use deduped count so "Pieces" / "X of Y" matches exactly what's shown in the grid
  // (dacommunity items + deduped badges = 64 + 15 when All)
  var total = getDedupedPiecesCount(galleryData.items);
  var filtered = getFilteredItems();
  renderBrowseMeta(filtered.length, total);
  renderGallery(filtered);
  // Grid height changes when filters/collection switch — re-evaluate nudge
  syncGalleryScrollNudge();
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
  live.forEach(function (c) {
    var o = document.createElement("option");
    o.value = c.id;
    o.textContent = collectionSelectLabel(c);
    sel.appendChild(o);
  });
  sel.value = activeCollection || "all";
}

/** True if loaded galleryData already includes pieces for this collection id. */
function galleryHasCollectionItems(colId) {
  var items = (galleryData && galleryData.items) || [];
  if (!items.length) return false;
  if (!colId || colId === "all") {
    // "all" needs archive + at least one secondary, or pure archive is ok for filter-all
    var hasDacom = false;
    var hasSecondary = false;
    items.forEach(function (i) {
      var c = normalizeCollectionId(i.collection_id || "dacommunity");
      if (c === "dacommunity") hasDacom = true;
      else hasSecondary = true;
    });
    return hasDacom;
  }
  var want = normalizeCollectionId(colId);
  if (want === "dacommunity") {
    return items.some(function (i) {
      return (
        normalizeCollectionId(i.collection_id || "dacommunity") === "dacommunity" &&
        !i.source_created_collection
      );
    });
  }
  return items.some(function (i) {
    return normalizeCollectionId(i.collection_id || "") === want;
  });
}

/**
 * In collector portfolio: change collection chip without full reload when data is already loaded.
 * Avoids empty grid from reloading before tokenIds are rebuilt.
 */
function applyCollectorCollectionFilter(newCol) {
  newCol = newCol || "all";
  activeCollection = newCol;
  var colSel = $("#collection-select");
  if (colSel) colSel.value = newCol;
  syncBrowseParamsToUrl();
  expandCollectorHoldingsFromLoadedData();
  renderCollectorFocusUi();
  paintCollectorsUi();
  renderStats((galleryData && galleryData.collection) || null);
  refreshView();
  adaptHeaderForCollection();
  applyCollectionUI();
}

/** Load gallery data for a collection id. Gen counter ignores stale async completions. */
var collectionScopeGen = 0;
async function loadCollectionScope(newCol) {
  newCol = newCol || "all";
  var gen = ++collectionScopeGen;
  activeCollection = newCol;
  var colSel = $("#collection-select");
  if (colSel) colSel.value = newCol;
  syncBrowseParamsToUrl();

  var col = getCurrentCollection();
  var hasWallet = !col || (col.features || []).indexOf("wallet_lookup") !== -1;
  var urls = getCollectionDataUrls(newCol);
  var loadEl = $("#load-state");
  if (loadEl) loadEl.hidden = false;

  function stillCurrent() {
    return gen === collectionScopeGen;
  }

  function finishUi() {
    if (!stillCurrent()) return;
    // Portfolio: rebuild tokenIds from loaded items + wallet_index BEFORE painting the grid
    if (galleryCollectorView) {
      expandCollectorHoldingsFromLoadedData();
      renderCollectorFocusUi();
    }
    paintCollectorsUi();
    renderStats((galleryData && galleryData.collection) || null);
    renderDataFreshness();
    refreshView();
    adaptHeaderForCollection();
    applyCollectionUI();
    if (activeDetailTokenId) {
      var openItem = itemsById.get(activeDetailTokenId);
      if (openItem) refreshDetailPanel(openItem);
    }
  }

  try {
    if (urls) {
      CATALOG_URL = urls.catalog;
      FULL_DATA_URL = urls.full;
      var secondary = await loadSecondaryCollectionData(urls);
      if (!stillCurrent()) return;
      galleryData = secondary;
      stampMissingCollectionId(
        galleryData.items,
        newCol ||
          (galleryData.collection &&
            (galleryData.collection.id || galleryData.collection.slug)) ||
          "dacommunity"
      );
      // Keep filter tabs in sync when switching into a secondary collection
      document.querySelectorAll(".filter").forEach(function (btn) {
        var on = btn.dataset.filter === activeFilter;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      dataSource =
        (galleryData.source || "").indexOf("catalog") >= 0 ? "catalog" : "full";
      indexItems(galleryData);
      finishUi();
      loadWalletIndex().then(function () {
        if (!stillCurrent()) return;
        if (galleryData && Array.isArray(galleryData.items)) {
          stampAllOwnerIdentities(galleryData.items);
        }
        finishUi();
      });
    } else {
      // "all" or dacommunity — primary archive + optional secondary merge
      initDataUrls();
      var mainData = await loadCatalogFirst();
      if (!stillCurrent()) return;
      galleryData = mainData;
      // Always stamp archive as "dacommunity" (catalog meta slug is dacommunity-archive)
      stampMissingCollectionId(galleryData.items, "dacommunity");
      dataSource =
        galleryData.source === "gallery_catalog" ? "catalog" : "full";
      indexItems(galleryData);
      if (!newCol || newCol === "all") {
        await mergeSecondaryCatalogsIntoGallery();
      }
      if (!stillCurrent()) return;
      document.querySelectorAll(".filter").forEach(function (btn) {
        var on = btn.dataset.filter === activeFilter;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      finishUi();
      if (dataSource === "catalog") {
        refreshFullDataInBackground();
      }
      if (hasWallet) {
        loadWalletIndex().then(function () {
          if (!stillCurrent()) return;
          finishUi();
        });
      } else {
        clearGalleryCollectorView({ clearResult: true });
        collectorsList = [];
        var btn = $("#view-collectors-btn");
        if (btn) btn.hidden = true;
      }
    }
  } catch (err) {
    if (!stillCurrent()) return;
    console.error("Collection data switch failed", err);
    refreshView();
    adaptHeaderForCollection();
    applyCollectionUI();
  } finally {
    if (stillCurrent() && loadEl) loadEl.hidden = true;
  }
}

function bindUi() {
  bindGalleryScrollNudge();
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
    collectionSelect.addEventListener("change", function (e) {
      var newCol = e.target.value || "all";
      if (newCol === activeCollection) return;
      // Collector wallet: filter in place when pieces for that collection are already loaded
      // (full reload used to paint an empty grid before holdings/tokenIds rebuilt).
      if (galleryCollectorView) {
        var canFilterInPlace =
          newCol === "all"
            ? galleryHasCollectionItems("dacommunity")
            : galleryHasCollectionItems(newCol);
        // Prefer multi-collection data when selecting "all" so other collections still show
        if (newCol === "all" && canFilterInPlace) {
          applyCollectorCollectionFilter("all");
          return;
        }
        if (newCol !== "all" && canFilterInPlace) {
          applyCollectorCollectionFilter(newCol);
          return;
        }
      }
      loadCollectionScope(newCol);
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

  // Archive / portfolio "Share view" — collection + filters (+ wallet when in collector mode)
  var archiveShare = $("#archive-share-btn");
  if (archiveShare && !archiveShare.dataset.bound) {
    archiveShare.dataset.bound = "1";
    archiveShare.addEventListener("click", function () {
      if (galleryCollectorView && galleryCollectorView.address) {
        shareCollectorCollection(galleryCollectorView.address);
        return;
      }
      showShareModal(buildCurrentViewUrl(), {
        title: "Share this view",
        lead: "Link includes current collection, search, filters, and sort.",
        shareText: "daCAT archive view — filters and collection included",
        toast: "Link copied (includes collection + filters)",
      });
    });
  }
  renderCollectorFocusUi();
  bindNameSuggestInputs();
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
  // Every NFT detail: Share beside OpenSea
  var detailShareBtn = $("#detail-share");
  if (detailShareBtn && !detailShareBtn.dataset.bound) {
    detailShareBtn.dataset.bound = "1";
    detailShareBtn.addEventListener("click", function (e) {
      e.preventDefault();
      var key = detailShareBtn.dataset.pieceKey || activeDetailTokenId;
      var item =
        (key && itemsById.get(key)) ||
        findItemBySlug(key) ||
        null;
      shareDetailPiece(item);
    });
  }
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
  // Tag items with collection_id for multi-collection filtering (never "all")
  if (galleryData && Array.isArray(galleryData.items)) {
    var cid =
      activeCollection && activeCollection !== "all"
        ? activeCollection
        : "dacommunity";
    // Primary archive catalog meta slug is "dacommunity-archive" — never stamp that
    if (!cid || cid === "dacommunity" || normalizeCollectionId(cid) === "dacommunity") {
      cid = "dacommunity";
    }
    stampMissingCollectionId(galleryData.items, cid);
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
  // Popstate listener only — never replaceState until URL params are in globals
  bindGalleryPopState();

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

    // CRITICAL order: parse deep links BEFORE any history.replaceState / syncBrowseParamsToUrl.
    // Seeding history with default activeCollection="all" previously rewrote
    //   /dacommunity/?collection=badges  →  /dacommunity/
    // and stripped ?wallet= share links the same way (Telegram → bare archive).
    parseBrowseParamsFromUrl();
    seedGalleryNavStateFromUrl();

    // Load registry early for collection filter UI (only live ones shown)
    await loadCollectionsRegistry().catch(function(){});
    populateCollectionSelect();
    // Re-apply collection select after options exist (seed already set activeCollection)
    applyBrowseControlsFromState();

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
    // Re-check meta after deploy lag so a just-cleared fail flag drops without hard refresh
    scheduleMetaRefresh();

    var initCol = getCurrentCollection();
    var hasWalletInit = !initCol || (initCol.features || []).indexOf("wallet_lookup") !== -1;
    if (hasWalletInit) {
      loadWalletIndex().then(function () {
        // Enrich owners with full identity: ENS → Base → OpenSea
        if (galleryData && Array.isArray(galleryData.items)) {
          stampAllOwnerIdentities(galleryData.items);
        }
        // Force collectors for active collection (esp. ?collection=bigkix cold load)
        rebuildCollectorsForCurrentView();
        enrichCollectorsListNames();
        renderTopCollectors();
        renderNameSuggestDatalists();
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
    }
  } catch (err) {
    console.error(err);
    if (err.message === "FILE_PROTOCOL") return;
    showFatalError("Could not load gallery data", err.message || String(err), "Run: cd backend && python build_catalog.py");
  }
}

// defer script in dacommunity/index.html — DOM is ready when this runs
init();