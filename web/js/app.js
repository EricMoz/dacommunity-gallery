const DATA_URL = "data/gallery_data.json";
const WALLET_URL = "data/wallet_index.json";

const $ = (sel, root = document) => root.querySelector(sel);

let galleryData = null;
let walletIndex = null;
let itemsById = new Map();
let activeFilter = "all";
let searchQuery = "";

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
    } catch (e) {
      console.warn("Wallet index load failed:", e);
      walletIndex = galleryData.holders_index || null;
    }
  } else {
    walletIndex = galleryData.holders_index || null;
  }
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

function imgSrc(item) {
  return item.image_url || item.opensea_image_url || "";
}

function shortenAddress(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
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
  const holdings = entry.holdings || [];

  const chips = holdings
    .map((h) => {
      const item = itemsById.get(String(h.token_id));
      const src = item ? imgSrc(item) : "";
      const name = h.name || item?.name || `#${h.token_id}`;
      return `<button type="button" class="holding-chip" data-token="${h.token_id}">
        ${src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" />` : ""}
        <span>${escapeHtml(name)}</span>
      </button>`;
    })
    .join("");

  resultEl.innerHTML = `
    <div class="wallet-profile">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(entry.address)}</span>
      <span>${entry.unique_pieces ?? holdings.length} unique pieces · ${entry.collection_quantity ?? "—"} total copies</span>
    </div>
    <div class="wallet-holdings">${chips || "<span class='empty'>No pieces indexed.</span>"}</div>
  `;

  resultEl.querySelectorAll(".holding-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = itemsById.get(String(btn.dataset.token));
      if (item) openDetail(item);
    });
  });
}

function renderStats(collection) {
  const strip = $("#stats-strip");
  strip.innerHTML = "";
  [
    { label: "Pieces", value: collection.piece_count ?? "—" },
    { label: "Collectors", value: collection.num_owners ?? "—" },
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
        (i.name || "").toLowerCase().includes(q) ||
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
    btn.innerHTML = `<img src="${escapeHtml(imgSrc(item))}" alt="" loading="lazy" onerror="this.style.opacity=0.3" /><span>${escapeHtml(item.name)}</span>`;
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
    const listedBadge = item.listed
      ? `<span class="badge-listed">${item.listing ? formatEth(item.listing.amount_eth) + " ETH" : "Listed"}</span>`
      : "";
    const slug = item.local_slug ? `<span class="slug-pill">${escapeHtml(item.local_slug)}</span>` : "";
    row.innerHTML = `
      <div class="gallery-thumb-wrap">
        <img class="gallery-thumb" src="${escapeHtml(imgSrc(item))}" alt="" loading="lazy" />
      </div>
      <div class="gallery-meta">
        <h3>${escapeHtml(item.name)}</h3>
        <p>${escapeHtml(item.excerpt || "")}</p>
        ${slug}
      </div>
      <div class="gallery-side">
        <span class="token-pill">#${item.token_id}</span>
        ${listedBadge}
      </div>
    `;
    const img = row.querySelector(".gallery-thumb");
    if (item.opensea_image_url && item.image_url !== item.opensea_image_url) {
      img.addEventListener("error", () => {
        img.src = item.opensea_image_url;
      }, { once: true });
    }
    row.addEventListener("click", () => openDetail(item));
    list.appendChild(row);
  });
}

function openDetail(item) {
  const panel = $("#detail-panel");
  const img = $("#detail-image");
  img.src = imgSrc(item);
  if (item.opensea_image_url) {
    img.onerror = () => {
      img.src = item.opensea_image_url;
      img.onerror = null;
    };
  }
  img.alt = item.name || "";
  $("#detail-title").textContent = item.name || "";
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

  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeDetail() {
  const panel = $("#detail-panel");
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
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
      if (!i.opensea_image_url && i.image_url?.startsWith("http")) {
        i.opensea_image_url = i.image_url;
      }
      itemsById.set(String(i.token_id), i);
    });

    $("#load-state").hidden = true;
    renderStats(galleryData.collection);
    $("#footer-updated").textContent = new Date(galleryData.generated_at).toLocaleString();
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