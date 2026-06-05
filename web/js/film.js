/**
 * daCAT Film theater — catalog grid, filters, modal player, random-next-on-end.
 */
(function () {
  "use strict";

  const DATA_URL = new URL("../data/videos.json", window.location.href).href;
  const YT_ORIGIN = window.location.origin;

  const els = {
    rows: document.getElementById("film-rows"),
    featured: document.getElementById("film-featured"),
    featuredGrid: document.getElementById("film-featured-grid"),
    search: document.getElementById("film-search"),
    filters: document.getElementById("film-filters"),
    stats: document.getElementById("film-stats"),
    loading: document.getElementById("film-loading"),
    empty: document.getElementById("film-empty"),
    modal: document.getElementById("film-modal"),
    modalBackdrop: document.querySelector(".film-modal-backdrop"),
    modalClose: document.querySelector(".film-modal-close"),
    playerHost: document.getElementById("film-player-host"),
    playerLoading: document.getElementById("film-player-loading"),
    modalTitle: document.getElementById("film-modal-title"),
    modalSeries: document.getElementById("film-modal-series"),
    modalType: document.getElementById("film-modal-type"),
    modalCreator: document.getElementById("film-modal-creator"),
    modalDuration: document.getElementById("film-modal-duration"),
    modalWhat: document.getElementById("film-modal-what"),
    modalRelease: document.getElementById("film-modal-release"),
    modalDesc: document.getElementById("film-modal-desc"),
    modalYtLink: document.getElementById("film-modal-yt"),
    modalDedicated: document.getElementById("film-modal-dedicated"),
  };

  let catalog = null;
  let videos = [];
  let activeFilter = "all";
  let searchQuery = "";
  let currentVideoId = null;
  let ytPlayer = null;
  let ytApiReady = false;
  let pendingVideoId = null;

  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) {
      ytApiReady = true;
      return;
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      ytApiReady = true;
      if (typeof prev === "function") prev();
      if (pendingVideoId) playInModal(pendingVideoId);
    };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      document.head.appendChild(tag);
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalize(s) {
    return (s || "").toLowerCase().trim();
  }

  function getFilterDef(id) {
    return (catalog.filters || []).find((f) => f.id === id);
  }

  function matchesSearch(video) {
    if (!searchQuery) return true;
    const hay = [
      video.title,
      video.series,
      video.type,
      video.creator,
      video.description,
      video.whatItIs,
      video.duration,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(searchQuery);
  }

  function matchesFilter(video) {
    if (activeFilter === "all") return true;
    const def = getFilterDef(activeFilter);
    if (def && def.matchSeries) return video.series === def.matchSeries;
    return video.filterCategory === activeFilter;
  }

  function visibleVideos() {
    return videos.filter((v) => matchesFilter(v) && matchesSearch(v));
  }

  function sortVideos(list) {
    return list.slice().sort((a, b) => {
      const so = (a.sortOrder || 0) - (b.sortOrder || 0);
      if (so !== 0) return so;
      return a.title.localeCompare(b.title);
    });
  }

  function createCard(video, opts) {
    const featured = opts && opts.featured;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "film-vcard" + (featured ? " film-vcard--featured" : "");
    btn.dataset.videoId = video.id;
    btn.setAttribute("aria-label", `Play ${video.title}, ${video.duration}`);
    const duration = video.duration || "—";
    btn.innerHTML = `
      <span class="film-vcard-thumb">
        <img src="${escapeHtml(video.thumbnail)}" alt="" loading="lazy" width="480" height="360" />
        <span class="film-vcard-play" aria-hidden="true"></span>
        <span class="film-vcard-duration">${escapeHtml(duration)}</span>
      </span>
      <span class="film-vcard-body">
        <span class="film-vcard-series">${escapeHtml(video.series)}</span>
        <span class="film-vcard-title">${escapeHtml(video.title)}</span>
        <span class="film-vcard-creator">${escapeHtml(video.creator)}</span>
      </span>
    `;
    btn.addEventListener("click", () => openModal(video.id));
    return btn;
  }

  function renderSection(seriesName, list, target) {
    if (!list.length) return;
    const section = document.createElement("section");
    section.className = "film-series-section";
    section.dataset.series = seriesName;
    const count = list.length;
    section.innerHTML = `
      <header class="film-series-head">
        <h2 class="film-series-title">${escapeHtml(seriesName)}</h2>
        <span class="film-series-count">${count} ${count === 1 ? "title" : "titles"}</span>
      </header>
      <div class="film-vgrid" role="list"></div>
    `;
    const grid = section.querySelector(".film-vgrid");
    sortVideos(list).forEach((v) => grid.appendChild(createCard(v)));
    target.appendChild(section);
  }

  function renderFeatured(visible) {
    if (!els.featured || !els.featuredGrid || !catalog) return;
    const ids = catalog.featuredIds || [];
    const show = activeFilter === "all" && !searchQuery;
    const featuredVideos = ids
      .map((id) => visible.find((v) => v.id === id))
      .filter(Boolean);
    els.featured.hidden = !show || !featuredVideos.length;
    els.featuredGrid.innerHTML = "";
    if (!show || !featuredVideos.length) return;
    featuredVideos.forEach((v) => {
      els.featuredGrid.appendChild(createCard(v, { featured: true }));
    });
  }

  function updateStats() {
    if (!els.stats || !videos.length) return;
    const seriesCount = new Set(videos.map((v) => v.series)).size;
    els.stats.textContent = `${videos.length} titles · ${seriesCount} series · tap a poster to watch`;
  }

  function setLoading(on) {
    if (els.loading) els.loading.hidden = !on;
    if (els.rows && on) els.rows.hidden = true;
    if (els.featured && on) els.featured.hidden = true;
  }

  function render() {
    const visible = visibleVideos();
    const featuredIds = new Set(catalog.featuredIds || []);
    const catalogVideos = visible.filter((v) => !featuredIds.has(v.id) || activeFilter !== "all" || searchQuery);

    els.rows.innerHTML = "";
    if (!catalog) return;

    renderFeatured(visible);

    const bySeries = new Map();
    const order = catalog.seriesOrder || [];
    const useList =
      activeFilter === "all" && !searchQuery
        ? visible.filter((v) => !featuredIds.has(v.id))
        : visible;

    useList.forEach((v) => {
      if (!bySeries.has(v.series)) bySeries.set(v.series, []);
      bySeries.get(v.series).push(v);
    });

    order.forEach((name) => {
      if (bySeries.has(name)) renderSection(name, bySeries.get(name), els.rows);
    });
    bySeries.forEach((list, name) => {
      if (!order.includes(name)) renderSection(name, list, els.rows);
    });

    const anyVisible =
      (els.featured && !els.featured.hidden) || els.rows.children.length > 0;
    els.empty.hidden = anyVisible;
    if (els.rows) els.rows.hidden = !els.rows.children.length;
  }

  function findVideo(id) {
    return videos.find((v) => v.id === id) || null;
  }

  function pickRandomNext(current) {
    const sameSeries = videos.filter(
      (v) => v.series === current.series && v.id !== current.id
    );
    const pool =
      sameSeries.length > 0
        ? sameSeries
        : videos.filter((v) => v.id !== current.id);
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function destroyPlayer() {
    if (ytPlayer && typeof ytPlayer.destroy === "function") {
      try {
        ytPlayer.destroy();
      } catch (_) {
        /* ignore */
      }
    }
    ytPlayer = null;
    if (els.playerHost) els.playerHost.innerHTML = "";
  }

  function setPlayerLoading(on) {
    if (els.playerLoading) els.playerLoading.hidden = !on;
  }

  function playInModal(videoId) {
    const video = findVideo(videoId);
    if (!video) return;
    currentVideoId = videoId;
    setPlayerLoading(true);

    if (!ytApiReady) {
      pendingVideoId = videoId;
      loadYouTubeApi();
      return;
    }
    pendingVideoId = null;

    destroyPlayer();
    const hostId = "film-yt-player";
    els.playerHost.innerHTML = `<div id="${hostId}"></div>`;

    ytPlayer = new window.YT.Player(hostId, {
      videoId: video.youtubeId,
      host: "https://www.youtube-nocookie.com",
      playerVars: {
        rel: 0,
        modestbranding: 1,
        origin: YT_ORIGIN,
      },
      events: {
        onReady: function () {
          setPlayerLoading(false);
        },
        onStateChange: function (event) {
          if (event.data === window.YT.PlayerState.ENDED) {
            const cur = findVideo(currentVideoId);
            if (!cur) return;
            const next = pickRandomNext(cur);
            if (next) openModal(next.id, true);
          }
        },
        onError: function () {
          setPlayerLoading(false);
        },
      },
    });
  }

  function fillModalDetails(video) {
    els.modalTitle.textContent = video.title;
    els.modalSeries.textContent = video.series;
    els.modalType.textContent = video.type;
    els.modalCreator.textContent = video.creator;
    if (els.modalDuration) els.modalDuration.textContent = video.duration || "—";
    els.modalWhat.textContent = video.whatItIs || "";
    els.modalRelease.textContent = video.releaseDate || "";
    els.modalDesc.textContent = video.description || "";
    els.modalYtLink.href = `https://www.youtube.com/watch?v=${video.youtubeId}`;
    if (video.dedicatedPage) {
      els.modalDedicated.href = video.dedicatedPage;
      els.modalDedicated.hidden = false;
    } else {
      els.modalDedicated.hidden = true;
    }
  }

  function openModal(videoId, autoplayNext) {
    const video = findVideo(videoId);
    if (!video) return;

    fillModalDetails(video);
    const url = new URL(window.location.href);
    url.searchParams.set("v", videoId);
    history.replaceState(null, "", url);
    els.modal.hidden = false;
    document.body.classList.add("film-modal-open");
    if (!autoplayNext) {
      els.modal.setAttribute("aria-hidden", "false");
    }
    playInModal(videoId);
    els.modalClose.focus();
  }

  function closeModal() {
    destroyPlayer();
    currentVideoId = null;
    els.modal.hidden = true;
    document.body.classList.remove("film-modal-open");
    els.modal.setAttribute("aria-hidden", "true");
    const url = new URL(window.location.href);
    url.searchParams.delete("v");
    history.replaceState(null, "", url);
  }

  function renderFilters() {
    if (!catalog || !els.filters) return;
    els.filters.innerHTML = "";
    catalog.filters.forEach((f, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "film-filter-chip";
      btn.dataset.filter = f.id;
      btn.textContent = f.label;
      if (f.id === activeFilter) {
        btn.classList.add("is-active");
        btn.setAttribute("aria-pressed", "true");
      } else {
        btn.setAttribute("aria-pressed", "false");
      }
      if (i === 0) btn.id = "film-filter-all";
      btn.addEventListener("click", () => {
        activeFilter = f.id;
        els.filters.querySelectorAll(".film-filter-chip").forEach((chip) => {
          const on = chip.dataset.filter === activeFilter;
          chip.classList.toggle("is-active", on);
          chip.setAttribute("aria-pressed", on ? "true" : "false");
        });
        render();
      });
      els.filters.appendChild(btn);
    });
  }

  function bindEvents() {
    if (els.search) {
      els.search.addEventListener("input", () => {
        searchQuery = normalize(els.search.value);
        render();
      });
    }
    if (els.modalClose) els.modalClose.addEventListener("click", closeModal);
    if (els.modalBackdrop)
      els.modalBackdrop.addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.modal.hidden) closeModal();
    });
  }

  function openFromQuery() {
    const id = new URLSearchParams(window.location.search).get("v");
    if (id && findVideo(id)) openModal(id);
  }

  async function init() {
    loadYouTubeApi();
    bindEvents();
    setLoading(true);
    try {
      const res = await fetch(DATA_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      catalog = await res.json();
      videos = catalog.videos || [];
      updateStats();
      renderFilters();
      setLoading(false);
      render();
      openFromQuery();
    } catch (err) {
      console.error("Film hub: failed to load videos.json", err);
      setLoading(false);
      if (els.empty) {
        els.empty.hidden = false;
        els.empty.textContent =
          "Could not load the film catalog. Please refresh the page.";
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();