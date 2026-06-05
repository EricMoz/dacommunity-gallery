/**
 * daCommunity Gallery — static frontend (served from /dacommunity/ on Pages).
 *
 * BOOT FLOW (init → bootGallery):
 *   1. initDataUrls() — resolve ../data/*.json from body[data-base] on subpages
 *   2. loadCatalogFirst() — small gallery_catalog.json (~140KB) for first paint
 *   3. bootGallery() — hide #load-state, fill #stats-strip, render grid, bindUi()
 *   4. refreshFullDataInBackground() — merge descriptions + recent_activity from full JSON
 *   5. loadWalletIndex() — ENS names for collector lookup (non-blocking)
 *
 * If app.js fails to parse, the page stays on static HTML loaders (#load-state spinner
 * + four .stat.skeleton cards). CI runs `node --check` on this file before deploy.
 *
 * No wallet connect; ENS resolve via ensdata.net when needed.
 * Collector lookup: wallet_index.json, shareable ?wallet=0x… URLs, holdings grid.
 */

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

let CATALOG_URL = "";
let FULL_DATA_URL = "";
let WALLET_URL = "";
let META_URL = "";
let galleryMeta = null;

function initDataUrls() {
  var prefix = getDataPrefix();
  CATALOG_URL = prefix + "data/gallery_catalog.json";
  FULL_DATA_URL = prefix + "data/gallery_data.json";
  WALLET_URL = prefix + "data/wallet_index.json";
  META_URL = prefix + "data/gallery_meta.json";
}

const $ = (sel, root = document) => root.querySelector(sel);

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
/** Token id when detail drawer is open — refresh holders/activity after background merge. */
let activeDetailTokenId = null;

var FILTER_LABELS = {
  all: "All",
  listed: "For sale",
  not_listed: "Not listed",
  activity: "Recent moves",
};

var SORT_LABELS = {
  token_desc: "Newest token #",
  token_asc: "Oldest token #",
  price_asc: "Price · low first",
  price_desc: "Price · high first",
  transfer_desc: "Recently transferred",
  name_asc: "Name A–Z",
};

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
      mergeEl.textContent = "Full archive loaded — stories and activity are current for this snapshot.";
      mergeEl.classList.add("is-done");
      setTimeout(function () {
        if (fullDataStatus === "live") mergeEl.hidden = true;
      }, 3200);
    } else if (status === "error") {
      mergeEl.hidden = false;
      mergeEl.classList.remove("is-done");
      mergeEl.textContent = "Could not load full details — excerpts still visible from catalog.";
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
        " hours old. Listings and transfers may be outdated until the daily refresh succeeds (check GitHub Actions and OPENSEA_API_KEY).",
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
    extra = " · ⚠ refresh failed — renew OPENSEA_API_KEY secret";
  } else if (meta.opensea_key && meta.opensea_key.rotation_reminder_days) {
    extra =
      " · renew API key secret about every " +
      meta.opensea_key.rotation_reminder_days +
      " days";
  }
  footer.innerHTML = base + '<span id="footer-updated">' + escapeHtml(updated) + "</span>" + escapeHtml(extra);
}

async function loadGalleryMeta() {
  if (isFileProtocol()) return;
  try {
    galleryMeta = await fetchJson(META_URL, 8000);
    applyGalleryMeta(galleryMeta);
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
    const res = await fetch(url, { signal: ctrl.signal, cache: "default" });
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
    itemsById.set(String(i.token_id), i);
  });
}

function mergeFullDescriptions(full) {
  if (!full || !full.items) return;
  full.items.forEach(function (fullItem) {
    const cur = itemsById.get(String(fullItem.token_id));
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
    var openItem = itemsById.get(String(activeDetailTokenId));
    if (openItem) refreshDetailPanel(openItem);
  }
}

// --- Data loading: catalog (fast) → full JSON (stories/activity) → wallet index ---

/** First paint: lean catalog built by backend/build_catalog.py (no recent_activity). */
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
  if (!galleryData || !galleryData.wallet_index_file) {
    walletIndex = (galleryData && galleryData.holders_index) || null;
    collectorsList = buildCollectorsFromIndex(walletIndex);
    return;
  }
  try {
    const w = await fetchJson(WALLET_URL, 20000);
    walletIndex = w.holders_index || null;
    collectorsList =
      (walletIndex && walletIndex.collectors) || buildCollectorsFromIndex(walletIndex);
  } catch (e) {
    console.warn("Wallet index load failed:", e);
    walletIndex = null;
    collectorsList = [];
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
  if (v < 0.01) return v.toFixed(4);
  return v.toFixed(3);
}

function escapeHtml(str) {
  var d = document.createElement("div");
  d.textContent = str == null ? "" : str;
  return d.innerHTML;
}

function itemTitle(item) {
  return item.display_name || item.local_slug || item.name || "Token #" + item.token_id;
}

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
    break;
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.join("\n").trim();
}

