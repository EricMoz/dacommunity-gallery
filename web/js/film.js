/**
 * daCAT Film hub — catalog grid, filters, modal player, up-next (random or series).
 *
 * Shorts vs modal vs Theatre (intentional product design — do not “unify” these paths):
 * - Shorts: bottom rail only; always open externally on YouTube Shorts (never the hub modal).
 * - Main catalog: landscape films/episodes use the in-hub modal + Series/Random up-next.
 * - Theatre Mode: desktop lights-down stage sized for real landscape playback.
 * Vertical Shorts do not belong in the modal or Theatre player; keeping them external
 * preserves Theatre for longer landscape content. See README + docs/THEATRE.md
 * (“Shorts & video sizing”). When adding shorts to videos.json, set series/filterCategory
 * Shorts (or openExternal: true) so isShort() keeps them out of modal/theatre pools.
 */
(function () {
  "use strict";

  const YT_ORIGIN = window.location.origin;
  const UPNEXT_COUNTDOWN_SEC = 8;
  const UPNEXT_MODE_KEY = "dacat-film-upnext-mode";

  /** Match meta site-build so videos.json / assets never stick on a stale deploy. */
  function getBuildStamp() {
    const m = document.querySelector('meta[name="site-build"]');
    return (m && m.getAttribute("content")) || "0";
  }

  function videosDataUrl() {
    return (
      new URL("../data/videos.json", window.location.href).href +
      "?v=" +
      encodeURIComponent(getBuildStamp())
    );
  }

  /** Always ensure Shorts exists in filter chips even if an old videos.json is cached. */
  const REQUIRED_FILTERS = [
    { id: "all", label: "All" },
    { id: "chronicles", label: "Chronicles", matchSeries: "daCAT Chronicles" },
    { id: "dacatworld", label: "DACAT WORLD", matchSeries: "DACAT WORLD" },
    { id: "podcasts", label: "Podcast", matchSeries: "Podcast" },
    { id: "characters", label: "Characters", matchSeries: "Characters" },
    { id: "crossovers", label: "Crossovers", matchSeries: "Crossovers" },
    { id: "shorts", label: "Shorts", matchSeries: "Shorts" },
  ];

  function normalizeCatalogFilters(list) {
    const byId = {};
    (list || []).forEach(function (f) {
      if (f && f.id) byId[f.id] = f;
    });
    REQUIRED_FILTERS.forEach(function (req) {
      if (!byId[req.id]) byId[req.id] = req;
    });
    // Preserve preferred order from REQUIRED_FILTERS, then any extras
    const ordered = [];
    const seen = {};
    REQUIRED_FILTERS.forEach(function (req) {
      ordered.push(byId[req.id]);
      seen[req.id] = true;
    });
    Object.keys(byId).forEach(function (id) {
      if (!seen[id]) ordered.push(byId[id]);
    });
    return ordered;
  }

  /** Strip legacy "Theatre mode · full screen" pill if an old script left it in the DOM. */
  function removeLegacyFullScreenTheatrePill() {
    document
      .querySelectorAll(
        "#film-bottom-theatre, .film-bottom-theatre-cta, p.film-series-theatre-cta, a.film-theatre-cta-link"
      )
      .forEach(function (el) {
        el.remove();
      });
    // Text fallback (in case class names differ)
    document.querySelectorAll("a, p, button").forEach(function (el) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t.indexOf("theatre mode") !== -1 && t.indexOf("full screen") !== -1) {
        const wrap = el.closest("p, div, section") || el;
        if (wrap && !wrap.classList.contains("film-hub-main")) wrap.remove();
        else el.remove();
      }
    });
  }

  const els = {
    rows: document.getElementById("film-rows"),
    featured: document.getElementById("film-featured"),
    featuredGrid: document.getElementById("film-featured-grid"),
    featuredCount: document.getElementById("film-featured-count"),
    shorts: document.getElementById("film-shorts"),
    shortsTrack: document.getElementById("film-shorts-track"),
    shortsCount: document.getElementById("film-shorts-count"),
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
    modalTheatre: document.getElementById("film-modal-theatre"),
    upnext: document.getElementById("film-upnext"),
    upnextBar: document.getElementById("film-upnext-bar"),
    upnextEnd: document.getElementById("film-upnext-end"),
    upnextThumb: document.getElementById("film-upnext-thumb"),
    upnextKicker: document.getElementById("film-upnext-kicker"),
    upnextTitle: document.getElementById("film-upnext-title"),
    upnextMeta: document.getElementById("film-upnext-meta"),
    upnextPreview: document.getElementById("film-upnext-preview"),
    upnextPlay: document.getElementById("film-upnext-play"),
    upnextCountdown: document.getElementById("film-upnext-countdown"),
    upnextEndTap: document.getElementById("film-upnext-end-tap"),
    upnextCancel: document.getElementById("film-upnext-cancel"),
    upnextPlayNow: document.getElementById("film-upnext-play-now"),
    upnextModes: document.querySelectorAll(".film-upnext-mode"),
  };

  let catalog = null;
  let videos = [];
  let activeFilter = "all";
  let searchQuery = "";
  let currentVideoId = null;
  let ytPlayer = null;
  let ytApiReady = false;
  let pendingVideoId = null;
  let nextMode = "random";
  let lastRandomId = null;
  let randomBag = [];
  let pendingUpNext = null;
  let upNextTimer = null;
  let upNextCountdownSec = 0;
  let pendingAutoplayAfterLoad = false;

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
    const list =
      (catalog && catalog.filters) || REQUIRED_FILTERS;
    return list.find((f) => f.id === id);
  }

  /**
   * True for YouTube Shorts catalog entries.
   * Intentional: Shorts stay on the external rail and must never enter the hub modal,
   * modal up-next bags, series rows, or Theatre nav resolution. Prefer marking new
   * shorts with series "Shorts" / filterCategory "shorts" and openExternal: true.
   */
  function isShort(video) {
    if (!video) return false;
    if (video.openExternal === true) return true;
    if (video.series === "Shorts") return true;
    if (video.filterCategory === "shorts") return true;
    return false;
  }

  /**
   * Main catalog pool for grids, modal playback, and up-next (Random/Series).
   * Excludes Shorts so portrait clips never feed the landscape modal/theatre pipeline.
   */
  function mainVideos() {
    return videos.filter((v) => !isShort(v));
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
    if (activeFilter === "shorts") return isShort(video);
    const def = getFilterDef(activeFilter);
    if (def && def.matchSeries) return video.series === def.matchSeries;
    return video.filterCategory === activeFilter;
  }

  function visibleVideos() {
    // Shorts filter: empty main rows; renderShorts() paints the external rail only
    if (activeFilter === "shorts") return [];
    return mainVideos().filter((v) => matchesFilter(v) && matchesSearch(v));
  }

  function sortVideos(list) {
    return list.slice().sort((a, b) => {
      const so = (a.sortOrder || 0) - (b.sortOrder || 0);
      if (so !== 0) return so;
      return a.title.localeCompare(b.title);
    });
  }

  /** Newest first via ISO releasedAt, then sortOrder descending. */
  function sortShorts(list) {
    return list.slice().sort((a, b) => {
      const da = a.releasedAt || "";
      const db = b.releasedAt || "";
      if (da && db && da !== db) return db.localeCompare(da);
      if (da && !db) return -1;
      if (!da && db) return 1;
      const so = (b.sortOrder || 0) - (a.sortOrder || 0);
      if (so !== 0) return so;
      return a.title.localeCompare(b.title);
    });
  }

  function shortExternalUrl(video) {
    if (video.externalUrl) return video.externalUrl;
    if (video.youtubeId) {
      return "https://www.youtube.com/shorts/" + encodeURIComponent(video.youtubeId);
    }
    return "https://www.youtube.com/";
  }

  const THEATRE_PC_MQ = window.matchMedia("(min-width: 769px)");

  function isTheatrePc() {
    return THEATRE_PC_MQ.matches;
  }

  /**
   * Theatre deep-link for a catalog video (desktop only). Call only for non-shorts;
   * Shorts never get theatre.route and are excluded from mainVideos/nav resolution.
   */
  function theatreHref(video) {
    if (!video || isShort(video)) return null;
    if (!isTheatrePc()) return null;
    if (video.theatre && video.theatre.enabled === false) return null;
    if (video.theatre && video.theatre.route) return video.theatre.route;
    return "theatre/?v=" + encodeURIComponent(video.id);
  }

  function hasDedicatedTheatreRoute(video) {
    return !!(video.theatre && video.theatre.route && theatreHref(video));
  }

  function resolveHeroTheatreHref() {
    const withTheatre = sortVideos(videos.filter((v) => theatreHref(v)));
    const dedicated = withTheatre.find((v) => hasDedicatedTheatreRoute(v));
    if (dedicated) return theatreHref(dedicated);
    return withTheatre.length ? theatreHref(withTheatre[0]) : null;
  }

  /**
   * Theatre href for hub nav pills (top + bottom). Explicitly skips Shorts so
   * portrait clips never become the default Theatre entry point.
   */
  function resolveNavTheatreHref() {
    const dedicated = sortVideos(
      (videos || []).filter(
        (v) =>
          !isShort(v) &&
          v.theatre &&
          v.theatre.route &&
          v.theatre.enabled !== false
      )
    );
    if (dedicated.length) return dedicated[0].theatre.route;
    const href = resolveHeroTheatreHref();
    return href || "mozvane/";
  }

  /** Keep hero + foot "Theatre · Shop · Home" pills in sync (no full-screen CTA pill). */
  function syncTheatreNavLinks() {
    const href = resolveNavTheatreHref();
    document
      .querySelectorAll("#film-hero-theatre, .film-hub-foot-theatre")
      .forEach(function (el) {
        if (!el) return;
        el.href = href;
        el.hidden = false;
        el.removeAttribute("hidden");
      });
  }

  function syncHeroTheatreLink() {
    syncTheatreNavLinks();
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

  /**
   * Shorts rail card: same visual shell as film cards, but always an external
   * <a> to YouTube Shorts (↗). Never wire these to openModal().
   */
  function createShortCard(video) {
    const a = document.createElement("a");
    a.className = "film-vcard film-short-card";
    a.href = shortExternalUrl(video);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.dataset.videoId = video.id;
    a.setAttribute(
      "aria-label",
      "Open short on YouTube (leaves site): " +
        video.title +
        (video.duration ? ", " + video.duration : "")
    );
    const duration = video.duration || "—";
    a.innerHTML = `
      <span class="film-vcard-thumb">
        <img src="${escapeHtml(video.thumbnail)}" alt="" loading="lazy" width="480" height="360" />
        <span class="film-vcard-play" aria-hidden="true"></span>
        <span class="film-vcard-duration">${escapeHtml(duration)}</span>
        <span class="film-short-badge">Short</span>
        <span class="film-short-external" aria-hidden="true" title="Opens YouTube">↗</span>
      </span>
      <span class="film-vcard-body">
        <span class="film-vcard-series">Shorts</span>
        <span class="film-vcard-title">${escapeHtml(video.title)}</span>
        <span class="film-vcard-creator">${escapeHtml(video.creator || "")}</span>
        <span class="film-short-cta">Watch on YouTube ↗</span>
      </span>
    `;
    return a;
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
        <span class="film-series-count">${count} ${count === 1 ? "video" : "videos"}</span>
      </header>
      <div class="film-vgrid" role="list"></div>
    `;
    const grid = section.querySelector(".film-vgrid");
    sortVideos(list).forEach((v) => grid.appendChild(createCard(v)));
    target.appendChild(section);
  }

  function resolveFeaturedIds() {
    let ids = [];
    if (catalog.featuredIds && catalog.featuredIds.length) {
      ids = catalog.featuredIds.slice();
    } else {
      ids = videos
        .filter((v) => v.featuredPick)
        .sort((a, b) => (a.featuredOrder || 99) - (b.featuredOrder || 99))
        .map((v) => v.id);
    }
    // Randomize order so not always the same (but still one per series via the list)
    ids = ids.slice().sort(() => Math.random() - 0.5);
    return ids;
  }

  function renderFeatured(visible) {
    if (!els.featured || !els.featuredGrid || !catalog) return;
    const ids = resolveFeaturedIds();
    const show = activeFilter === "all" && !searchQuery;
    const featuredVideos = ids
      .map((id) => visible.find((v) => v.id === id))
      .filter(Boolean);
    els.featured.hidden = !show || !featuredVideos.length;
    els.featuredGrid.innerHTML = "";
    if (els.featuredCount && featuredVideos.length) {
      els.featuredCount.textContent =
        featuredVideos.length +
        (featuredVideos.length === 1 ? " starter" : " starters · one per series");
    }
    if (!show || !featuredVideos.length) return;
    featuredVideos.forEach((v) => {
      els.featuredGrid.appendChild(createCard(v, { featured: true }));
    });
  }

  function updateStats() {
    if (!els.stats) return;
    const main = mainVideos();
    if (!main.length) {
      els.stats.textContent = "";
      return;
    }
    const seriesCount = new Set(main.map((v) => v.series)).size;
    els.stats.textContent =
      main.length +
      " titles · " +
      seriesCount +
      " series · tap a poster to watch";
  }

  function setLoading(on) {
    if (els.loading) els.loading.hidden = !on;
    if (els.rows && on) els.rows.hidden = true;
    if (els.featured && on) els.featured.hidden = true;
    if (els.shorts && on) els.shorts.hidden = true;
  }

  /**
   * Shorts rail (last catalog block after series rows).
   * Intentional: this is the only hub surface for shorts. Cards open YouTube
   * externally; they are not series rows and do not use the modal player.
   * Shown on All + Shorts filter; horizontal scroll when 2+ items.
   */
  function renderShorts() {
    if (!els.rows) return;
    // Remove stale static mount outside the catalog (avoids duplicate ids / spacing)
    document.querySelectorAll("#film-shorts").forEach(function (node) {
      if (node.parentNode !== els.rows) node.remove();
    });

    const minVisible =
      catalog && catalog.shortsMinVisible != null
        ? Number(catalog.shortsMinVisible)
        : 1;
    const scrollMin =
      catalog && catalog.shortsScrollMin != null
        ? Number(catalog.shortsScrollMin)
        : 2;
    let list = videos.filter(isShort);
    if (searchQuery) list = list.filter(matchesSearch);
    list = sortShorts(list);

    const filterOk =
      activeFilter === "all" || activeFilter === "shorts";
    if (!filterOk || list.length < minVisible) return;

    const section = document.createElement("section");
    section.className = "film-series-section film-shorts-section";
    section.id = "film-shorts-row";
    section.dataset.series = "Shorts";
    section.setAttribute("aria-labelledby", "film-shorts-heading");

    const countLabel =
      list.length + (list.length === 1 ? " short" : " shorts");
    section.innerHTML =
      '<header class="film-series-head">' +
      '<h2 id="film-shorts-heading" class="film-series-title">Shorts</h2>' +
      '<span class="film-series-count" id="film-shorts-count">' +
      escapeHtml(countLabel) +
      "</span></header>";

    const track = document.createElement("div");
    track.id = "film-shorts-track";
    track.className =
      "film-shorts-track " +
      (list.length >= scrollMin
        ? "film-shorts-track--scroll"
        : "film-shorts-track--single");
    track.setAttribute("role", "list");
    list.forEach((v) => track.appendChild(createShortCard(v)));
    section.appendChild(track);

    els.rows.appendChild(section);
    els.shorts = section;
    els.shortsTrack = track;
    els.shortsCount = section.querySelector("#film-shorts-count");
  }

  function render() {
    removeLegacyFullScreenTheatrePill();
    const visible = visibleVideos();

    els.rows.innerHTML = "";
    if (!catalog) return;

    renderFeatured(visible);

    const bySeries = new Map();
    const order = (catalog.seriesOrder || []).filter((n) => n !== "Shorts");

    visible.forEach((v) => {
      if (isShort(v)) return;
      if (!bySeries.has(v.series)) bySeries.set(v.series, []);
      bySeries.get(v.series).push(v);
    });

    order.forEach((name) => {
      if (bySeries.has(name)) renderSection(name, bySeries.get(name), els.rows);
    });
    bySeries.forEach((list, name) => {
      if (name === "Shorts") return;
      if (!order.includes(name)) renderSection(name, list, els.rows);
    });

    // After all series (Crossovers last in seriesOrder) → Shorts
    renderShorts();
    syncTheatreNavLinks();

    const anyVisible =
      (els.featured && !els.featured.hidden) || els.rows.children.length > 0;
    els.empty.hidden = anyVisible;
    if (els.rows) els.rows.hidden = !els.rows.children.length;
  }

  function findVideo(id) {
    return videos.find((v) => v.id === id) || null;
  }

  function seriesList(current) {
    // Modal Series up-next: main catalog only (mainVideos already excludes Shorts)
    return sortVideos(
      mainVideos().filter((v) => v.series === current.series)
    );
  }

  function shuffleIds(ids) {
    const list = ids.slice();
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  function refillRandomBag(exclude) {
    // mainVideos() only — never put Shorts in the modal Random bag
    const blocked = exclude || new Set();
    const pool = mainVideos();
    let ids = pool.map((v) => v.id).filter((id) => !blocked.has(id));
    if (!ids.length) ids = pool.map((v) => v.id);
    randomBag = shuffleIds(ids);
  }

  /** Fair shuffle bag over main catalog only (excludes Shorts via mainVideos). */
  function pickRandomNext(current, extraExclude) {
    const pool = mainVideos();
    if (!pool.length) return null;
    if (pool.length === 1) {
      return pool[0].id === current.id ? null : pool[0];
    }

    const exclude = new Set([current.id]);
    if (lastRandomId) exclude.add(lastRandomId);
    if (extraExclude) {
      extraExclude.forEach((id) => {
        if (id) exclude.add(id);
      });
    }

    randomBag = randomBag.filter((id) => !exclude.has(id));
    if (!randomBag.length) refillRandomBag(exclude);

    if (!randomBag.length) {
      const rest = pool.filter((v) => !exclude.has(v.id));
      if (!rest.length) return null;
      return rest[Math.floor(Math.random() * rest.length)];
    }

    return findVideo(randomBag.shift());
  }

  function pickSeriesNext(current) {
    const list = seriesList(current);
    if (list.length <= 1) return pickRandomNext(current);
    const idx = list.findIndex((v) => v.id === current.id);
    if (idx < 0) return list[0];
    return list[(idx + 1) % list.length];
  }

  function resolveUpNext(current) {
    if (!current) return null;
    if (nextMode === "series") return pickSeriesNext(current);
    return pickRandomNext(current);
  }

  function upNextModeLabel() {
    return nextMode === "series" ? "Series" : "Random";
  }

  function clearUpNextCountdown() {
    if (upNextTimer) {
      clearInterval(upNextTimer);
      upNextTimer = null;
    }
    upNextCountdownSec = 0;
  }

  function hideUpNextEnd() {
    if (els.upnextEnd) els.upnextEnd.hidden = true;
    if (els.upnextBar) els.upnextBar.hidden = false;
  }

  function fillUpNextPreview(video) {
    if (!video) return;
    if (els.upnextThumb) {
      els.upnextThumb.src = video.thumbnail;
      els.upnextThumb.alt = "";
    }
    if (els.upnextTitle) els.upnextTitle.textContent = video.title;
    if (els.upnextMeta) {
      els.upnextMeta.textContent =
        video.series + " · " + (video.duration || "—");
    }
    if (els.upnextKicker) {
      els.upnextKicker.textContent = "Up next · " + upNextModeLabel();
    }
    const previewLabel =
      "Play up next: " + video.title + " (" + video.series + ")";
    if (els.upnextPreview) els.upnextPreview.setAttribute("aria-label", previewLabel);
    if (els.upnextEndTap) els.upnextEndTap.setAttribute("aria-label", previewLabel);
  }

  function upNextPlayLabel() {
    return nextMode === "series" ? "Next in series" : "Play next";
  }

  function reshuffleUpNextPreview() {
    const cur = findVideo(currentVideoId);
    if (!cur || nextMode !== "random") {
      refreshUpNextUi();
      return;
    }
    const extra = [];
    if (pendingUpNext && pendingUpNext.id !== cur.id) {
      extra.push(pendingUpNext.id);
    }
    const next = pickRandomNext(cur, extra);
    pendingUpNext = next;
    if (!next) {
      if (els.upnext) els.upnext.hidden = true;
      return;
    }
    if (els.upnext) els.upnext.hidden = false;
    hideUpNextEnd();
    fillUpNextPreview(next);
    if (els.upnextPlay) {
      els.upnextPlay.disabled = false;
      els.upnextPlay.textContent = upNextPlayLabel();
    }
  }

  function syncUpNextModeUi() {
    if (!els.upnextModes) return;
    els.upnextModes.forEach((btn) => {
      const on = btn.dataset.mode === nextMode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function setUpNextMode(mode) {
    if (mode !== "random" && mode !== "series") return;
    nextMode = mode;
    try {
      sessionStorage.setItem(UPNEXT_MODE_KEY, mode);
    } catch (_) {
      /* ignore */
    }
    syncUpNextModeUi();
    const cur = findVideo(currentVideoId);
    if (els.upnextEnd && !els.upnextEnd.hidden && cur) {
      pendingUpNext = resolveUpNext(cur);
      if (pendingUpNext) {
        fillUpNextPreview(pendingUpNext);
        updateCountdownText();
      }
    } else {
      refreshUpNextUi();
    }
  }

  function refreshUpNextUi() {
    const cur = findVideo(currentVideoId);
    if (!cur || !els.upnext) {
      if (els.upnext) els.upnext.hidden = true;
      return;
    }
    const next = resolveUpNext(cur);
    pendingUpNext = next;
    if (!next) {
      els.upnext.hidden = true;
      return;
    }
    els.upnext.hidden = false;
    hideUpNextEnd();
    fillUpNextPreview(next);
    if (els.upnextPlay) {
      els.upnextPlay.disabled = false;
      els.upnextPlay.textContent = upNextPlayLabel();
    }
  }

  function showUpNextCountdown(nextVideo) {
    if (!nextVideo || !els.upnext) return;
    pendingUpNext = nextVideo;
    els.upnext.hidden = false;
    if (els.upnextBar) els.upnextBar.hidden = true;
    if (els.upnextEnd) els.upnextEnd.hidden = false;
    fillUpNextPreview(nextVideo);
    clearUpNextCountdown();
    upNextCountdownSec = UPNEXT_COUNTDOWN_SEC;
    updateCountdownText();
    upNextTimer = setInterval(() => {
      upNextCountdownSec -= 1;
      if (upNextCountdownSec <= 0) {
        clearUpNextCountdown();
        goToUpNext({ fromCountdown: true });
        return;
      }
      updateCountdownText();
    }, 1000);
  }

  function updateCountdownText() {
    if (!els.upnextCountdown || !pendingUpNext) return;
    const label =
      nextMode === "series" ? "Next in series" : "Random pick";
    els.upnextCountdown.innerHTML =
      '<strong>' +
      escapeHtml(pendingUpNext.title) +
      "</strong> · " +
      label +
      " in <span>" +
      upNextCountdownSec +
      "s</span>";
  }

  function cancelUpNext() {
    clearUpNextCountdown();
    hideUpNextEnd();
    refreshUpNextUi();
  }

  function goToUpNext(opts) {
    opts = opts || {};
    clearUpNextCountdown();
    hideUpNextEnd();
    const cur = findVideo(currentVideoId);
    if (!cur) return;

    const next = pendingUpNext || resolveUpNext(cur);

    if (!next || next.id === cur.id) return;
    transitionToVideo(next.id, { autoplay: true, isUpNext: true });
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

  function onPlayerStateChange(event) {
    const YT = window.YT;
    if (!YT || !YT.PlayerState) return;
    if (
      event.data === YT.PlayerState.PLAYING ||
      event.data === YT.PlayerState.PAUSED
    ) {
      setPlayerLoading(false);
      pendingAutoplayAfterLoad = false;
    }
    if (
      pendingAutoplayAfterLoad &&
      ytPlayer &&
      ytPlayer.playVideo &&
      (event.data === YT.PlayerState.CUED ||
        event.data === YT.PlayerState.UNSTARTED ||
        event.data === YT.PlayerState.BUFFERING)
    ) {
      pendingAutoplayAfterLoad = false;
      try {
        ytPlayer.playVideo();
      } catch (_) {
        /* ignore */
      }
    }
    if (event.data === YT.PlayerState.ENDED) {
      const cur = findVideo(currentVideoId);
      if (!cur) return;
      const next = pendingUpNext || resolveUpNext(cur);
      if (next) showUpNextCountdown(next);
      else cancelUpNext();
    }
  }

  function createPlayer(video, autoplay) {
    destroyPlayer();
    const hostId = "film-yt-player";
    els.playerHost.innerHTML = `<div id="${hostId}"></div>`;

    ytPlayer = new window.YT.Player(hostId, {
      videoId: video.youtubeId,
      host: "https://www.youtube-nocookie.com",
      playerVars: {
        autoplay: autoplay ? 1 : 0,
        rel: 0,
        modestbranding: 1,
        origin: YT_ORIGIN,
      },
      events: {
        onReady: function () {
          setPlayerLoading(false);
          if (autoplay && ytPlayer && ytPlayer.playVideo) {
            ytPlayer.playVideo();
          }
        },
        onStateChange: onPlayerStateChange,
        onError: function () {
          setPlayerLoading(false);
        },
      },
    });
  }

  function transitionToVideo(videoId, opts) {
    opts = opts || {};
    const video = findVideo(videoId);
    if (!video) return;

    const prevId = currentVideoId;
    currentVideoId = videoId;
    if (opts.isUpNext && nextMode === "random" && prevId) {
      lastRandomId = prevId;
    }

    fillModalDetails(video);
    const url = new URL(window.location.href);
    url.searchParams.set("v", videoId);
    history.replaceState(null, "", url);

    setPlayerLoading(true);

    if (ytPlayer && typeof ytPlayer.loadVideoById === "function") {
      pendingAutoplayAfterLoad = opts.autoplay !== false;
      ytPlayer.loadVideoById(video.youtubeId);
      if (opts.autoplay !== false && ytPlayer.playVideo) {
        try {
          ytPlayer.playVideo();
        } catch (_) {
          /* wait for CUED in onPlayerStateChange */
        }
      } else {
        pendingAutoplayAfterLoad = false;
      }
    } else if (ytApiReady) {
      createPlayer(video, opts.autoplay !== false);
    } else {
      pendingVideoId = videoId;
      loadYouTubeApi();
    }

    refreshUpNextUi();
  }

  function playInModal(videoId, autoplay) {
    const video = findVideo(videoId);
    if (!video) return;
    // Defense in depth: never load a Short into the YT iframe player
    if (isShort(video)) {
      window.open(shortExternalUrl(video), "_blank", "noopener,noreferrer");
      return;
    }
    currentVideoId = videoId;
    setPlayerLoading(true);

    if (!ytApiReady) {
      pendingVideoId = videoId;
      loadYouTubeApi();
      return;
    }
    pendingVideoId = null;
    createPlayer(video, autoplay !== false);
    refreshUpNextUi();
  }

  function showSocialShareModal(url, title) {
    title = title || "Check this out on daCAT Films";
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

    // Remove any stale promo
    const oldPromo = document.getElementById('film-modal-world-promo');
    if (oldPromo) oldPromo.remove();

    // For daCAT World / podcast videos in the modal: 
    // - no "YouTube" channel link (removed per request)
    // - "Shop merch & free comics" on its own clean line *below* the main links (Watch on YT, Theatre, Share)
    //   so layout is less cluttered. Placed after .film-modal-links. Styling (class) kept intact.
    const isWorld = video.creator === "DACAT WORLD" || video.filterCategory === "dacatworld" || video.filterCategory === "podcasts";
    if (isWorld) {
      const modalLinks = els.modal ? els.modal.querySelector('.film-modal-links') : document.querySelector('.film-modal-links');
      if (modalLinks && modalLinks.parentNode) {
        const promo = document.createElement('p');
        promo.id = 'film-modal-world-promo';
        promo.className = 'film-modal-world-promo';
        promo.innerHTML = `<a href="https://dacat.store/" target="_blank" rel="noopener noreferrer">Shop merch &amp; free comics</a>`;
        modalLinks.parentNode.insertBefore(promo, modalLinks.nextSibling);
      }
    }
    const theatre = theatreHref(video);
    if (theatre && els.modalTheatre) {
      els.modalTheatre.href = theatre;
      els.modalTheatre.hidden = false;
    } else if (els.modalTheatre) {
      els.modalTheatre.hidden = true;
    }

    // Bind the small share button (styled differently as a compact button, placed after the links)
    var shareBtn = document.getElementById("film-modal-share");
    if (shareBtn) {
      shareBtn.onclick = function () {
        var ytUrl = `https://www.youtube.com/watch?v=${video.youtubeId}`;
        var shareTitle = video.title + " — daCAT Films";
        showSocialShareModal(ytUrl, shareTitle);
      };
    }
  }

  function openModal(videoId, opts) {
    const video = findVideo(videoId);
    if (!video) return;
    // Guard: Shorts must not enter the hub modal / iframe player (external only)
    if (isShort(video)) {
      window.open(shortExternalUrl(video), "_blank", "noopener,noreferrer");
      return;
    }
    const isChain =
      opts && (opts.autoplayNext === true || opts.isUpNext === true);

    lastRandomId = null;
    randomBag = [];
    clearUpNextCountdown();
    fillModalDetails(video);
    const url = new URL(window.location.href);
    url.searchParams.set("v", videoId);
    history.replaceState(null, "", url);
    els.modal.hidden = false;
    document.body.classList.add("film-modal-open");
    els.modal.setAttribute("aria-hidden", "false");
    playInModal(videoId, true);
    if (!isChain && els.modalClose && typeof els.modalClose.focus === "function") {
      try {
        els.modalClose.focus({ preventScroll: true });
      } catch (_) {
        els.modalClose.focus();
      }
    }
  }

  function closeModal() {
    clearUpNextCountdown();
    pendingUpNext = null;
    destroyPlayer();
    currentVideoId = null;
    if (els.upnext) els.upnext.hidden = true;
    els.modal.hidden = true;
    document.body.classList.remove("film-modal-open");
    els.modal.setAttribute("aria-hidden", "true");
    const url = new URL(window.location.href);
    url.searchParams.delete("v");
    history.replaceState(null, "", url);
  }

  function renderFilters() {
    if (!els.filters) return;
    const filters = normalizeCatalogFilters(
      (catalog && catalog.filters) || []
    );
    if (catalog) catalog.filters = filters;
    els.filters.innerHTML = "";
    filters.forEach((f, i) => {
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
    if (els.upnextPreview) {
      els.upnextPreview.addEventListener("click", () => goToUpNext({}));
    }
    if (els.upnextEndTap) {
      els.upnextEndTap.addEventListener("click", () =>
        goToUpNext({ fromCountdown: true })
      );
    }
    if (els.upnextPlay) {
      els.upnextPlay.addEventListener("click", () => goToUpNext({}));
    }
    if (els.upnextPlayNow) {
      els.upnextPlayNow.addEventListener("click", () =>
        goToUpNext({ fromCountdown: true })
      );
    }
    if (els.upnextCancel) {
      els.upnextCancel.addEventListener("click", () => cancelUpNext());
    }
    if (els.upnextModes) {
      els.upnextModes.forEach((btn) => {
        btn.addEventListener("click", () => {
          const mode = btn.dataset.mode;
          if (mode === "random" && mode === nextMode) {
            reshuffleUpNextPreview();
            return;
          }
          setUpNextMode(mode);
        });
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.modal.hidden) {
        if (els.upnextEnd && !els.upnextEnd.hidden) {
          cancelUpNext();
          return;
        }
        closeModal();
      }
    });
  }

  function openFromQuery() {
    const id = new URLSearchParams(window.location.search).get("v");
    const video = id ? findVideo(id) : null;
    if (!video) return;
    // ?v= short id must not open the hub modal — send users to YouTube Shorts
    if (isShort(video)) {
      window.open(shortExternalUrl(video), "_blank", "noopener,noreferrer");
      return;
    }
    openModal(id);
  }

  function keepPageAtTopUnlessDeepLink() {
    const hasVideo = new URLSearchParams(window.location.search).has("v");
    if (hasVideo) return;
    window.scrollTo(0, 0);
  }

  /** Measured header height — keeps .film-sticky-deck flush under .site-header when stuck. */
  function syncSiteHeaderHeight() {
    const header = document.querySelector(".site-header");
    if (!header) return;
    const h = Math.ceil(header.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--site-header-h", h + "px");
  }

  function bindHeaderHeightSync() {
    const header = document.querySelector(".site-header");
    if (!header) return;
    syncSiteHeaderHeight();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(syncSiteHeaderHeight);
      ro.observe(header);
    }
    window.addEventListener("resize", syncSiteHeaderHeight);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(syncSiteHeaderHeight);
    }
  }

  function loadUpNextMode() {
    try {
      const saved = sessionStorage.getItem(UPNEXT_MODE_KEY);
      if (saved === "random" || saved === "series") nextMode = saved;
    } catch (_) {
      /* ignore */
    }
    syncUpNextModeUi();
  }

  async function init() {
    bindHeaderHeightSync();
    if ("scrollRestoration" in history) {
      history.scrollRestoration = "manual";
    }
    keepPageAtTopUnlessDeepLink();
    loadUpNextMode();

    loadYouTubeApi();
    bindEvents();
    removeLegacyFullScreenTheatrePill();
    THEATRE_PC_MQ.addEventListener("change", function () {
      syncTheatreNavLinks();
    });
    setLoading(true);
    try {
      const res = await fetch(videosDataUrl(), { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      catalog = await res.json();
      videos = catalog.videos || [];
      catalog.filters = normalizeCatalogFilters(catalog.filters || []);
      updateStats();
      // Paint filter chips immediately (includes Shorts even if JSON was stale)
      renderFilters();
      setLoading(false);
      render();
      removeLegacyFullScreenTheatrePill();
      syncHeroTheatreLink();
      syncSiteHeaderHeight();
      requestAnimationFrame(syncSiteHeaderHeight);
      keepPageAtTopUnlessDeepLink();
      openFromQuery();
    } catch (err) {
      console.error("Film hub: failed to load videos.json", err);
      setLoading(false);
      // Still show filter chips (with Shorts) so the toolbar isn't empty
      catalog = catalog || { filters: REQUIRED_FILTERS, videos: [] };
      catalog.filters = normalizeCatalogFilters(catalog.filters || []);
      renderFilters();
      removeLegacyFullScreenTheatrePill();
      if (els.empty) {
        els.empty.hidden = false;
        els.empty.textContent =
          "Could not load the film catalog. Please refresh the page.";
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      bindHeaderHeightSync();
      init();
    });
  } else {
    bindHeaderHeightSync();
    init();
  }
})();