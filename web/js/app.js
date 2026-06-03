const DATA_URL = "data/gallery_data.json";
const WALLET_URL = "data/wallet_index.json";

const $ = (sel, root = document) => root.querySelector(sel);

let galleryData = null;
let walletIndex = null;
let collectorsList = [];
let itemsById = new Map();
let activeFilter = "all";
let searchQuery = "";
let activeCollectorAddress = null;

function isFileProtocol() {
  return window.location.protocol === "file:";
}

function showFatalError(title, detail, cmd) {
  $("#load-state").hidden = true;
  const err = $("#load-error");
  err.hidden = false;
  err.innerHTML = `
    <p><strong>${title}</strong></p>
    <p>${detail}</p>
    ${cmd ? `<code>${cmd}</code>` : ""}
  `;
}

async function fetchJson(url, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadData() {
  if (isFileProtocol()) {
    throw new Error("FILE_PROTOCOL");
  }
  galleryData = await fetchJson(DATA_URL);
  if (galleryData.wallet_index_file) {
    try {
      const w = await fetchJson(WALLET_URL, 90000);
      walletIndex = w.holders_index || null;
      collectorsList = walletIndex?.collectors || buildCollectorsFromIndex(walletIndex);
    } catch (e) {
      console.warn("Wallet index load failed:", e);
      walletIndex = galleryData.holders_index || null;
      collectorsList = walletIndex?.collectors || buildCollectorsFromIndex(walletIndex);
    }
  } else {
    walletIndex = galleryData.holders_index || null;
    collectorsList = walletIndex?.collectors || buildCollectorsFromIndex(walletIndex);
  }
}

function buildCollectorsFromIndex(idx) {
  if (!idx?.by_address) return [];
  return Object.values(idx.by_address)
    .map((e) => ({
      address: e.address,
      ens_name: e.ens_name,
      username: e.username,
      unique_pieces: e.unique_pieces ?? e.holdings?.length ?? 0,
      collection_quantity: e.collection_quantity ?? 0,
    }))
    .sort((a, b) => b.unique_pieces - a.unique_pieces);
}

function formatEth(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const v = Number(n);
  if (v === 0) return "0";
  if (v < 0.01) return v.toFixed(4);
  return v.toFixed(3);
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

function itemTitle(item) {
  return item.display_name || item.local_slug || item.name || `Token #${item.token_id}`;
}

function isVideoItem(item) {
  if (item.media_type === "video") return true;
  const src = item.image_url || "";
  return /\.(mp4|mov|webm)(\?|$)/i.test(src);
}

function imgSrc(item) {
  return item.image_url || item.opensea_image_url || "";
}

function shortenAddress(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function holderLabel(address) {
  const entry = walletIndex?.by_address?.[address?.toLowerCase()];
  if (!entry) return shortenAddress(address);
  return entry.ens_name || entry.username || shortenAddress(address);
}

function isEthAddress(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

function isEnsName(v) {
  const s = v.trim().toLowerCase();
  return s.endsWith(".eth") && s.length > 4;
}

async function resolveEnsToAddress(name) {
  const url = `https://ensdata.net/${encodeURIComponent(name.trim())}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("ENS name could not be resolved.");
  const data = await res.json();
  const addr = data.address || data.wallets?.eth;
  if (!addr) throw new Error("No address found for this ENS name.");
  return addr.toLowerCase();
}

function lookupWallet(identifier) {
  if (!walletIndex?.by_address) {
    return { error: "Wallet index not loaded. Run: cd backend && python fetch_gallery_data.py" };
  }
  const raw = identifier.trim();
  let address = raw.toLowerCase();

  if (isEnsName(raw)) {
    const alias = walletIndex.ens_aliases?.[raw.toLowerCase()];
    if (alias) address = alias.toLowerCase();
    else return { needsResolve: true, ens: raw };
  } else if (!isEthAddress(raw)) {
    return { error: "Enter a valid ENS name (.eth) or 0x address." };
  }

  const entry = walletIndex.by_address[address];
  if (!entry) {
    return {
      error: "No daCommunity holdings found for that address in our index.",
      address,
    };
  }
  return { entry };
}

function renderHoldingsChips(holdings, container, { highlightTokenId } = {}) {
  container.innerHTML = "";
  const chips = holdings
    .map((h) => {
      const item = itemsById.get(String(h.token_id));
      const src = item ? imgSrc(item) : "";
      const name = h.display_name || h.name || itemTitle(item || {}) || `#${h.token_id}`;
      const hi = highlightTokenId && String(h.token_id) === String(highlightTokenId) ? " holding-chip-current" : "";
      return `<button type="button" class="holding-chip${hi}" data-token="${h.token_id}">
        ${src && !isVideoItem(item || {}) ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" />` : ""}
        <span>${escapeHtml(name)}</span>
      </button>`;
    })
    .join("");
  container.innerHTML = chips || "<span class='empty'>No pieces indexed.</span>";
  container.querySelectorAll(".holding-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = itemsById.get(String(btn.dataset.token));
      if (item) openDetail(item);
    });
  });
}

async function renderWalletLookup(identifier) {
  const resultEl = $("#wallet-result");
  resultEl.hidden = false;
  resultEl.innerHTML = `<p class="wallet-result empty">Looking up…</p>`;

  let lookup = lookupWallet(identifier);

  if (lookup.needsResolve) {
    try {
      const addr = await resolveEnsToAddress(lookup.ens);
      lookup = lookupWallet(addr);
    } catch (e) {
      resultEl.innerHTML = `<p class="wallet-result empty">${escapeHtml(e.message)}</p>`;
      return;
    }
  }

  if (lookup.error) {
    resultEl.innerHTML = `<p class="wallet-result empty">${escapeHtml(lookup.error)}</p>`;
    return;
  }

  const { entry } = lookup;
  const label = entry.ens_name || shortenAddress(entry.address);

  resultEl.innerHTML = `
    <div class="wallet-profile">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(entry.address)}</span>
      <span>${entry.unique_pieces ?? entry.holdings?.length ?? 0} unique pieces · ${entry.collection_quantity ?? "—"} total copies</span>
    </div>
    <div class="wallet-holdings" id="wallet-holdings-slot"></div>
  `;
  renderHoldingsChips(entry.holdings || [], $("#wallet-holdings-slot"));
}

function exploreCollector(address, highlightTokenId) {
  const entry = walletIndex?.by_address?.[address?.toLowerCase()];
  const explore = $("#collector-explore");
  if (!entry) {
    explore.hidden = true;
    return;
  }
  activeCollectorAddress = address.toLowerCase();
  $("#collector-explore-title").textContent = `Also held by ${holderLabel(address)}`;
  renderHoldingsChips(entry.holdings || [], $("#collector-explore-holdings"), { highlightTokenId });
  explore.hidden = false;
  document.querySelectorAll(".owner-chip").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.address === activeCollectorAddress);
  });
}

function renderCollectors(filter = "") {
  const panel = $("#collectors-panel");
  const list = $("#collectors-list");
  if (!collectorsList.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const q = filter.trim().toLowerCase();
  let rows = collectorsList;
  if (q) {
    rows = rows.filter(
      (c) =>
        (c.ens_name || "").toLowerCase().includes(q) ||
        (c.username || "").toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q)
    );
  }
  list.innerHTML = rows
    .map((c) => {
      const label = c.ens_name || c.username || shortenAddress(c.address);
      return `<button type="button" class="collector-row" data-address="${escapeHtml(c.address)}">
        <div>
          <strong>${escapeHtml(label)}</strong>
          <span class="meta">${escapeHtml(c.address)}</span>
        </div>
        <span class="count">${c.unique_pieces} piece${c.unique_pieces === 1 ? "" : "s"}</span>
      </button>`;
    })
    .join("");
  list.querySelectorAll(".collector-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      const addr = btn.dataset.address;
      $("#wallet-input").value = addr;
      renderWalletLookup(addr);
      $("#wallet-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function fillMediaSlot(slot, item, { autoplay = false } = {}) {
  slot.innerHTML = "";
  const src = imgSrc(item);
  if (!src) return;
  if (isVideoItem(item)) {
    const v = document.createElement("video");
    v.src = src;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.controls = true;
    if (autoplay) v.autoplay = true;
    v.setAttribute("aria-label", itemTitle(item));
    slot.appendChild(v);
  } else {
    const img = document.createElement("img");
    img.src = src;
    img.alt = itemTitle(item);
    if (item.opensea_image_url && item.image_url !== item.opensea_image_url) {
      img.addEventListener(
        "error",
        () => {
          img.src = item.opensea_image_url;
        },
        { once: true }
      );
    }
    slot.appendChild(img);
  }
}

function renderStats(collection) {
  const strip = $("#stats-strip");
  strip.innerHTML = "";
  [
    { label: "Pieces", value: collection.piece_count ?? "—" },
    { label: "Collectors", value: collection.num_owners ?? collectorsList.length || "—" },
    { label: "Floor", value: `${formatEth(collection.floor_eth)} ${collection.floor_symbol || "ETH"}` },
    { label: "Listed", value: collection.listed_count ?? "—" },
  ].forEach((s) => {
    const el = document.createElement("div");
    el.className = "stat";
    el.innerHTML = `<span class="stat-value">${s.value}</span><span class="stat-label">${s.label}</span>`;
    strip.appendChild(el);
  });

  const note = $("#hero-note");
  if (collection.note) {
    note.textContent = collection.note;
    note.hidden = false;
  }
}

function getFilteredItems() {
  let items = [...galleryData.items];
  if (activeFilter === "listed") items = items.filter((i) => i.listed);
  if (activeFilter === "recent") items.sort((a, b) => Number(b.token_id) - Number(a.token_id));
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    items = items.filter(
      (i) =>
        itemTitle(i).toLowerCase().includes(q) ||
        (i.description || "").toLowerCase().includes(q) ||
        (i.local_slug || "").toLowerCase().includes(q) ||
        String(i.token_id).includes(q)
    );
  }
  return items;
}

function renderFeatured(allItems) {
  const rail = $("#featured-rail");
  const track = $("#rail-track");
  const featured = allItems.filter((i) => i.listed).slice(0, 10);
  if (!featured.length) {
    rail.hidden = true;
    return;
  }
  rail.hidden = false;
  track.innerHTML = "";
  for (const item of featured) {
    const btn = document.createElement("button");
    btn.className = "rail-card";
    btn.type = "button";
    const slot = document.createElement("div");
    fillMediaSlot(slot, item);
    btn.appendChild(slot);
    const cap = document.createElement("span");
    cap.textContent = itemTitle(item);
    btn.appendChild(cap);
    btn.addEventListener("click", () => openDetail(item));
    track.appendChild(btn);
  }
}

function renderGallery(items) {
  const list = $("#gallery-list");
  list.innerHTML = "";
  items.forEach((item, idx) => {
    const row = document.createElement("button");
    row.className = "gallery-row";
    row.type = "button";
    row.style.animationDelay = `${Math.min(idx * 0.025, 0.75)}s`;
    const title = itemTitle(item);
    const listedBadge = item.listed
      ? `<span class="badge-listed">${item.listing ? formatEth(item.listing.amount_eth) + " ETH" : "Listed"}</span>`
      : "";
    const slug = item.local_slug ? `<span class="slug-pill">${escapeHtml(item.local_slug)}</span>` : "";
    const videoBadge = isVideoItem(item) ? `<span class="thumb-video-badge">▶</span>` : "";
    row.innerHTML = `
      <div class="gallery-thumb-wrap">
        <div class="gallery-thumb-slot"></div>
        ${videoBadge}
      </div>
      <div class="gallery-meta">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(item.excerpt || "")}</p>
        ${slug}
      </div>
      <div class="gallery-side">
        <span class="token-pill">#${item.token_id}</span>
        ${listedBadge}
      </div>
    `;
    fillMediaSlot(row.querySelector(".gallery-thumb-slot"), item);
    const thumb = row.querySelector(".gallery-thumb-slot img, .gallery-thumb-slot video");
    if (thumb?.tagName === "IMG" && item.opensea_image_url && item.image_url !== item.opensea_image_url) {
      thumb.addEventListener("error", () => {
        thumb.src = item.opensea_image_url;
      }, { once: true });
    }
    row.addEventListener("click", () => openDetail(item));
    list.appendChild(row);
  });
}

function renderDetailOwners(item) {
  const ownersBlock = $("#detail-owners");
  const chipsEl = $("#detail-owner-chips");
  const explore = $("#collector-explore");
  explore.hidden = true;
  activeCollectorAddress = null;

  const holders = item.owners?.top_holders || [];
  if (!holders.length) {
    ownersBlock.hidden = true;
    return;
  }
  ownersBlock.hidden = false;
  chipsEl.innerHTML = holders
    .map(
      (h) =>
        `<button type="button" class="owner-chip" data-address="${escapeHtml(h.address)}">
          ${escapeHtml(holderLabel(h.address))} · ${h.quantity}
        </button>`
    )
    .join("");
  chipsEl.querySelectorAll(".owner-chip").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      exploreCollector(btn.dataset.address, item.token_id);
    });
  });
}

function openDetail(item) {
  const panel = $("#detail-panel");
  fillMediaSlot($("#detail-media-slot"), item, { autoplay: true });

  $("#detail-title").textContent = itemTitle(item);
  $("#detail-token").textContent = `Token #${item.token_id}${item.local_slug ? " · " + item.local_slug : ""} · Base`;
  $("#detail-description").textContent = item.description || "No description.";
  $("#detail-opensea").href = item.opensea_url || "#";

  const badge = $("#detail-badge");
  if (item.listed) {
    badge.hidden = false;
    badge.textContent = item.listing
      ? `For sale · ${formatEth(item.listing.amount_eth)} ETH`
      : "For sale";
  } else {
    badge.hidden = true;
  }

  const stats = $("#detail-stats");
  const chips = [];
  if (item.owners) {
    chips.push(`<span class="chip"><strong>${item.owners.holder_count}</strong> holders</span>`);
    chips.push(`<span class="chip"><strong>${item.owners.circulating_copies}</strong> copies</span>`);
  }
  if (item.listed && item.listing) {
    chips.push(`<span class="chip">List <strong>${formatEth(item.listing.amount_eth)} ETH</strong></span>`);
  }
  stats.innerHTML = chips.join("") || `<span class="chip">Community piece</span>`;

  renderDetailOwners(item);

  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeDetail() {
  const panel = $("#detail-panel");
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  $("#collector-explore").hidden = true;
}

function refreshView() {
  renderFeatured(galleryData.items);
  renderGallery(getFilteredItems());
}

function bindUi() {
  document.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      activeFilter = btn.dataset.filter;
      refreshView();
    });
  });

  $("#search").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    refreshView();
  });

  $("#collectors-search")?.addEventListener("input", (e) => {
    renderCollectors(e.target.value);
  });

  $("#wallet-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("#wallet-input").value.trim();
    if (v) renderWalletLookup(v);
  });

  $("#detail-close").addEventListener("click", closeDetail);
  $("#detail-backdrop").addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });
}

