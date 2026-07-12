/**
 * daCAT Film theater — catalog grid, filters, modal player, up-next (random or series).
 */
(function () {
  "use strict";

  const DATA_URL = new URL("../data/videos.json", window.location.href).href;
  const YT_ORIGIN = window.location.origin;
  const UPNEXT_COUNTDOWN_SEC = 8;
  const UPNEXT_MODE_KEY = "dacat-film-upnext-mode";

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
    return (catalog.filters || []).find((f) => f.id === id);
  }

  /** YouTube Shorts rail only — never enters modal / series rows / filter chips. */
  function isShort(video) {
    if (!video) return false;
    if (video.openExternal === true) return true;
    if (video.series === "Shorts") return true;
    if (video.filterCategory === "shorts") return true;
    return false;
  }

  /** Main catalog pool (excludes Shorts). */
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
    const def = getFilterDef(activeFilter);
    if (def && def.matchSeries) return video.series === def.matchSeries;
    return video.filterCategory === activeFilter;
  }

  function visibleVideos() {
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

  function theatreHref(video) {
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

  function syncHeroTheatreLink() {
    const el = document.getElementById("film-hero-theatre");
    if (!el) return;
    const href = resolveHeroTheatreHref();
    if (!href || !isTheatrePc()) {
      el.hidden = true;
      return;
    }
    el.href = href;
    el.hidden = false;
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

  /** Shorts rail card — opens YouTube in a new tab (no film modal / theatre). */
  function createShortCard(video) {
    const a = document.createElement("a");
    a.className = "film-vcard film-short-card";
    a.href = shortExternalUrl(video);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.dataset.videoId = video.id;
    a.setAttribute(
      "aria-label",
      "Open short on YouTube: " + video.title + (video.duration ? ", " + video.duration : "")
    );
    const duration = video.duration || "—";
    a.innerHTML = `
      <span class="film-vcard-thumb">
        <img src="${escapeHtml(video.thumbnail)}" alt="" loading="lazy" width="480" height="360" />
        <span class="film-vcard-play" aria-hidden="true"></span>
        <span class="film-vcard-duration">${escapeHtml(duration)}</span>
        <span class="film-short-badge">Short</span>
      </span>
      <span class="film-vcard-body">
        <span class="film-vcard-series">Shorts</span>
        <span class="film-vcard-title">${escapeHtml(video.title)}</span>
        <span class="film-vcard-creator">${escapeHtml(video.creator || "")}</span>
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

    const theatreVideo = sortVideos(list).find((v) => hasDedicatedTheatreRoute(v));
    if (theatreVideo) {
      const href = theatreHref(theatreVideo);
      const cta = document.createElement("p");
      cta.className = "film-series-theatre-cta";
      cta.innerHTML =
        '<a class="film-theatre-cta-link" href="' +
        escapeHtml(href) +
        '"><span class="film-theatre-cta-icon" aria-hidden="true">🍿</span> Theatre mode · full screen</a>';
      section.appendChild(cta);
    }

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
   * Bottom Shorts rail: horizontal scroll, newest first.
   * Hidden until shortsMinVisible (default 2) so a single short doesn't look sparse.
   * Only on "All" filter (no Shorts chip). Search narrows the rail when active.
   */
  function renderShorts() {
    if (!els.shorts || !els.shortsTrack) return;
    const minVisible =
      catalog && catalog.shortsMinVisible != null
        ? Number(catalog.shortsMinVisible)
        : 2;
    let list = videos.filter(isShort);
    if (searchQuery) list = list.filter(matchesSearch);
    list = sortShorts(list);

    // Shorts are never a filter chip — only show under All when enough content
    const canShow = activeFilter === "all" && list.length >= minVisible;

    els.shortsTrack.innerHTML = "";
    if (!canShow) {
      els.shorts.hidden = true;
      return;
    }
    list.forEach((v) => els.shortsTrack.appendChild(createShortCard(v)));
    if (els.shortsCount) {
      els.shortsCount.textContent =
        list.length + (list.length === 1 ? " short" : " shorts");
    }
    els.shorts.hidden = false;
  }

  function render() {
    const visible = visibleVideos();

    els.rows.innerHTML = "";
    if (!catalog) return;

    renderFeatured(visible);

    const bySeries = new Map();
    // Never mix Shorts into regular series rows
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

    renderShorts();

    const anyVisible =
      (els.featured && !els.featured.hidden) ||
      els.rows.children.length > 0 ||
      (els.shorts && !els.shorts.hidden);
    els.empty.hidden = anyVisible;
    if (els.rows) els.rows.hidden = !els.rows.children.length;
  }

  function findVideo(id) {
    return videos.find((v) => v.id === id) || null;
  }

  function seriesList(current) {
    // Characters series (and all others): cycle every main-catalog video in the same series
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
    const blocked = exclude || new Set();
    const pool = mainVideos();
    let ids = pool.map((v) => v.id).filter((id) => !blocked.has(id));
    if (!ids.length) ids = pool.map((v) => v.id);
    randomBag = shuffleIds(ids);
  }

  /** Fair shuffle bag — every title in the pool before repeats (covers single-video series). */
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
    // Shorts never use the hub modal — open YouTube instead
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
    if (isShort(video)) {
      // Deep link to a short → YouTube (do not trap in modal)
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
    THEATRE_PC_MQ.addEventListener("change", syncHeroTheatreLink);
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
      syncHeroTheatreLink();
      syncSiteHeaderHeight();
      requestAnimationFrame(syncSiteHeaderHeight);
      keepPageAtTopUnlessDeepLink();
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
    document.addEventListener("DOMContentLoaded", function () {
      bindHeaderHeightSync();
      init();
    });
  } else {
    bindHeaderHeightSync();
    init();
  }
})();