/**
 * daCAT Film — Theatre mode (immersive full-screen watch, desktop only).
 * YT API player, lights down/up, up-next (random when dim · full controls when up).
 */
(function () {
  "use strict";

  var VIDEOS_URL = new URL("../../data/videos.json", window.location.href).href;
  var REGISTRY_URL = new URL("../../data/theatre_registry.json", window.location.href).href;
  var THEATRE_PC_MQ = window.matchMedia("(min-width: 769px)");
  var POPCORN_COUNT = 24;
  var UPNEXT_COUNTDOWN_SEC = 8;
  var UPNEXT_TAIL_SEC = 1;
  var UPNEXT_MODE_KEY = "dacat-film-upnext-mode";
  var LIGHTS_PROMPT_KEY = "dacat-theatre-lights-prompted";
  var THEATRE_LIGHTS_KEY = "dacat-theatre-lights-down";
  var THEATRE_STACK_KEY = "dacat-theatre-watch-stack";
  var YT_ORIGIN = window.location.origin;

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var catalog = null;
  var videos = [];
  var currentVideo = null;
  var ytPlayer = null;
  var ytApiReady = false;
  var pendingVideo = null;
  var pendingAutoplayAfterLoad = false;

  var nextMode = "random";
  var lastRandomId = null;
  var pendingUpNext = null;
  var upNextTimer = null;
  var upNextCountdownSec = 0;
  var endWatchTimer = null;
  var endTriggered = false;
  var watchStack = [];
  var suppressPopstate = false;

  var els = {
    title: document.getElementById("theatre-title"),
    series: document.getElementById("theatre-series"),
    meta: document.getElementById("theatre-meta"),
    popcorn: document.getElementById("theatre-popcorn"),
    popcornField: document.getElementById("theatre-popcorn-field"),
    player: document.getElementById("theatre-player"),
    loading: document.getElementById("theatre-loading"),
    error: document.getElementById("theatre-error"),
    ytLink: document.getElementById("theatre-yt"),
    lightsBtn: document.getElementById("theatre-lights"),
    lightsDock: document.getElementById("theatre-lights-dock"),
    lightsHint: document.getElementById("theatre-lights-hint"),
    upnext: document.getElementById("theatre-upnext"),
    upnextFull: document.getElementById("theatre-upnext-full"),
    upnextDim: document.getElementById("theatre-upnext-dim"),
    upnextBar: document.getElementById("theatre-upnext-bar"),
    upnextEnd: document.getElementById("theatre-upnext-end"),
    upnextDimEnd: document.getElementById("theatre-upnext-dim-end"),
    upnextThumb: document.getElementById("theatre-upnext-thumb"),
    upnextKicker: document.getElementById("theatre-upnext-kicker"),
    upnextTitle: document.getElementById("theatre-upnext-title"),
    upnextMeta: document.getElementById("theatre-upnext-meta"),
    upnextPlay: document.getElementById("theatre-upnext-play"),
    upnextCountdown: document.getElementById("theatre-upnext-countdown"),
    upnextCancel: document.getElementById("theatre-upnext-cancel"),
    upnextPlayNow: document.getElementById("theatre-upnext-play-now"),
    upnextDimTitle: document.getElementById("theatre-upnext-dim-title"),
    upnextDimPlay: document.getElementById("theatre-upnext-dim-play"),
    upnextDimCountdown: document.getElementById("theatre-upnext-dim-countdown"),
    upnextDimCancel: document.getElementById("theatre-upnext-dim-cancel"),
    upnextDimPlayNow: document.getElementById("theatre-upnext-dim-play-now"),
    upnextModes: document.querySelectorAll(".theatre-upnext-mode"),
    backBtn: document.getElementById("theatre-back"),
  };

  function isTheatrePc() {
    return THEATRE_PC_MQ.matches;
  }

  function isLightsDown() {
    return document.body.classList.contains("film-theatre-lights-down");
  }

  function resolveVideoId() {
    var fromBody = document.body.getAttribute("data-video-id");
    if (fromBody) return fromBody.trim();
    return (new URLSearchParams(window.location.search).get("v") || "").trim();
  }

  function findVideo(id) {
    return videos.find(function (v) {
      return v.id === id;
    });
  }

  function findRegistryEntry(registry, video) {
    if (!registry || !video) return null;
    var slug =
      (video.theatre && video.theatre.slug) ||
      document.body.getAttribute("data-theatre-slug");
    if (!slug || !registry.theatres) return null;
    return registry.theatres[slug] || null;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sortVideos(list) {
    return list.slice().sort(function (a, b) {
      var so = (a.sortOrder || 0) - (b.sortOrder || 0);
      if (so !== 0) return so;
      return a.title.localeCompare(b.title);
    });
  }

  function seriesList(current) {
    return sortVideos(
      videos.filter(function (v) {
        return v.series === current.series;
      })
    );
  }

  function pickRandomNext(current, extraExclude) {
    var exclude = new Set([current.id]);
    if (lastRandomId) exclude.add(lastRandomId);
    if (extraExclude) {
      extraExclude.forEach(function (id) {
        if (id) exclude.add(id);
      });
    }
    var pool = videos.filter(function (v) {
      return !exclude.has(v.id);
    });
    if (!pool.length && videos.length > 1) {
      pool = videos.filter(function (v) {
        return v.id !== current.id;
      });
    }
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function pickSeriesNext(current) {
    var list = seriesList(current);
    if (list.length <= 1) return pickRandomNext(current);
    var idx = list.findIndex(function (v) {
      return v.id === current.id;
    });
    if (idx < 0) return list[0];
    return list[(idx + 1) % list.length];
  }

  function resolveUpNext(current) {
    if (!current) return null;
    if (isLightsDown() || nextMode === "random") return pickRandomNext(current);
    return pickSeriesNext(current);
  }

  function upNextModeLabel() {
    return isLightsDown() || nextMode === "random" ? "Random" : "Series";
  }

  function applyTheme(entry, video) {
    var accent =
      (entry && entry.theme && entry.theme.accent) || "#ffcc00";
    document.documentElement.style.setProperty("--theatre-accent", accent);
    if (entry && entry.theme && entry.theme.curtains === false) {
      document.body.classList.add("film-theatre-no-curtains");
    }
    if (els.popcorn) {
      var cue =
        (entry && entry.theme && entry.theme.popcornCue) ||
        "Grab popcorn — tap Lights down.";
      els.popcorn.textContent = "\uD83C\uDF7F " + cue;
    }
    document.title =
      (video.title || "Film") + " · Theatre mode · daCAT";
  }

  function showError(msg) {
    if (els.loading) els.loading.hidden = true;
    if (els.error) {
      els.error.hidden = false;
      els.error.textContent = msg;
    }
  }

  function setPlayerLoading(on) {
    if (els.loading) els.loading.hidden = !on;
  }

  function fillCopy(video, entry) {
    if (els.title) els.title.textContent = video.title || "—";
    if (els.series) els.series.textContent = video.series || "";
    if (els.meta) {
      els.meta.textContent =
        (video.type || "Film") +
        " · " +
        (video.duration || "—") +
        " · " +
        (video.creator || "");
    }
    if (els.ytLink) {
      els.ytLink.href =
        "https://www.youtube.com/watch?v=" + video.youtubeId;
    }
    applyTheme(entry, video);
  }

  function registryCanonicalId(slug) {
    if (!catalog || !catalog._theatreRegistry || !slug) return null;
    var entry = catalog._theatreRegistry.theatres[slug];
    return entry && entry.videoId ? entry.videoId : null;
  }

  function theatreHistoryState(videoId) {
    return { theatre: true, videoId: videoId };
  }

  function theatreHubUrl() {
    var entryId = watchStack[0] || (currentVideo && currentVideo.id);
    var url = new URL("../", window.location.href);
    if (entryId) url.searchParams.set("v", entryId);
    return url.href;
  }

  function persistWatchStack() {
    try {
      sessionStorage.setItem(THEATRE_STACK_KEY, JSON.stringify(watchStack));
    } catch (_) {
      /* ignore */
    }
  }

  function initWatchStack(videoId) {
    watchStack = [];
    try {
      var saved = sessionStorage.getItem(THEATRE_STACK_KEY);
      if (saved) {
        var parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          watchStack = parsed.filter(function (id) {
            return findVideo(id);
          });
        }
      }
    } catch (_) {
      watchStack = [];
    }
    if (!watchStack.length || watchStack[watchStack.length - 1] !== videoId) {
      watchStack = [videoId];
    }
    persistWatchStack();
    syncBackButton();
  }

  function pushWatchStack(videoId) {
    if (!videoId) return;
    if (watchStack[watchStack.length - 1] === videoId) return;
    watchStack.push(videoId);
    persistWatchStack();
    syncBackButton();
  }

  function trimWatchStackTo(videoId) {
    if (!videoId || !watchStack.length) return;
    while (watchStack.length > 1 && watchStack[watchStack.length - 1] !== videoId) {
      watchStack.pop();
    }
    if (watchStack[watchStack.length - 1] !== videoId) {
      watchStack.push(videoId);
    }
    persistWatchStack();
    syncBackButton();
  }

  function syncBackButton() {
    if (!els.backBtn) return;
    if (watchStack.length > 1) {
      els.backBtn.textContent = "\u2190 Previous film";
      els.backBtn.setAttribute(
        "aria-label",
        "Previous film in this theatre session"
      );
    } else {
      els.backBtn.textContent = "\u2190 Film hub";
      els.backBtn.setAttribute("aria-label", "Back to film hub");
    }
  }

  function applyTheatreUrl(video) {
    var pageId = document.body.getAttribute("data-video-id");
    var onDedicated =
      pageId &&
      !new URLSearchParams(window.location.search).has("v");
    var url = new URL(window.location.href);

    if (onDedicated && video.id !== pageId) {
      var slug = video.theatre && video.theatre.slug;
      var canonical = slug ? registryCanonicalId(slug) : null;
      if (
        video.theatre &&
        video.theatre.route &&
        canonical &&
        video.id === canonical
      ) {
        document.body.setAttribute("data-video-id", video.id);
        return url.pathname + url.search;
      }
      url.pathname = url.pathname.replace(/\/[^/]+\/?$/, "/theatre/");
      url.searchParams.set("v", video.id);
      document.body.removeAttribute("data-video-id");
      document.body.removeAttribute("data-theatre-slug");
      return url.pathname + url.search;
    }

    url.searchParams.set("v", video.id);
    if (pageId) document.body.setAttribute("data-video-id", video.id);
    return url.pathname + url.search;
  }

  function writeTheatreHistory(video, how) {
    if (!video || how === "none") return;
    var href = applyTheatreUrl(video);
    var state = theatreHistoryState(video.id);
    if (how === "push") history.pushState(state, "", href);
    else history.replaceState(state, "", href);
  }

  function loadTheatreVideo(video, opts) {
    opts = opts || {};
    if (!video) return;
    var keepLightsDown = opts.keepLights !== false && isLightsDown();
    var entry = findRegistryEntry(catalog && catalog._theatreRegistry, video);
    fillCopy(video, entry);
    playVideo(video, opts.autoplay !== false);
    resetEndTrigger();
    if (keepLightsDown) setLightsDown(true);
    syncBackButton();
  }

  function theatreBack() {
    clearUpNextCountdown();
    hideUpNextEnd();
    refreshUpNextUi();

    if (watchStack.length > 1) {
      suppressPopstate = false;
      history.back();
      return;
    }

    try {
      sessionStorage.removeItem(THEATRE_STACK_KEY);
    } catch (_) {
      /* ignore */
    }
    window.location.href = theatreHubUrl();
  }

  function onTheatrePopState(event) {
    if (suppressPopstate) return;
    var state = event.state;
    if (!state || !state.theatre || !state.videoId) {
      if (watchStack.length <= 1) {
        window.location.href = theatreHubUrl();
      }
      return;
    }

    trimWatchStackTo(state.videoId);
    var video = findVideo(state.videoId);
    if (!video) {
      window.location.href = theatreHubUrl();
      return;
    }
    loadTheatreVideo(video, { autoplay: false, keepLights: true, history: "none" });
  }

  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) {
      ytApiReady = true;
      return;
    }
    var prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      ytApiReady = true;
      if (typeof prev === "function") prev();
      if (pendingVideo) mountYtPlayer(pendingVideo, true);
    };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      var tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      document.head.appendChild(tag);
    }
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
    if (els.player) els.player.innerHTML = "";
  }

  function clearEndWatch() {
    if (endWatchTimer) {
      clearInterval(endWatchTimer);
      endWatchTimer = null;
    }
  }

  function resetEndTrigger() {
    endTriggered = false;
    clearEndWatch();
  }

  function triggerUpNextAtTail() {
    if (endTriggered || !currentVideo) return;
    endTriggered = true;
    clearEndWatch();
    var next = resolveUpNext(currentVideo);
    if (!next) {
      cancelUpNext();
      return;
    }
    pendingUpNext = next;
    if (isLightsDown()) {
      goToUpNext({ fromCountdown: true });
      return;
    }
    showUpNextCountdown(next, { seconds: UPNEXT_TAIL_SEC });
  }

  function startEndWatch() {
    clearEndWatch();
    endWatchTimer = setInterval(function () {
      if (!ytPlayer || !currentVideo || endTriggered) return;
      var YT = window.YT;
      if (!YT || ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) return;
      try {
        var dur = ytPlayer.getDuration();
        var cur = ytPlayer.getCurrentTime();
        if (!dur || dur <= 0 || isNaN(dur) || isNaN(cur)) return;
        if (dur - cur <= UPNEXT_TAIL_SEC) triggerUpNextAtTail();
      } catch (_) {
        /* ignore */
      }
    }, 200);
  }

  function onPlayerStateChange(event) {
    var YT = window.YT;
    if (!YT || !YT.PlayerState) return;
    if (
      event.data === YT.PlayerState.PLAYING ||
      event.data === YT.PlayerState.PAUSED
    ) {
      setPlayerLoading(false);
      pendingAutoplayAfterLoad = false;
    }
    if (event.data === YT.PlayerState.PLAYING) {
      resetEndTrigger();
      startEndWatch();
    }
    if (
      event.data === YT.PlayerState.PAUSED ||
      event.data === YT.PlayerState.ENDED ||
      event.data === YT.PlayerState.CUED
    ) {
      clearEndWatch();
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
      if (endTriggered) return;
      triggerUpNextAtTail();
    }
  }

  function mountYtPlayer(video, autoplay) {
    if (!els.player) return;
    destroyPlayer();
    var hostId = "theatre-yt-host";
    els.player.innerHTML = '<div id="' + hostId + '"></div>';
    setPlayerLoading(true);

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

  function playVideo(video, autoplay) {
    currentVideo = video;
    pendingVideo = null;
    if (!ytApiReady) {
      pendingVideo = video;
      loadYouTubeApi();
      return;
    }
    if (ytPlayer && typeof ytPlayer.loadVideoById === "function") {
      pendingAutoplayAfterLoad = autoplay !== false;
      ytPlayer.loadVideoById(video.youtubeId);
      if (autoplay !== false && ytPlayer.playVideo) {
        try {
          ytPlayer.playVideo();
        } catch (_) {
          /* wait for CUED */
        }
      }
    } else {
      mountYtPlayer(video, autoplay !== false);
    }
    refreshUpNextUi();
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
    if (els.upnextDimEnd) els.upnextDimEnd.hidden = true;
    if (isLightsDown()) {
      if (els.upnextDim) els.upnextDim.hidden = false;
    } else if (els.upnextBar) {
      els.upnextBar.hidden = false;
    }
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
    if (els.upnextDimTitle) {
      els.upnextDimTitle.textContent = video.title;
    }
  }

  function syncUpNextModeUi() {
    if (!els.upnextModes) return;
    els.upnextModes.forEach(function (btn) {
      var on = btn.dataset.mode === nextMode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function syncUpNextPanels() {
    var down = isLightsDown();
    if (els.upnextFull) els.upnextFull.hidden = down;
    if (els.upnextDim) els.upnextDim.hidden = !down;
  }

  function refreshUpNextUi() {
    syncUpNextPanels();
    if (!currentVideo || !els.upnext) {
      if (els.upnext) els.upnext.hidden = true;
      return;
    }
    var next = resolveUpNext(currentVideo);
    pendingUpNext = next;
    if (!next) {
      els.upnext.hidden = true;
      return;
    }
    els.upnext.hidden = false;
    hideUpNextEnd();
    fillUpNextPreview(next);
    if (els.upnextPlay && !isLightsDown()) {
      els.upnextPlay.disabled = false;
      els.upnextPlay.textContent =
        nextMode === "series" ? "Next in series" : "Play random";
    }
  }

  function updateCountdownText() {
    if (!pendingUpNext) return;
    var label = upNextModeLabel() + " pick";
    var html =
      "<strong>" +
      escapeHtml(pendingUpNext.title) +
      "</strong> · " +
      label +
      " in <span>" +
      upNextCountdownSec +
      "s</span>";
    if (els.upnextCountdown) els.upnextCountdown.innerHTML = html;
    if (els.upnextDimCountdown) els.upnextDimCountdown.innerHTML = html;
  }

  function showUpNextCountdown(nextVideo, opts) {
    opts = opts || {};
    if (!nextVideo || !els.upnext) return;
    pendingUpNext = nextVideo;
    els.upnext.hidden = false;
    syncUpNextPanels();
    if (isLightsDown()) {
      if (els.upnextDim) els.upnextDim.hidden = true;
      if (els.upnextDimEnd) els.upnextDimEnd.hidden = false;
    } else {
      if (els.upnextBar) els.upnextBar.hidden = true;
      if (els.upnextEnd) els.upnextEnd.hidden = false;
    }
    fillUpNextPreview(nextVideo);
    clearUpNextCountdown();
    upNextCountdownSec =
      typeof opts.seconds === "number" ? opts.seconds : UPNEXT_COUNTDOWN_SEC;
    updateCountdownText();
    upNextTimer = setInterval(function () {
      upNextCountdownSec -= 1;
      if (upNextCountdownSec <= 0) {
        clearUpNextCountdown();
        goToUpNext({ fromCountdown: true });
        return;
      }
      updateCountdownText();
    }, 1000);
  }

  function cancelUpNext() {
    clearUpNextCountdown();
    hideUpNextEnd();
    refreshUpNextUi();
  }

  function resolveManualUpNext(cur) {
    if (!cur) return null;
    if (!isLightsDown() && nextMode === "series") {
      return pendingUpNext || resolveUpNext(cur);
    }
    var extra = [];
    if (pendingUpNext && pendingUpNext.id !== cur.id) {
      extra.push(pendingUpNext.id);
    }
    var next = pickRandomNext(cur, extra);
    if (next && next.id === cur.id && videos.length > 1) {
      extra.push(cur.id);
      next = pickRandomNext(cur, extra);
    }
    return next;
  }

  function goToUpNext(opts) {
    opts = opts || {};
    clearUpNextCountdown();
    hideUpNextEnd();
    if (!currentVideo) return;

    var keepLightsDown = isLightsDown();
    var prevId = currentVideo.id;
    var next = opts.fromCountdown
      ? pendingUpNext || resolveUpNext(currentVideo)
      : resolveManualUpNext(currentVideo);

    if (!next || next.id === currentVideo.id) return;

    if (keepLightsDown || nextMode === "random") {
      lastRandomId = prevId;
    }

    pushWatchStack(next.id);
    writeTheatreHistory(next, "push");
    loadTheatreVideo(next, { autoplay: true, keepLights: keepLightsDown });
  }

  function setUpNextMode(mode) {
    if (mode !== "random" && mode !== "series") return;
    if (isLightsDown()) return;
    nextMode = mode;
    try {
      sessionStorage.setItem(UPNEXT_MODE_KEY, mode);
    } catch (_) {
      /* ignore */
    }
    syncUpNextModeUi();
    refreshUpNextUi();
  }

  function loadUpNextMode() {
    try {
      var saved = sessionStorage.getItem(UPNEXT_MODE_KEY);
      if (saved === "random" || saved === "series") nextMode = saved;
    } catch (_) {
      /* ignore */
    }
    syncUpNextModeUi();
  }

  function initPopcornField() {
    var field = els.popcornField;
    if (!field || field.dataset.ready === "1" || reduced || !isTheatrePc()) return;
    field.dataset.ready = "1";

    var frag = document.createDocumentFragment();
    for (var i = 0; i < POPCORN_COUNT; i++) {
      var kernel = document.createElement("span");
      kernel.className = "film-theatre-popcorn-kernel";
      kernel.textContent = "\uD83C\uDF7F";
      var size = 0.72 + Math.random() * 0.85;
      var left = Math.random() * 100;
      var top = Math.random() * 100;
      var delay = Math.random() * 8;
      var dur = 4.5 + Math.random() * 5.5;
      var opacity = 0.12 + Math.random() * 0.22;
      kernel.style.cssText =
        "left:" +
        left +
        "%;top:" +
        top +
        "%;font-size:" +
        size +
        "rem;opacity:" +
        opacity +
        ";animation-duration:" +
        dur +
        "s;animation-delay:-" +
        delay +
        "s;";
      if (Math.random() > 0.78) {
        kernel.classList.add("film-theatre-popcorn-kernel--bright");
      }
      frag.appendChild(kernel);
    }
    field.appendChild(frag);
  }

  function initLightsPrompt() {
    try {
      if (!sessionStorage.getItem(LIGHTS_PROMPT_KEY)) {
        document.body.classList.add("film-theatre-awaiting-lights");
      }
    } catch (_) {
      document.body.classList.add("film-theatre-awaiting-lights");
    }
  }

  function dismissLightsPrompt() {
    document.body.classList.remove("film-theatre-awaiting-lights");
    try {
      sessionStorage.setItem(LIGHTS_PROMPT_KEY, "1");
    } catch (_) {
      /* ignore */
    }
  }

  function persistLightsState(on) {
    try {
      if (on) sessionStorage.setItem(THEATRE_LIGHTS_KEY, "1");
      else sessionStorage.removeItem(THEATRE_LIGHTS_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  function restoreLightsState() {
    try {
      if (sessionStorage.getItem(THEATRE_LIGHTS_KEY) === "1") {
        setLightsDown(true);
      }
    } catch (_) {
      /* ignore */
    }
  }

  function setLightsDown(on) {
    document.body.classList.toggle("film-theatre-lights-down", on);
    if (els.lightsBtn) {
      els.lightsBtn.setAttribute("aria-pressed", on ? "true" : "false");
      els.lightsBtn.textContent = on ? "Lights up" : "Lights down";
    }
    persistLightsState(on);
    if (on) dismissLightsPrompt();
    syncUpNextPanels();
    refreshUpNextUi();
  }

  function bindBack() {
    if (!els.backBtn) return;
    els.backBtn.addEventListener("click", function (e) {
      e.preventDefault();
      theatreBack();
    });
    window.addEventListener("popstate", onTheatrePopState);
  }

  function bindLights() {
    if (!els.lightsBtn) return;
    els.lightsBtn.addEventListener("click", function () {
      var on = !isLightsDown();
      setLightsDown(on);
      if (!on) {
        document.body.classList.add("film-theatre-lights-up-burst");
        window.setTimeout(function () {
          document.body.classList.remove("film-theatre-lights-up-burst");
        }, 700);
      }
    });
  }

  function bindUpNext() {
    if (els.upnextPlay) {
      els.upnextPlay.addEventListener("click", function () {
        goToUpNext({});
      });
    }
    if (els.upnextDimPlay) {
      els.upnextDimPlay.addEventListener("click", function () {
        goToUpNext({});
      });
    }
    if (els.upnextPlayNow) {
      els.upnextPlayNow.addEventListener("click", function () {
        goToUpNext({ fromCountdown: true });
      });
    }
    if (els.upnextDimPlayNow) {
      els.upnextDimPlayNow.addEventListener("click", function () {
        goToUpNext({ fromCountdown: true });
      });
    }
    if (els.upnextCancel) {
      els.upnextCancel.addEventListener("click", cancelUpNext);
    }
    if (els.upnextDimCancel) {
      els.upnextDimCancel.addEventListener("click", cancelUpNext);
    }
    if (els.upnextModes) {
      els.upnextModes.forEach(function (btn) {
        btn.addEventListener("click", function () {
          var mode = btn.dataset.mode;
          if (mode === "random" && mode === nextMode) {
            refreshUpNextUi();
            return;
          }
          setUpNextMode(mode);
        });
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var endVisible =
        (els.upnextEnd && !els.upnextEnd.hidden) ||
        (els.upnextDimEnd && !els.upnextDimEnd.hidden);
      if (endVisible) cancelUpNext();
    });
  }

  async function init() {
    bindBack();
    bindLights();
    bindUpNext();
    initPopcornField();
    initLightsPrompt();
    loadUpNextMode();
    loadYouTubeApi();

    if (!isTheatrePc()) {
      showError("Theatre mode is desktop-only. Use the film hub player on mobile.");
      return;
    }

    var videoId = resolveVideoId();
    if (!videoId) {
      showError("No film selected. Open Theatre mode from the film hub.");
      return;
    }

    try {
      var res = await fetch(VIDEOS_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      catalog = await res.json();
      videos = catalog.videos || [];
      var video = findVideo(videoId);
      if (!video) throw new Error("Video not found in catalog.");

      if (video.theatre && video.theatre.enabled === false) {
        showError("Theatre mode is not available for this title.");
        return;
      }

      var registry = null;
      try {
        var regRes = await fetch(REGISTRY_URL, { cache: "no-store" });
        if (regRes.ok) {
          registry = await regRes.json();
          catalog._theatreRegistry = registry;
        }
      } catch (_) {
        /* registry optional */
      }

      var entry = findRegistryEntry(registry, video);
      currentVideo = video;
      initWatchStack(video.id);
      writeTheatreHistory(video, "replace");
      fillCopy(video, entry);
      restoreLightsState();
      playVideo(video, false);
    } catch (err) {
      console.error("Theatre mode:", err);
      showError(
        "Could not load this theatre presentation. Try again from the film hub."
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();