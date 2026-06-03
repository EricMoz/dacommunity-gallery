const DATA_URL = "data/gallery_data.json";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let galleryData = null;
let itemsById = new Map();
let activeFilter = "all";
let searchQuery = "";

async function loadData() {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`Failed to load ${DATA_URL}`);
  return res.json();
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

function normalizeAddress(addr) {
  return addr.trim().toLowerCase();
}

function lookupWallet(identifier) {
  const index = galleryData?.holders_index;
  if (!index?.by_address) {
    return { error: "Wallet index not loaded. Run a full data refresh (without --quick)." };
  }

  const raw = identifier.trim();
  let address = raw.toLowerCase();

  if (isEnsName(raw)) {
    const alias = index.ens_aliases?.[raw.toLowerCase()];
    if (alias) address = alias;
    else return { needsResolve: true, ens: raw };
  } else if (!isEthAddress(raw)) {
    return { error: "Enter a valid ENS name (.eth) or 0x address." };
  }

  const entry = index.by_address[address];
  if (!entry) {
    return {
      error: "No holdings in this collection for that address (or not in the last index build).",
      address,
    };
  }
  return { entry };
}

async function renderWalletLookup(identifier) {
  const resultEl = $("#wallet-result");
  resultEl.hidden = false;
  resultEl.innerHTML = `<p class="wallet-result loading">Looking up…</p>`;

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
      const item = itemsById.get(h.token_id);
      const img = h.image_url || item?.image_url || "";
      const name = h.name || item?.name || `#${h.token_id}`;
      return `<button type="button" class="holding-chip" data-token="${h.token_id}">
        <img src="${escapeHtml(img)}" alt="" loading="lazy" />
        <span>${escapeHtml(name)}</span>
      </button>`;
    })
    .join("");

  resultEl.innerHTML = `
    <div class="wallet-profile">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(entry.address)}</span>
      <span>${entry.unique_pieces ?? holdings.length} pieces · ${entry.collection_quantity ?? "—"} copies in collection</span>
    </div>
    <div class="wallet-holdings">${chips || "<span class='empty'>No pieces indexed.</span>"}</div>
  `;

  resultEl.querySelectorAll(".holding-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = itemsById.get(btn.dataset.token);
      if (item) openDetail(item);
    });
  });
}

function renderStats(collection) {
  const strip = $("#stats-strip");
  strip.innerHTML = "";
  const stats = [
    { label: "Pieces", value: collection.piece_count ?? "—" },
    { label: "Collectors", value: collection.num_owners ?? "—" },
    { label: "Floor", value: `${formatEth(collection.floor_eth)} ${collection.floor_symbol || "ETH"}` },
    { label: "Listed", value: collection.listed_count ?? "—" },
  ];
  for (const s of stats) {
    const el = document.createElement("div");
    el.className = "stat";
    el.innerHTML = `<span class="stat-value">${s.value}</span><span class="stat-label">${s.label}</span>`;
    strip.appendChild(el);
  }

  const note = $("#hero-note");
  if (collection.note) {
    note.textContent = collection.note;
    note.hidden = false;
  }
}

function getFilteredItems() {
  let items = [...galleryData.items];
  if (activeFilter === "listed") items = items.filter((i) => i.listed);
  if (activeFilter === "recent") {
    items.sort((a, b) => Number(b.token_id) - Number(a.token_id));
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    items = items.filter(
      (i) =>
        (i.name || "").toLowerCase().includes(q) ||
        (i.description || "").toLowerCase().includes(q) ||
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
    btn.innerHTML = `<img src="${item.image_url}" alt="" loading="lazy" /><span>${escapeHtml(item.name)}</span>`;
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
    row.innerHTML = `
      <div class="gallery-thumb-wrap">
        <img class="gallery-thumb" src="${item.image_url}" alt="" loading="lazy" />
      </div>
      <div class="gallery-meta">
        <h3>${escapeHtml(item.name)}</h3>
        <p>${escapeHtml(item.excerpt || "")}</p>
      </div>
      <div class="gallery-side">
        <span class="token-pill">#${item.token_id}</span>
        ${listedBadge}
      </div>
    `;
    row.addEventListener("click", () => openDetail(item));
    list.appendChild(row);
  });
}

function openDetail(item) {
  const panel = $("#detail-panel");
  $("#detail-image").src = item.image_url || "";
  $("#detail-image").alt = item.name || "";
  $("#detail-title").textContent = item.name || "";
  $("#detail-token").textContent = `Token #${item.token_id} · ERC-1155 · Base`;
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
  stats.innerHTML = chips.join("") || `<span class="chip">OpenSea metadata</span>`;

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
  const items = getFilteredItems();
  renderFeatured(galleryData.items);
  renderGallery(items);
}

function bindUi() {
  $$(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".filter").forEach((b) => {
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
  try {
    galleryData = await loadData();
    galleryData.items.forEach((i) => itemsById.set(i.token_id, i));
    $("#load-state").hidden = true;
    renderStats(galleryData.collection);
    $("#footer-updated").textContent = new Date(galleryData.generated_at).toLocaleString();
    bindUi();
    refreshView();

    if (!galleryData.holders_index) {
      $("#wallet-panel").insertAdjacentHTML(
        "beforeend",
        `<p class="hero-note" style="margin-top:0.75rem">Wallet index missing — run <code>python fetch_gallery_data.py</code> (full refresh) for collector lookup.</p>`
      );
    }
  } catch (err) {
    console.error(err);
    $("#load-state").hidden = true;
    $("#load-error").hidden = false;
  }
}

init();