function displayExcerpt(item) {
  var text = cleanStoryText(item);
  if (!text) return "";
  var flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 160) return flat;
  return flat.slice(0, 159).trim() + "…";
}

function isVideoItem(item) {
  if (item.media_type === "video") return true;
  return /\.(mp4|mov|webm)(\?|$)/i.test(item.image_url || "");
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
  var lookupValue = (entry && entry.ens_name) || full;
  var display = entry
    ? entry.ens_name || entry.username || shortenAddress(full)
    : shortenAddress(full);
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

function sortHoldersForDisplay(holders, item) {
  var pinAddr = currentOwnerAddress(item);
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
    showCopyToast(ok ? "Address copied" : "Copy failed — select and copy manually");
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

// --- Collector lookup (wallet_index.json, shareable ?wallet= URLs) ---

function parseWalletFromUrl() {
  var params = new URLSearchParams(window.location.search);
  return (params.get("wallet") || params.get("ens") || "").trim();
}

function syncWalletShareUrl(address) {
  if (!address || !/^0x[a-fA-F0-9]{40}$/i.test(address)) return;
  var params = new URLSearchParams(window.location.search);
  params.set("wallet", address.toLowerCase());
  params.delete("ens");
  var q = params.toString();
  var path = window.location.pathname + (q ? "?" + q : "") + window.location.hash;
  history.replaceState(null, "", path);
}

function clearWalletShareUrl() {
  var params = new URLSearchParams(window.location.search);
  params.delete("wallet");
  params.delete("ens");
  var q = params.toString();
  var path = window.location.pathname + (q ? "?" + q : "") + window.location.hash;
  history.replaceState(null, "", path);
}

function collectorTokenIdSet(entry) {
  var ids = {};
  (entry.holdings || []).forEach(function (h) {
    ids[String(h.token_id)] = true;
  });
  return ids;
}

function setGalleryCollectorView(entry) {
  if (!entry) return;
  var label = entry.ens_name || entry.username || shortenAddress(entry.address);
  galleryCollectorView = {
    address: entry.address.toLowerCase(),
    label: label,
    tokenIds: collectorTokenIdSet(entry),
    pieceCount: nvl(entry.unique_pieces, (entry.holdings || []).length),
  };
  renderCollectorFocusUi();
  refreshView();
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

/** Leave focused wallet grid — optional full reset of lookup UI. */
function exitCollectorView(opts) {
  opts = opts || {};
  if (!galleryCollectorView) return;
  if (opts.clearInput) {
    var input = $("#wallet-input");
    if (input) input.value = "";
  }
  clearGalleryCollectorView({ clearResult: opts.clearResult !== false });
  if (opts.scrollGallery !== false) {
    var list = $("#gallery-list");
    if (list) list.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function scrollToCollectorCollection() {
  var panel = $("#wallet-panel");
  if (panel && galleryCollectorView) {
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  var list = $("#gallery-list");
  if (list) list.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderCollectorFocusUi() {
  var active = !!galleryCollectorView;
  document.body.classList.toggle("has-collector-view", active);

  var panel = $("#wallet-panel");
  if (panel) {
    panel.classList.toggle("is-collector-active", active);
    panel.classList.toggle("is-collector-compact", active && panel.classList.contains("has-result"));
  }

  var banner = $("#collector-view-banner");
  if (banner) banner.hidden = !active;

  if (galleryCollectorView) {
    var label = galleryCollectorView.label;
    var count = galleryCollectorView.pieceCount;
    var pieceWord = count === 1 ? "piece" : "pieces";

    var bannerMeta = $("#collector-banner-meta");
    if (bannerMeta) {
      bannerMeta.textContent =
        "Viewing " + label + " · " + count + " " + pieceWord + " in the grid below";
    }

    var chipLabel = $("#collector-exit-chip-label");
    if (chipLabel) chipLabel.textContent = label;

  }

  var zone = $("#gallery-focus-zone");
  if (zone) zone.classList.toggle("is-collector-grid", active);

  var list = $("#gallery-list");
  if (list) list.classList.toggle("gallery-list--collector", active);
}

function bindCollectorExitUi() {
  function onExitClick(e) {
    if (e) e.preventDefault();
    exitCollectorView({ clearResult: false, scrollGallery: true });
  }

  [$("#collector-banner-exit"), $("#collector-exit-chip")].forEach(function (el) {
    if (!el || el.dataset.boundExit) return;
    el.dataset.boundExit = "1";
    el.addEventListener("click", onExitClick);
  });
}

function handleEscapeKey() {
  if ($("#collectors-modal").classList.contains("open")) {
    closeCollectorsModal();
    return;
  }
  if ($("#detail-panel").classList.contains("open")) {
    closeDetail();
    return;
  }
  if (galleryCollectorView) {
    exitCollectorView({ clearResult: false, scrollGallery: false });
    return;
  }
  if (searchQuery) {
    searchQuery = "";
    var searchInp = $("#search");
    if (searchInp) searchInp.value = "";
    refreshView();
    return;
  }
  if (activeFilter !== "all" || sortKey !== "token_desc") {
    activeFilter = "all";
    sortKey = "token_desc";
    var sortSel = $("#sort-select");
    if (sortSel) sortSel.value = "token_desc";
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
  var entry = walletIndex && walletIndex.by_address && walletIndex.by_address[key];
  var meta = addressDisplayMeta(address);
  closeDetail();
  closeCollectorsModal();
  var input = $("#wallet-input");
  if (input) input.value = meta.lookupValue || meta.address;
  if (entry) {
    renderWalletSuccess(entry);
    syncWalletShareUrl(entry.address);
    scrollToCollectorCollection();
    return;
  }
  runWalletLookupFromAddress(address, meta.lookupValue);
}

function walletShareUrl(address) {
  var url = new URL(window.location.href);
  url.searchParams.set("wallet", address.toLowerCase());
  url.searchParams.delete("ens");
  if (!url.hash) url.hash = "wallet-panel";
  return url.toString();
}

function scrollToCollectorHub() {
  var panel = $("#wallet-panel");
  if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function runWalletLookupFromAddress(address, lookupValue) {
  var input = $("#wallet-input");
  if (!input) return;
  var meta = addressDisplayMeta(address);
  input.value = lookupValue || meta.lookupValue || meta.address;
  closeDetail();
  closeCollectorsModal();
  renderWalletLookup(input.value, { updateUrl: true, scroll: true });
}

async function applyWalletFromUrl() {
  var q = parseWalletFromUrl();
  if (!q) return;
  var input = $("#wallet-input");
  if (input) input.value = q;
  await renderWalletLookup(q, { updateUrl: false, scroll: true });
}

function collectorRank(address) {
  var key = (address || "").toLowerCase();
  for (var i = 0; i < collectorsList.length; i++) {
    if (collectorsList[i].address.toLowerCase() === key) return i + 1;
  }
  return null;
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
  var top = collectorsList.slice(0, 8);
  track.innerHTML = top
    .map(function (c) {
      var label = c.ens_name || c.username || shortenAddress(c.address);
      return (
        '<button type="button" class="top-collector-pill" data-address="' +
        escapeHtml(c.address) +
        '" data-lookup="' +
        escapeHtml(c.ens_name || c.address) +
        '">' +
        escapeHtml(label) +
        '<span class="meta">' +
        c.unique_pieces +
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
    listedBadge +
    "</div></div>";
  if (item) {
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
    btn.addEventListener("click", function () {
      openDetail(item);
    });
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
    var item = itemsById.get(String(h.token_id));
    container.appendChild(createHoldingCard(item, h));
  });
  if (!sorted.length) {
    container.innerHTML = '<p class="wallet-state-lead">No pieces indexed for this wallet.</p>';
  }
}

function bindCollectorResultActions(entry) {
  var shareBtn = $("#wallet-share-btn");
  if (shareBtn) {
    shareBtn.addEventListener("click", function () {
      var url = walletShareUrl(entry.address);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
          function () {
            showCopyToast("Share link copied — send your daCATs to the world");
          },
          function () {
            showCopyToast("Copy this URL: " + url);
          }
        );
      } else {
        showCopyToast("Share URL: " + url);
      }
    });
  }
  var copyBtn = $("#wallet-copy-address");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      copyFullAddress(entry.address);
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

function renderWalletSuccess(entry) {
  var resultEl = $("#wallet-result");
  if (!resultEl) return;
  var label = entry.ens_name || entry.username || shortenAddress(entry.address);
  var holdings = entry.holdings || [];
  var uq = nvl(entry.unique_pieces, holdings.length);
  var qty = nvl(entry.collection_quantity, "—");
  var rank = collectorRank(entry.address);
  var rankHtml =
    rank && rank <= 10
      ? '<span class="collector-profile-badge">#' + rank + " in the archive</span>"
      : "";

  resultEl.hidden = false;
  resultEl.innerHTML =
    '<div class="collector-profile-card">' +
    '<div class="collector-profile-main">' +
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
    "</div></div>" +
    '<div class="collector-actions">' +
    '<button type="button" class="btn btn-accent" id="wallet-share-btn">Share this collection</button>' +
    '<button type="button" class="btn btn-outline btn-sm" id="wallet-copy-address">Copy address</button>' +
    "</div>" +
    '<h3 class="holdings-heading">Pieces in the archive (' +
    holdings.length +
    ")</h3>" +
    '<div class="holdings-grid" id="wallet-holdings-grid"></div>';

  renderHoldingsGrid(holdings, $("#wallet-holdings-grid"));
  bindCollectorResultActions(entry);
  var hub = resultEl.closest && resultEl.closest(".collector-hub");
  if (hub) hub.classList.add("has-result");
  setGalleryCollectorView(entry);
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
  var res = await fetch(url);
  if (!res.ok) throw new Error("ENS name could not be resolved.");
  var data = await res.json();
  var addr = data.address || (data.wallets && data.wallets.eth);
  if (!addr) throw new Error("No address found for this ENS name.");
  return addr.toLowerCase();
}

function lookupWallet(identifier) {
  if (!walletIndex || !walletIndex.by_address) {
    return {
      error: "Collector index still loading — try again in a moment.",
      title: "Archive warming up",
    };
  }
  var raw = identifier.trim();
  if (!raw) {
    return {
      error: "Paste an ENS name or 0x address to see what's in the archive.",
      title: "Need an address",
    };
  }
  var address = raw.toLowerCase();

  if (isEnsName(raw)) {
    var alias = walletIndex.ens_aliases && walletIndex.ens_aliases[raw.toLowerCase()];
    if (alias) address = alias.toLowerCase();
    else return { needsResolve: true, ens: raw };
  } else if (!isEthAddress(raw)) {
    return {
      error: "That doesn't look like a valid ENS (.eth / .base.eth) or 0x address.",
      title: "Check the format",
      hint: "Example: mozvane.eth or 0xabc…1234",
    };
  }

  var entry = walletIndex.by_address[address];
  if (!entry) {
    return {
      error: "This wallet isn't in our daCommunity index — no pieces held in the daily snapshot.",
      title: "No daCATs here yet",
      hint: "They may still collect elsewhere, or the next refresh may catch a new holder.",
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
      var item = itemsById.get(String(h.token_id));
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
      var item = itemsById.get(String(btn.dataset.token));
      if (item) openDetail(item);
    });
  });
}

async function renderWalletLookup(identifier, opts) {
  opts = opts || {};
  clearWalletResultHighlight();
  renderWalletState("loading");

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
  renderWalletSuccess(entry);
  if (opts.updateUrl !== false) syncWalletShareUrl(entry.address);
  if (opts.scroll) scrollToCollectorCollection();
}

function updateCollectorsButton() {
  var btn = $("#view-collectors-btn");
  if (btn) btn.hidden = !collectorsList.length;
  document.querySelectorAll(".stat-collectors").forEach(function (el) {
    el.disabled = !collectorsList.length;
    el.style.opacity = collectorsList.length ? "1" : "0.55";
  });
  renderTopCollectors();
}

function openCollectorsModal() {
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
  if (!entry && activeDetailTokenId) {
    var piece = itemsById.get(String(activeDetailTokenId));
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
      var suffix = c.unique_pieces === 1 ? "" : "s";
      return (
        '<button type="button" class="collector-row" data-address="' + escapeHtml(c.address) + '">' +
        '<div class="collector-info"><strong>' + escapeHtml(label) + '</strong><span class="meta">' + escapeHtml(c.address) + "</span></div>" +
        '<span class="count">' + c.unique_pieces + " piece" + suffix + "</span></button>"
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
  if (!src) return;
  if (isVideoItem(item)) {
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
  var steward = collection.creator_ens || "dacatdreams.base.eth";
  note.innerHTML =
    "Originally minted on Rodeo. Contract on Base — stewarded by " +
    '<strong class="steward-name">' + escapeHtml(steward) + "</strong>.";
  note.hidden = false;
}

function renderStats(collection) {
  var strip = $("#stats-strip");
  strip.innerHTML = "";
  var defs = [
    { label: "Pieces", value: nvl(collection.piece_count, "—"), clickable: false },
    { label: "Collectors", value: statCollectorsValue(collection), clickable: true },
    { label: "Floor", value: formatEth(collection.floor_eth) + " " + (collection.floor_symbol || "ETH"), clickable: false },
    { label: "Listed", value: nvl(collection.listed_count, "—"), clickable: false },
  ];
  defs.forEach(function (s) {
    var el = document.createElement(s.clickable ? "button" : "div");
    el.className = "stat" + (s.clickable ? " stat-collectors" : "");
    el.innerHTML = '<span class="stat-value">' + s.value + '</span><span class="stat-label">' + s.label + "</span>";
    if (s.clickable) {
      el.type = "button";
      el.title = "View all collectors";
      el.setAttribute("aria-label", "View collectors");
      el.addEventListener("click", function () {
        if (collectorsList.length) openCollectorsModal();
      });
    }
    strip.appendChild(el);
  });
  renderHeroNote(collection);
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
  return (
    itemTitle(item).toLowerCase().indexOf(q) >= 0 ||
    (item.name || "").toLowerCase().indexOf(q) >= 0 ||
    (item.description || "").toLowerCase().indexOf(q) >= 0 ||
    (item.excerpt || "").toLowerCase().indexOf(q) >= 0 ||
    (item.local_slug || "").toLowerCase().indexOf(q) >= 0 ||
    String(item.token_id).indexOf(q) >= 0
  );
}

function compareItems(a, b) {
  var key = sortKey || "token_desc";
  if (key === "token_desc") return Number(b.token_id) - Number(a.token_id);
  if (key === "token_asc") return Number(a.token_id) - Number(b.token_id);
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

function getFilteredItems() {
  if (!galleryData || !galleryData.items) return [];
  var items = galleryData.items.slice();
  if (galleryCollectorView && galleryCollectorView.tokenIds) {
    items = items.filter(function (i) {
      return galleryCollectorView.tokenIds[String(i.token_id)];
    });
  }
  if (activeFilter === "listed") items = items.filter(function (i) { return i.listed; });
  if (activeFilter === "not_listed") items = items.filter(function (i) { return !i.listed; });
  if (activeFilter === "activity") items = items.filter(function (i) { return hasRecentActivity(i); });
  if (searchQuery) {
    var q = searchQuery.toLowerCase();
    items = items.filter(function (i) { return itemMatchesSearch(i, q); });
  }
  items.sort(compareItems);
  return items;
}

function resetBrowseView() {
  clearGalleryCollectorView({ clearResult: true });
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
  refreshView();
}

function renderBrowseMeta(filtered, total) {
  var countEl = $("#results-count");
  var chips = $("#active-filters");
  var clearBtn = $("#clear-filters");
  var panel = $("#browse-controls");
  if (countEl) {
    if (galleryCollectorView) {
      countEl.textContent =
        filtered +
        " shown · " +
        galleryCollectorView.pieceCount +
        " in " +
        galleryCollectorView.label +
        "'s collection";
    } else if (filtered === total) {
      countEl.textContent = total + " piece" + (total === 1 ? "" : "s") + " in the archive";
    } else {
      countEl.textContent =
        "Showing " + filtered + " of " + total + " — the rest are hiding in the noise";
    }
  }
  var parts = [];
  if (searchQuery) {
    parts.push({ key: "search", label: 'Search: "' + searchQuery + '"' });
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
  if (!chips || !clearBtn) return;
  if (!parts.length) {
    chips.hidden = true;
    chips.innerHTML = "";
    clearBtn.hidden = !galleryCollectorView;
    return;
  }
  chips.hidden = false;
  clearBtn.hidden = false;
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
        exitCollectorView({ clearResult: false, scrollGallery: false });
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

function renderFeatured(allItems) {
  var rail = $("#featured-rail");
  var track = $("#rail-track");
  var featured = allItems.filter(function (i) { return i.listed; }).slice(0, 10);
  if (!featured.length) {
    rail.hidden = true;
    return;
  }
  rail.hidden = false;
  track.innerHTML = "";
  featured.forEach(function (item) {
    var btn = document.createElement("button");
    btn.className = "rail-card";
    btn.type = "button";
    var slot = document.createElement("div");
    fillMediaSlot(slot, item);
    btn.appendChild(slot);
    var cap = document.createElement("div");
    cap.className = "rail-card-caption";
    cap.innerHTML = formatPieceTitleHtml(itemTitle(item));
    btn.appendChild(cap);
    btn.addEventListener("click", function () { openDetail(item); });
    track.appendChild(btn);
  });
}

function renderGallery(items) {
  var list = $("#gallery-list");
  var empty = $("#gallery-empty");
  if (!list) return;
  list.innerHTML = "";
  if (!items.length) {
    if (empty) {
      empty.hidden = false;
      var lead = empty.querySelector(".gallery-empty-lead");
      if (lead && galleryCollectorView) {
        lead.textContent =
          "Nothing matches for " +
          galleryCollectorView.label +
          " with the current filters — clear collector view or relax search.";
      } else if (lead) {
        lead.textContent = "The chaos is elsewhere — widen your search or clear a filter.";
      }
    }
    return;
  }
  if (empty) empty.hidden = true;
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
    var videoBadge = isVideoItem(item) ? '<span class="thumb-video-badge">▶</span>' : "";
    var excerpt = displayExcerpt(item);
    if (!excerpt && fullDataStatus === "loading_full") {
      excerpt = "Story loading from snapshot…";
    }
    row.innerHTML =
      '<div class="gallery-thumb-wrap"><div class="gallery-thumb-slot"></div>' + videoBadge + "</div>" +
      '<div class="gallery-meta"><h3>' + formatPieceTitleHtml(title) + "</h3><p>" + escapeHtml(excerpt || "No excerpt yet.") + "</p></div>" +
      '<div class="gallery-side"><span class="token-pill">#' + item.token_id + "</span>" + listedBadge + "</div>";
    fillMediaSlot(row.querySelector(".gallery-thumb-slot"), item, { controls: false });
    var thumb = row.querySelector(".gallery-thumb-slot img, .gallery-thumb-slot video");
    if (thumb && thumb.tagName === "IMG" && item.opensea_image_url && resolveMediaUrl(item.image_url) !== resolveMediaUrl(item.opensea_image_url)) {
      thumb.addEventListener("error", function () { thumb.src = resolveMediaUrl(item.opensea_image_url); }, { once: true });
    }
    row.addEventListener("click", function () { openDetail(item); });
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
  var currentAddr = currentOwnerAddress(item);
  chipsEl.innerHTML = holders
    .map(function (h) {
      var meta = addressDisplayMeta(h.address);
      var isCurrent = currentAddr && meta.address === currentAddr;
      var label = holderChipLabelHtml(meta) + " · " + h.quantity;
      if (isCurrent) label += ' <span class="owner-chip-note">· current</span>';
      return (
        '<span class="owner-chip-wrap">' +
        '<button type="button" class="owner-chip' +
        (isCurrent ? " owner-chip-current" : "") +
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
  renderDetailActivity(item);
  renderDetailOwners(item);
}

function openDetail(item) {
  closeCollectorsModal();
  activeDetailTokenId = item.token_id;
  var panel = $("#detail-panel");
  fillMediaSlot($("#detail-media-slot"), item, { autoplay: true, controls: true });
  $("#detail-title").innerHTML = formatPieceTitleHtml(itemTitle(item));
  $("#detail-token").textContent =
    "Token #" + item.token_id + (item.local_slug ? " · " + item.local_slug : "");
  var mintEl = $("#detail-mint");
  if (item.minted_at) {
    mintEl.hidden = false;
    mintEl.textContent = "First minted · " + formatMintDate(item.minted_at);
  } else {
    mintEl.hidden = true;
    mintEl.textContent = "";
  }
  var story = cleanStoryText(item);
  $("#detail-description").textContent = story || "No description.";
  $("#detail-opensea").href = item.opensea_url || "#";

  var badge = $("#detail-badge");
  if (item.listed) {
    badge.hidden = false;
    badge.textContent = item.listing ? "For sale · " + formatEth(item.listing.amount_eth) + " ETH" : "For sale";
  } else {
    badge.hidden = true;
  }

  var stats = $("#detail-stats");
  var chips = [];
  if (item.owners) {
    chips.push('<span class="chip"><strong>' + effectiveHolderCount(item) + "</strong> holders</span>");
    chips.push('<span class="chip"><strong>' + item.owners.circulating_copies + "</strong> copies</span>");
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
}

function refreshView() {
  if (!galleryData) return;
  var total = galleryData.items.length;
  var filtered = getFilteredItems();
  renderBrowseMeta(filtered.length, total);
  if (galleryCollectorView) {
    var rail = $("#featured-rail");
    if (rail) rail.hidden = true;
  } else {
    renderFeatured(galleryData.items);
  }
  renderGallery(filtered);
}

var searchDebounceTimer = null;

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
        refreshView();
      }, 120);
    });
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        searchInput.value = "";
        searchQuery = "";
        refreshView();
        searchInput.blur();
      }
    });
  }
  var sortSelect = $("#sort-select");
  if (sortSelect) {
    sortSelect.value = sortKey;
    sortSelect.addEventListener("change", function (e) {
      sortKey = e.target.value;
      refreshView();
    });
  }
  var clearBtn = $("#clear-filters");
  if (clearBtn) clearBtn.addEventListener("click", resetBrowseView);
  var emptyReset = $("#gallery-empty-reset");
  if (emptyReset) emptyReset.addEventListener("click", resetBrowseView);
  bindFreshnessToggle();
  bindCollectorExitUi();
  renderCollectorFocusUi();
  var cs = $("#collectors-search");
  if (cs) cs.addEventListener("input", function (e) { renderCollectors(e.target.value); });
  var viewBtn = $("#view-collectors-btn");
  if (viewBtn) viewBtn.addEventListener("click", openCollectorsModal);
  $("#collectors-modal-close").addEventListener("click", closeCollectorsModal);
  $("#collectors-modal-backdrop").addEventListener("click", closeCollectorsModal);
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

/** Turn loaded JSON into UI: clear loaders, stats, gallery rows, event handlers. */
function bootGallery(data) {
  galleryData = data;
  indexItems(galleryData);
  var loadEl = $("#load-state");
  if (loadEl) loadEl.hidden = true;
  renderStats(galleryData.collection);
  renderDataFreshness();
  bindUi();
  refreshView();
}

async function init() {
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
    galleryData = await loadCatalogFirst();
    dataSource = galleryData.source === "gallery_catalog" ? "catalog" : "full";
    bootGallery(galleryData);

    if (dataSource === "catalog") {
      refreshFullDataInBackground();
    } else {
      setFullDataStatus("live");
    }

    loadGalleryMeta().then(function () {
      renderDataFreshness();
      updateFooterMaintenance(galleryMeta);
    });

    loadWalletIndex().then(function () {
      renderStats(galleryData.collection);
      updateCollectorsButton();
      if (activeDetailTokenId) {
        var openItem = itemsById.get(String(activeDetailTokenId));
        if (openItem) refreshDetailPanel(openItem);
      }
      applyWalletFromUrl();
      applyPieceFromUrl();
    });

    if (window.location.hash === "#wallet-panel") {
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