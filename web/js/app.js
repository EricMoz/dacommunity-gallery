/* daCommunity Gallery — ES5-safe operators (no ??), hybrid catalog + background refresh */

const CATALOG_URL = "data/gallery_catalog.json";
const FULL_DATA_URL = "data/gallery_data.json";
const WALLET_URL = "data/wallet_index.json";

const $ = (sel, root = document) => root.querySelector(sel);

let galleryData = null;
let walletIndex = null;
let collectorsList = [];
let itemsById = new Map();
let activeFilter = "all";
let searchQuery = "";
let dataSource = "catalog";
let activeCollectorAddress = null;

function isFileProtocol() {
  return window.location.protocol === "file:";
}

function nvl(value, fallback) {
  return value !== undefined && value !== null ? value : fallback;
}

function showFatalError(title, detail, cmd) {
  $("#load-state").hidden = true;
  const err = $("#load-error");
  err.hidden = false;
  err.innerHTML =
    "<p><strong>" + escapeHtml(title) + "</strong></p><p>" + escapeHtml(detail) + "</p>" +
    (cmd ? "<code>" + escapeHtml(cmd) + "</code>" : "");
}

function showStaleBanner() {
  let el = $("#data-stale-banner");
  if (!el) {
    el = document.createElement("p");
    el.id = "data-stale-banner";
    el.className = "hero-note";
    const hero = document.querySelector(".hero-inner");
    if (hero) hero.appendChild(el);
  }
  el.textContent = "Showing saved gallery snapshot. Live data refresh in background…";
  el.hidden = false;
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
    if (fullItem.listed !== undefined) cur.listed = fullItem.listed;
    if (fullItem.listing) cur.listing = fullItem.listing;
    if (fullItem.generated_at) galleryData.generated_at = full.generated_at;
  });
  dataSource = "live";
  const banner = $("#data-stale-banner");
  if (banner) banner.hidden = true;
  $("#footer-updated").textContent = new Date(galleryData.generated_at).toLocaleString();
  renderStats(galleryData.collection);
  refreshView();
}

async function loadCatalogFirst() {
  if (isFileProtocol()) throw new Error("FILE_PROTOCOL");
  try {
    return await fetchJson(CATALOG_URL, 12000);
  } catch (e1) {
    console.warn("Catalog fetch failed, trying full data:", e1);
    return await fetchJson(FULL_DATA_URL, 20000);
  }
}

