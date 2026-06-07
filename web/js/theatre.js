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

  /* =====================================================================
     LIGHTS PERSISTENCE
     We store the user's "lights down" preference in sessionStorage under
     THEATRE_LIGHTS_KEY. On subsequent video loads (including cross-video
     "keep lights" handoff) we re-apply the class and re-size the player.
     IMPORTANT: Default arrival (direct link or refresh with no prior toggle)
     is ALWAYS lights-on with full chrome. The early auto-apply inline script
     was removed from the HTMLs to prevent unwanted immersive start.
     ===================================================================== */

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
  var randomBag = [];
  var pendingUpNext = null;
  var upNextTimer = null;
  var upNextCountdownSec = 0;
  var endWatchTimer = null;
  var endTriggered = false;
  var watchStack = [];
  var suppressPopstate = false;
  var CHROME_IDLE_MS = 2500;
  var chromeIdleTimer = null;
  var chromeIdleBound = false;
  var pendingLightsRestore = false;

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
    upnextPreview: document.getElementById("theatre-upnext-preview"),
    upnextThumb: document.getElementById("theatre-upnext-thumb"),
    upnextKicker: document.getElementById("theatre-upnext-kicker"),
    upnextTitle: document.getElementById("theatre-upnext-title"),
    upnextMeta: document.getElementById("theatre-upnext-meta"),
    upnextPlay: document.getElementById("theatre-upnext-play"),
    upnextCountdown: document.getElementById("theatre-upnext-countdown"),
    upnextEndTap: document.getElementById("theatre-upnext-end-tap"),
    upnextCancel: document.getElementById("theatre-upnext-cancel"),
    upnextPlayNow: document.getElementById("theatre-upnext-play-now"),
    upnextDimTap: document.getElementById("theatre-upnext-dim-tap"),
    upnextDimTitle: document.getElementById("theatre-upnext-dim-title"),
    upnextDimEndTap: document.getElementById("theatre-upnext-dim-end-tap"),
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

  function shuffleIds(ids) {
    var list = ids.slice();
    var i = list.length - 1;
    for (; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  function refillRandomBag(exclude) {
    var blocked = exclude || new Set();
    var ids = videos
      .map(function (v) {
        return v.id;
      })
      .filter(function (id) {
        return !blocked.has(id);
      });
    if (!ids.length) {
      ids = videos.map(function (v) {
        return v.id;
      });
    }
    randomBag = shuffleIds(ids);
  }

  function pickRandomNext(current, extraExclude) {
    if (!videos.length) return null;
    if (videos.length === 1) {
      return videos[0].id === current.id ? null : videos[0];
    }

    var exclude = new Set([current.id]);
    if (lastRandomId) exclude.add(lastRandomId);
    if (extraExclude) {
      extraExclude.forEach(function (id) {
        if (id) exclude.add(id);
      });
    }

    randomBag = randomBag.filter(function (id) {
      return !exclude.has(id);
    });
    if (!randomBag.length) refillRandomBag(exclude);

    if (!randomBag.length) {
      var pool = videos.filter(function (v) {
        return !exclude.has(v.id);
      });
      if (!pool.length) return null;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    return findVideo(randomBag.shift());
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
        "Lights down anytime — full immersion.";
      els.popcorn.textContent = cue;
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
    if (keepLightsDown && !isLightsDown()) {
      applyLightsDownDom(true);
    }
    syncBackButton();
    syncPlayerSize();
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
      /* Critical for first-load in lights-on: when the YT API script loads
         asynchronously after playVideo() set pendingVideo and returned early
         (without reaching the refreshUpNextUi() call), we must explicitly
         refresh the up-next bar here. This ensures the full "UP NEXT" nav bar
         (with thumbnail, title, Random/Series buttons and Play) appears
         immediately below the video on initial landing in lights-on mode,
         instead of only after a lights toggle forces another refresh.
         Also re-check lights restore for consistency. */
      refreshUpNextUi();
      tryPendingLightsRestore();
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
    var next = pendingUpNext || resolveUpNext(currentVideo);
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

    /* Bootstrap a reasonable size on the host container immediately.
       YT.Player at creation time often snapshots whatever size (or 0-size) the host has.
       Giving the inner host an explicit starting size helps the iframe appear with a
       visible frame even before the later syncPlayerSize runs. The values are overwritten
       by setSize once layout settles. Use a higher ceiling so lights-down bigger video
       path gets a good initial frame instead of a small centered box that later "jumps". */
    var host = document.getElementById(hostId);
    if (host && els.player) {
      var stageW = (els.stage && els.stage.clientWidth) || els.player.offsetWidth || 720;
      var bootCap = isLightsDown() ? 1280 : 960;
      var bootW = Math.min(Math.max(stageW, 640), bootCap);
      /* Use slightly taller boot height in lights-down so the initial frame already
         has room for the full YouTube chrome inside our gold border (avoids the
         flash of clipped bottom controls before the first syncPlayerSize runs). */
      var bootRatio = isLightsDown() ? (9 / 16 * 1.04) : (9 / 16);
      var bootH = Math.round(bootW * bootRatio);
      host.style.width = bootW + 'px';
      host.style.height = bootH + 'px';
    }

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
          tryPendingLightsRestore();
          syncPlayerSize();
          setTimeout(syncPlayerSize, 220);
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
      /* Call these even in the pending path so the UP NEXT nav bar (full lights-on version)
         gets populated and shown right away on first land, while the player is still cueing.
         The async onYouTubeIframeAPIReady will call them again after mount for safety. */
      refreshUpNextUi();
      tryPendingLightsRestore();
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
    tryPendingLightsRestore();
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

  function upNextPlayLabel() {
    return isLightsDown() || nextMode === "random"
      ? "Play next"
      : "Next in series";
  }

  function previewAriaLabel(video) {
    return "Play up next: " + video.title + " (" + video.series + ")";
  }

  function fillUpNextPreview(video) {
    if (!video) return;
    var label = previewAriaLabel(video);
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
    if (els.upnextPreview) els.upnextPreview.setAttribute("aria-label", label);
    if (els.upnextEndTap) els.upnextEndTap.setAttribute("aria-label", label);
    if (els.upnextDimTap) els.upnextDimTap.setAttribute("aria-label", label);
    if (els.upnextDimEndTap) {
      els.upnextDimEndTap.setAttribute("aria-label", label);
    }
  }

  function reshuffleUpNextPreview() {
    if (!currentVideo) return;
    if (!isLightsDown() && nextMode !== "random") {
      refreshUpNextUi();
      return;
    }
    var extra = [];
    if (pendingUpNext && pendingUpNext.id !== currentVideo.id) {
      extra.push(pendingUpNext.id);
    }
    var next = pickRandomNext(currentVideo, extra);
    pendingUpNext = next;
    if (!next) {
      if (els.upnext) els.upnext.hidden = true;
      return;
    }
    if (els.upnext) els.upnext.hidden = false;
    hideUpNextEnd();
    fillUpNextPreview(next);
    if (els.upnextPlay && !isLightsDown()) {
      els.upnextPlay.disabled = false;
      els.upnextPlay.textContent = upNextPlayLabel();
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
      els.upnextPlay.textContent = upNextPlayLabel();
    }
  }

  function updateCountdownText() {
    if (!pendingUpNext) return;
    var label =
      !isLightsDown() && nextMode === "series"
        ? "Next in series"
        : "Random pick";
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
      wakeDimChrome();
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

  function goToUpNext(opts) {
    opts = opts || {};
    clearUpNextCountdown();
    hideUpNextEnd();
    if (!currentVideo) return;

    var keepLightsDown = isLightsDown();
    var prevId = currentVideo.id;
    var next = pendingUpNext || resolveUpNext(currentVideo);

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
    var endVisible =
      (els.upnextEnd && !els.upnextEnd.hidden) ||
      (els.upnextDimEnd && !els.upnextDimEnd.hidden);
    if (endVisible && currentVideo) {
      pendingUpNext = resolveUpNext(currentVideo);
      if (pendingUpNext) {
        fillUpNextPreview(pendingUpNext);
        updateCountdownText();
      }
    } else {
      refreshUpNextUi();
    }
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
        pendingLightsRestore = true;
      }
    } catch (_) {
      /* ignore */
    }
  }

  function clearChromeIdleTimer() {
    if (chromeIdleTimer) {
      window.clearTimeout(chromeIdleTimer);
      chromeIdleTimer = null;
    }
  }

  function scheduleDimChromeIdle() {
    clearChromeIdleTimer();
    if (!isLightsDown() || reduced) return;
    chromeIdleTimer = window.setTimeout(function () {
      if (isLightsDown()) {
        document.body.classList.add("film-theatre-chrome-idle");
      }
    }, CHROME_IDLE_MS);
  }

  function wakeDimChrome() {
    if (!isLightsDown()) return;
    document.body.classList.remove("film-theatre-chrome-idle");
    scheduleDimChromeIdle();
  }

  function onChromeActivity() {
    wakeDimChrome();
  }

  function startChromeIdleWatch() {
    if (reduced) return;
    if (!chromeIdleBound) {
      chromeIdleBound = true;
      ["mousemove", "mousedown", "keydown", "wheel", "touchstart"].forEach(
        function (name) {
          document.addEventListener(name, onChromeActivity, { passive: true });
        }
      );
    }
    wakeDimChrome();
  }

  function stopChromeIdleWatch() {
    clearChromeIdleTimer();
    document.body.classList.remove("film-theatre-chrome-idle");
    if (!chromeIdleBound) return;
    chromeIdleBound = false;
    ["mousemove", "mousedown", "keydown", "wheel", "touchstart"].forEach(
      function (name) {
        document.removeEventListener(name, onChromeActivity);
      }
    );
  }

  function applyLightsDownDom(on) {
    document.body.classList.toggle("film-theatre-lights-down", on);
    if (els.lightsBtn) {
      els.lightsBtn.setAttribute("aria-pressed", on ? "true" : "false");
      els.lightsBtn.textContent = on ? "Lights up" : "Lights down";
    }
    persistLightsState(on);
    if (on) {
      dismissLightsPrompt();
      startChromeIdleWatch();
    } else {
      stopChromeIdleWatch();
    }
    syncUpNextPanels();
    refreshUpNextUi();

    syncPlayerSize();
  }

  function syncPlayerSize() {
    /* Force the YouTube iframe to the final laid-out size of .film-theatre-player.
       This is the heart of making the video "appear" reliably.

       Why it's needed:
       - Normal (lights-on) mode: deep flex column (main > screen > stage > mount > player).
         Even with min-height on the mount and aspect-ratio on the player, at the moment
         YT.Player is created and onReady fires the getBoundingClientRect can still be
         tiny or 0 because ancestors are still sizing (titles, action-bar, up-next, and
         whatever wrapper gives the page its height).
       - Lights-down: the stage is position:fixed; inset:0 with explicit padding; the
         player gets an explicit vw/dvh size via CSS. The class toggle + this function
         re-measures after the layout change.
       - YT IFrame API frequently bakes in whatever size the host div has at creation
         time. Calling player.setSize(w, h) afterwards is the documented way to resize.

       We try multiple times (rAF + short timeouts) and have a fallback that computes
       a sensible cinematic 16:9 from the stage width when the measured rect is still
       unrealistically small. We also write explicit style w/h on the player element
       so the gold border and the absolute iframe context become visible immediately. */
    if (!ytPlayer || typeof ytPlayer.setSize !== 'function' || !els.player) return;

    function applySize(w, h) {
      if (!ytPlayer || !els.player) return;
      ytPlayer.setSize(Math.round(w), Math.round(h));
      // Make the theatre frame (border + shadow + bg) visible even if CSS aspect
      // calc is still fighting with flex/cqw in this particular viewport.
      els.player.style.width = Math.round(w) + 'px';
      els.player.style.height = Math.round(h) + 'px';
    }

    function doSync() {
      if (!ytPlayer || !els.player) return;
      var r = els.player.getBoundingClientRect();
      var w = r.width;
      var h = r.height;

      // If we still have a collapsed rect (common in normal flow on first passes),
      // compute a good default from the stage's actual width. This is the
      // "something we were missing" safety net.
      if (h < 120) {
        var stage = els.stage || document.querySelector('.film-theatre-stage');
        var basis = (stage && stage.clientWidth) || w || 800;
        if (isLightsDown()) {
          /* Lights-down supports the bigger cinematic size (82vw goal). Compute a
             slightly taller box than pure 16/9 so the gold frame fully wraps the
             YouTube embed including its native title bar and bottom progress/controls
             (prevents the "frame cutting off the video" seen in the screenshot).
             ~4% extra height + the CSS aspect-ratio:16/9.25 + max-h reserve ensures
             the entire player UI sits inside the decorative border with no clipping
             while still delivering the slight enlargement the user requested. */
          var target = Math.round(basis * 0.82);
          w = Math.max(720, Math.min(target, Math.floor(basis * 0.92)));
          h = Math.round(w * 9 / 16 * 1.04);
        } else {
          w = Math.min(Math.max(basis, 640), 960);
          h = w * 9 / 16;
        }
      }

      if (w > 50 && h > 22) {
        /* In lights-down, ensure the explicit size we give the gold frame is tall
           enough to fully contain the YouTube player's chrome (title + progress bar
           + buttons). This directly addresses the clipping visible in the provided
           screenshot where the bottom of the YT UI was cut by the decorative border. */
        if (isLightsDown()) {
          var videoOnlyH = w * 9 / 16;
          var withChrome = Math.round(videoOnlyH * 1.04);
          if (h < withChrome) h = withChrome;
        }
        applySize(w, h);
      }
    }

    // First attempt as soon as the browser has painted the current layout pass.
    requestAnimationFrame(doSync);

    // Normal flex layout (kicker, title, meta, action-bar inside stage, up-next)
    // often needs one or two more frames. Also covers the case where a lights toggle
    // just happened and the fixed vs flow sizes are still settling.
    setTimeout(doSync, 140);
    setTimeout(doSync, 380);
  }

  function tryPendingLightsRestore() {
    if (!pendingLightsRestore || isLightsDown()) return;
    pendingLightsRestore = false;
    applyLightsDownDom(true);
  }

  function setLightsDown(on) {
    applyLightsDownDom(on);
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
    if (els.upnextPreview) {
      els.upnextPreview.addEventListener("click", function () {
        goToUpNext({});
      });
    }
    if (els.upnextEndTap) {
      els.upnextEndTap.addEventListener("click", function () {
        goToUpNext({ fromCountdown: true });
      });
    }
    if (els.upnextDimTap) {
      els.upnextDimTap.addEventListener("click", function () {
        goToUpNext({});
      });
    }
    if (els.upnextDimEndTap) {
      els.upnextDimEndTap.addEventListener("click", function () {
        goToUpNext({ fromCountdown: true });
      });
    }
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
            reshuffleUpNextPreview();
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
      requestAnimationFrame(tryPendingLightsRestore);
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