async function init() {
  if (isFileProtocol()) {
    showFatalError(
      "Open the gallery through the local server",
      "Double-clicking index.html blocks data loading (browser security). Use the starter script instead.",
      "Double-click start-gallery.bat  →  open http://localhost:8080"
    );
    return;
  }

  try {
    await loadData();
    galleryData.items.forEach((i) => {
      if (!i.display_name) {
        i.display_name = i.local_slug || (i.name?.toLowerCase().startsWith("dacat.") ? i.name : null);
      }
      if (!i.opensea_image_url && i.image_url?.startsWith("http")) {
        i.opensea_image_url = i.image_url;
      }
      if (/\.(mov|mp4|webm)(\?|$)/i.test(i.image_url || "") && !i.media_type) {
        i.media_type = "video";
      }
      itemsById.set(String(i.token_id), i);
    });

    $("#load-state").hidden = true;
    renderStats(galleryData.collection);
    $("#footer-updated").textContent = new Date(galleryData.generated_at).toLocaleString();
    renderCollectors();
    bindUi();
    refreshView();

    if (!walletIndex) {
      const panel = $("#wallet-panel");
      const warn = document.createElement("p");
      warn.className = "hero-note";
      warn.textContent =
        "Wallet lookup needs a full refresh: cd backend → python fetch_gallery_data.py";
      panel.appendChild(warn);
    }
  } catch (err) {
    console.error(err);
    if (err.message === "FILE_PROTOCOL") return;
    showFatalError(
      "Could not load gallery data",
      err.message || String(err),
      "cd backend && python fetch_gallery_data.py && python merge_local_images.py"
    );
  }
}

init();