async function refreshFullDataInBackground() {
  try {
    const full = await fetchJson(FULL_DATA_URL, 25000);
    mergeFullDescriptions(full);
    galleryData.generated_at = full.generated_at;
    galleryData.collection = full.collection;
  } catch (e) {
    console.warn("Background full data refresh failed:", e);
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

function isVideoItem(item) {
  if (item.media_type === "video") return true;
  return /\.(mp4|mov|webm)(\?|$)/i.test(item.image_url || "");
}

function imgSrc(item) {
  return item.image_url || item.opensea_image_url || "";
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
    return { error: "Collector index still loading — try again in a moment." };
  }
  var raw = identifier.trim();
  var address = raw.toLowerCase();

  if (isEnsName(raw)) {
    var alias = walletIndex.ens_aliases && walletIndex.ens_aliases[raw.toLowerCase()];
    if (alias) address = alias.toLowerCase();
    else return { needsResolve: true, ens: raw };
  } else if (!isEthAddress(raw)) {
    return { error: "Enter a valid ENS name (.eth) or 0x address." };
  }

  var entry = walletIndex.by_address[address];
  if (!entry) {
    return { error: "No daCommunity holdings found for that address in our index.", address: address };
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

async function renderWalletLookup(identifier) {
  var resultEl = $("#wallet-result");
  resultEl.hidden = false;
  resultEl.innerHTML = '<p class="wallet-result empty">Looking up…</p>';

  var lookup = lookupWallet(identifier);

  if (lookup.needsResolve) {
    try {
      var addr = await resolveEnsToAddress(lookup.ens);
      lookup = lookupWallet(addr);
    } catch (e) {
      resultEl.innerHTML = '<p class="wallet-result empty">' + escapeHtml(e.message) + "</p>";
      return;
    }
  }

  if (lookup.error) {
    resultEl.innerHTML = '<p class="wallet-result empty">' + escapeHtml(lookup.error) + "</p>";
    return;
  }

  var entry = lookup.entry;
  var label = entry.ens_name || shortenAddress(entry.address);
  var holdings = entry.holdings || [];
  var uq = nvl(entry.unique_pieces, holdings.length);
  var qty = nvl(entry.collection_quantity, "—");

  resultEl.innerHTML =
    '<div class="wallet-profile">' +
    '<p class="wallet-profile-name"><strong>' + escapeHtml(label) + "</strong></p>" +
    '<p class="wallet-profile-address">' + escapeHtml(entry.address) + "</p>" +
    '<p class="wallet-profile-stats">' + uq + " unique pieces · " + qty + " total copies</p>" +
    "</div>" +
    '<div class="wallet-holdings" id="wallet-holdings-slot"></div>';
  renderHoldingsChips(holdings, $("#wallet-holdings-slot"));
}

function updateCollectorsButton() {
  var btn = $("#view-collectors-btn");
  if (btn) btn.hidden = !collectorsList.length;
  document.querySelectorAll(".stat-collectors").forEach(function (el) {
    el.disabled = !collectorsList.length;
    el.style.opacity = collectorsList.length ? "1" : "0.55";
  });
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
  var entry = walletIndex && walletIndex.by_address && walletIndex.by_address[address.toLowerCase()];
  var explore = $("#collector-explore");
  if (!entry) {
    explore.hidden = true;
    return;
  }
  activeCollectorAddress = address.toLowerCase();
  $("#collector-explore-title").textContent = "Also held by " + holderLabel(address);
  renderHoldingsChips(entry.holdings || [], $("#collector-explore-holdings"), { highlightTokenId: highlightTokenId });
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
      $("#wallet-input").value = btn.dataset.address;
      renderWalletLookup(btn.dataset.address);
      $("#wallet-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
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
    if (item.opensea_image_url && item.image_url !== item.opensea_image_url) {
      img.addEventListener("error", function () { img.src = item.opensea_image_url; }, { once: true });
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

function getFilteredItems() {
  var items = galleryData.items.slice();
  if (activeFilter === "listed") items = items.filter(function (i) { return i.listed; });
  if (activeFilter === "recent") items.sort(function (a, b) { return Number(b.token_id) - Number(a.token_id); });
  if (searchQuery) {
    var q = searchQuery.toLowerCase();
    var steward = collectionStewardLabel().toLowerCase();
    if (q && steward.indexOf(q) >= 0) {
      return items;
    }
    items = items.filter(function (i) {
      return (
        itemTitle(i).toLowerCase().indexOf(q) >= 0 ||
        (i.description || "").toLowerCase().indexOf(q) >= 0 ||
        (i.excerpt || "").toLowerCase().indexOf(q) >= 0 ||
        (i.local_slug || "").toLowerCase().indexOf(q) >= 0 ||
        String(i.token_id).indexOf(q) >= 0
      );
    });
  }
  return items;
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
    var cap = document.createElement("span");
    cap.innerHTML = formatPieceTitleHtml(itemTitle(item));
    btn.appendChild(cap);
    btn.addEventListener("click", function () { openDetail(item); });
    track.appendChild(btn);
  });
}

function renderGallery(items) {
  var list = $("#gallery-list");
  list.innerHTML = "";
  items.forEach(function (item, idx) {
    var row = document.createElement("button");
    row.className = "gallery-row";
    row.type = "button";
    row.style.animationDelay = Math.min(idx * 0.025, 0.75) + "s";
    var title = itemTitle(item);
    var listedBadge = item.listed
      ? '<span class="badge-listed">' + (item.listing ? formatEth(item.listing.amount_eth) + " ETH" : "Listed") + "</span>"
      : "";
    var videoBadge = isVideoItem(item) ? '<span class="thumb-video-badge">▶</span>' : "";
    row.innerHTML =
      '<div class="gallery-thumb-wrap"><div class="gallery-thumb-slot"></div>' + videoBadge + "</div>" +
      '<div class="gallery-meta"><h3>' + formatPieceTitleHtml(title) + "</h3><p>" + escapeHtml(item.excerpt || "") + "</p></div>" +
      '<div class="gallery-side"><span class="token-pill">#' + item.token_id + "</span>" + listedBadge + "</div>";
    fillMediaSlot(row.querySelector(".gallery-thumb-slot"), item, { controls: false });
    var thumb = row.querySelector(".gallery-thumb-slot img, .gallery-thumb-slot video");
    if (thumb && thumb.tagName === "IMG" && item.opensea_image_url && item.image_url !== item.opensea_image_url) {
      thumb.addEventListener("error", function () { thumb.src = item.opensea_image_url; }, { once: true });
    }
    row.addEventListener("click", function () { openDetail(item); });
    list.appendChild(row);
  });
}

function renderDetailOwners(item) {
  var ownersBlock = $("#detail-owners");
  var chipsEl = $("#detail-owner-chips");
  var explore = $("#collector-explore");
  explore.hidden = true;
  activeCollectorAddress = null;
  var holders = (item.owners && item.owners.top_holders) || [];
  if (!holders.length) {
    ownersBlock.hidden = true;
    return;
  }
  ownersBlock.hidden = false;
  chipsEl.innerHTML = holders
    .map(function (h) {
      return (
        '<button type="button" class="owner-chip" data-address="' + escapeHtml(h.address) + '">' +
        escapeHtml(holderLabel(h.address)) + " · " + h.quantity + "</button>"
      );
    })
    .join("");
  chipsEl.querySelectorAll(".owner-chip").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      exploreCollector(btn.dataset.address, item.token_id);
    });
  });
}

function openDetail(item) {
  closeCollectorsModal();
  var panel = $("#detail-panel");
  fillMediaSlot($("#detail-media-slot"), item, { autoplay: true, controls: true });
  $("#detail-title").innerHTML = formatPieceTitleHtml(itemTitle(item));
  $("#detail-token").textContent =
    "Token #" + item.token_id + (item.local_slug ? " · " + item.local_slug : "") + " · Base";
  $("#detail-description").textContent = item.description || item.excerpt || "No description.";
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
    chips.push('<span class="chip"><strong>' + item.owners.holder_count + "</strong> holders</span>");
    chips.push('<span class="chip"><strong>' + item.owners.circulating_copies + "</strong> copies</span>");
  }
  if (item.listed && item.listing) {
    chips.push('<span class="chip">List <strong>' + formatEth(item.listing.amount_eth) + " ETH</strong></span>");
  }
  stats.innerHTML = chips.length ? chips.join("") : '<span class="chip">Community piece</span>';
  renderDetailOwners(item);
  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeDetail() {
  var panel = $("#detail-panel");
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
  if (!$("#collectors-modal").classList.contains("open")) {
    document.body.style.overflow = "";
  }
  $("#collector-explore").hidden = true;
}

function refreshView() {
  renderFeatured(galleryData.items);
  renderGallery(getFilteredItems());
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
      refreshView();
    });
  });
  $("#search").addEventListener("input", function (e) {
    searchQuery = e.target.value.trim();
    refreshView();
  });
  var cs = $("#collectors-search");
  if (cs) cs.addEventListener("input", function (e) { renderCollectors(e.target.value); });
  var viewBtn = $("#view-collectors-btn");
  if (viewBtn) viewBtn.addEventListener("click", openCollectorsModal);
  $("#collectors-modal-close").addEventListener("click", closeCollectorsModal);
  $("#collectors-modal-backdrop").addEventListener("click", closeCollectorsModal);
  $("#wallet-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("#wallet-input").value.trim();
    if (v) renderWalletLookup(v);
  });
  $("#detail-close").addEventListener("click", closeDetail);
  $("#detail-backdrop").addEventListener("click", closeDetail);
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if ($("#collectors-modal").classList.contains("open")) {
      closeCollectorsModal();
      return;
    }
    closeDetail();
  });
}

function bootGallery(data) {
  galleryData = data;
  indexItems(galleryData);
  $("#load-state").hidden = true;
  renderStats(galleryData.collection);
  $("#footer-updated").textContent = new Date(galleryData.generated_at).toLocaleString();
  bindUi();
  refreshView();
}

async function init() {
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
      showStaleBanner();
      refreshFullDataInBackground();
    }

    loadWalletIndex().then(function () {
      renderStats(galleryData.collection);
      updateCollectorsButton();
    });
  } catch (err) {
    console.error(err);
    if (err.message === "FILE_PROTOCOL") return;
    showFatalError("Could not load gallery data", err.message || String(err), "Run: cd backend && python build_catalog.py");
  }
}

init();