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

  // Force refresh / direct load to always start in lights-on mode (user requirement).
  // This clears any persisted "lights down" from a previous visit so the player
  // mounts at the correct in-flow size with the gold frame enclosing the full YT card.
  try { sessionStorage.removeItem(THEATRE_LIGHTS_KEY); } catch (_) {}

  /* =====================================================================
     LIGHTS PERSISTENCE
     We store the user's "lights down" preference in sessionStorage under
     THEATRE_LIGHTS_KEY. On subsequent video loads (including cross-video
     "keep lights" handoff) we re-apply the class and re-size the player.
     IMPORTANT: Default arrival (direct link or refresh with no prior toggle)
     is ALWAYS lights-on with full chrome. The early auto-apply inline script
     was removed from the HTMLs to prevent unwanted immersive start.
     (See also CSS for .film-theater-frame.is-active and player sizing.)
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

  /* === State & DOM refs (similar pattern to film.js but isolated for Theatre Mode) === */
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
    actionBar: document.getElementById("theatre-action-bar"),
    stage: document.querySelector('.film-theatre-stage'),
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
    // Re-sync player size when using the Film hub back button or browser back.
    // Layout (including upnext and reserves) can be in a different state than when
    // we left, so make sure the gold border re-expands to fit full YT chrome.
    setTimeout(syncPlayerSize, 80);
    setTimeout(syncPlayerSize, 300);

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

  /* === YouTube + Player bootstrap (Theatre uses separate YT player instance) === */
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
      // Extra late safety net for first-load or "came back to the page" cases where
      // upnext + reserve + YT chrome settle in an order that leaves the gold border
      // clipping the bottom controls. Gives layout full time to stabilize.
      setTimeout(syncPlayerSize, 650);
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

    /* Bootstrap a reasonable size on the host container immediately (stable first load).
       Uses the same conservative viewport/stage-based calc as the new syncPlayerSize so the
       initial YT snapshot + gold frame is already the correct large size in lights-down and
       correctly fitting in lights-on, eliminating the "jumps" or "tiny then cutoff on refresh" races. */
    var host = document.getElementById(hostId);
    if (host && els.player) {
      var isDownBoot = isLightsDown();
      var stageWBoot = (els.stage && els.stage.clientWidth) || els.player.offsetWidth || Math.round(window.innerWidth * 0.8);
      if (isDownBoot) {
        // Match the updated stable logic for first-paint in lights-down.
        var contentWBoot = stageWBoot;
        var contentHBoot = (els.stage && els.stage.clientHeight) || 600;
        var safetyBoot = 24;
        var maxWBoot = contentWBoot - (safetyBoot * 2);
        var maxHBoot = contentHBoot - (safetyBoot * 2);
        var bootW = Math.min(contentWBoot * 0.88, maxWBoot);
        bootW = Math.max(720, Math.min(bootW, maxWBoot));
        var bootVideoH = bootW * 9 / 16;
        var bootExtra = 28;
        var bootH = Math.round(bootVideoH + bootExtra);
        if (bootH > maxHBoot) {
          bootH = maxHBoot;
          bootW = Math.round((bootH - bootExtra) * 16 / 9);
        }
        host.style.width = Math.round(bootW) + 'px';
        host.style.height = Math.round(bootH) + 'px';
      } else {
        // lights-up bootstrap - use the new smaller target cap (900px) for consistency with
        // the 15-20% reduction in frame size.
        var bootCap = 800;
        var bootW = Math.min(Math.max(stageWBoot, 640), bootCap);
        var bootExtra = 62;
        var bootH = Math.round(bootW * 9 / 16 + bootExtra);
        host.style.width = bootW + 'px';
        host.style.height = bootH + 'px';
      }
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
      setTimeout(syncPlayerSize, 720);
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
    // Late safety sync for initial loads and back/forward navigation. Ensures that
    // even if upnext banner + final reserve settle after the earlier rAF/timeouts,
    // the gold player box grows to fit the complete YouTube chrome instead of
    // getting stuck with the bottom controls cut off by the border.
    setTimeout(syncPlayerSize, 720);
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

    // Up-next bar visibility updates the :has() rule that changes --theatre-ui-reserve.
    // This can immediately tighten the CSS max-height on the player. Re-sync so the
    // gold border box is (re)sized to fit the full YouTube chrome (progress + controls)
    // instead of the bottom getting clipped. Covers the "odd cutoff that appears after
    // refresh or first load when upnext banner settles".
    setTimeout(syncPlayerSize, 60);
    setTimeout(syncPlayerSize, 220);
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
      /* When entering lights-down, immediately clear any lights-up bar sizing so the
         fixed glass action bar (left/right + no max cap) takes over cleanly without
         a narrow maxWidth left over from lights-up. This ensures no skew/short bar in down mode. */
      if (els.actionBar) {
        els.actionBar.style.width = '';
        els.actionBar.style.maxWidth = '';
        els.actionBar.style.marginLeft = '';
        els.actionBar.style.marginRight = '';
      }
    } else {
      stopChromeIdleWatch();
    }
    syncUpNextPanels();
    refreshUpNextUi();

    syncPlayerSize();
  }

  function syncPlayerSize() {
    /* Stable first-load and resize-aware player sizing.
       Rewritten for reliability (previous version had races between measurement, upnext :has var,
       flex settling, YT creation time snapshot, and CSS max-heights causing right/bottom cutoff on
       some loads/refresh cycles).

       Strategy (prioritizes stability + correct on first paint):
       - Always compute target size from reliable inputs: stage width (or viewport) + known reserves.
       - Cap conservatively so the final explicit size + border/padding NEVER exceeds the available
         space in ancestors (prevents overflow:hidden clipping on screen/stage/mount).
       - Slightly larger player in lights-down (85% frac vs ~78-82%).
       - Still write explicit w/h on player (for gold frame to show immediately) and call YT setSize.
       - Combined with ResizeObserver + load/resize listeners for ongoing correctness.
       - The gold frame now reliably fits the full YT chrome without cutoff on first load in both modes. */
    if (!ytPlayer || typeof ytPlayer.setSize !== 'function' || !els.player) return;

    function applySize(w, h) {
      if (!ytPlayer || !els.player) return;
      var rw = Math.round(w);
      var rh = Math.round(h);
      ytPlayer.setSize(rw, rh);
      els.player.style.width = rw + 'px';
      els.player.style.height = rh + 'px';
    }

    var isDown = isLightsDown();
    var stage = els.stage || document.querySelector('.film-theatre-stage');

    if (isDown) {
      // === LIGHTS-DOWN ONLY (lights-up path left untouched per user request) ===
      // The core issue was that the player size was not respecting the actual "video screen box"
      // defined by the stage's current padding and layout. The stage padding (currently 2.5rem top / 0.75rem bottom)
      // creates the safe letterbox area where the fixed top action bar (Film hub / Lights up) and bottom up-next live.
      // By querying the stage's *actual client dimensions* (which already subtract the padding for the content area),
      // we size the player to fill most of that inner box. This prevents intrusion into the top bar area
      // and makes the gold frame + video expand to match the available larger box in lights-down.
      // The YT inner will scale with the set size.
      // We use the actual stage at sync time (after layout) + safety margin inside the content area.
      var contentW = stage ? stage.clientWidth : (window.innerWidth * 0.9);
      var contentH = stage ? stage.clientHeight : (window.innerHeight * 0.7);

      // Leave a small safety letterbox *inside* the content area (in addition to stage padding)
      // so the gold frame doesn't touch the very edge of the "box" and to ensure the fixed bars
      // (which sit in the stage padding) are not overlapped by the frame.
      var safety = 30; // px on each side - increased to match larger stage padding for top bar clearance
      var maxW = contentW - (safety * 2);
      var maxH = contentH - (safety * 2);

      var w = Math.min(contentW * 0.90, maxW);  // 90% of the *actual content box* for slightly larger fill in lights-down
      w = Math.max(720, Math.min(w, maxW));

      var videoOnlyH = w * 9 / 16;
      var chromeExtra = 28;
      var totalH = Math.round(videoOnlyH + chromeExtra);

      if (totalH > maxH) {
        totalH = maxH;
        w = Math.round((totalH - chromeExtra) * 16 / 9);
        w = Math.max(640, Math.min(w, maxW));
      }

      applySize(w, totalH);

      /* Lights-down: explicitly clear any lights-up action bar width/maxWidth/margin styles
         so the lights-down fixed positioning (left/right + glass pill + max-width:none) fully
         controls the bar without interference from the up-mode "match player" logic.
         This reverts any side-effects on lights-down and keeps the two modes completely isolated. */
      if (els.actionBar) {
        els.actionBar.style.width = '';
        els.actionBar.style.maxWidth = '';
        els.actionBar.style.marginLeft = '';
        els.actionBar.style.marginRight = '';
      }
      return;
    }

    // === LIGHTS-UP / DEFAULT PATH — 15-20% smaller target frame size (900px cap instead of 1080px)
    // so the gold-bordered video + player is more comfortable on screen. The frac + safety keep
    // it nicely proportioned and with breathing room. The mount min-width and upnext caps keep
    // the size stable and independent of the Up Next title/series bar. Lights-up only.
    // Use a stable base for width measurement (screen or main) so the upnext bar/title below
    // cannot influence the stage.clientWidth and cause the player to "move" or resize on refresh.
    var screenEl = document.querySelector('.film-theatre-screen');
    var mainEl = document.querySelector('.film-theatre-main');
    var baseW = (screenEl && screenEl.clientWidth) || (mainEl && mainEl.clientWidth) || (stage && stage.clientWidth) || window.innerWidth * 0.8;

    /* Lights-up: noticeably smaller player so the up-next bar (with Random/Series) is always visible
       right under the gold frame at 100% zoom and "rests" above the footer area. Title must truncate. */
    var frac = 0.72;
    var maxW = Math.min(baseW * frac, 880);
    var w = Math.max(600, Math.min(maxW, baseW - 40));

    var videoH = w * 9 / 16;
    var chromeExtra = 62;
    var totalH = Math.round(videoH + chromeExtra);

    var vh = window.innerHeight || 800;
    var topReserve = 100;
    var bottomReserve = 140; // generous room for the full upnext bar so it doesn't get pushed off at 100%
    var maxAvailH = vh - topReserve - bottomReserve - 5;
    if (totalH > maxAvailH) {
      totalH = Math.max(340, maxAvailH);
      w = Math.round((totalH - chromeExtra) * 16 / 9);
      w = Math.max(480, Math.min(w, baseW - 30));
      totalH = Math.round((w * 9 / 16) + chromeExtra);
    }

    applySize(w, totalH);

    /* Lock BOTH action bar and upnext bar to the exact final player width using !important.
       This guarantees the bar cannot expand based on title length and cannot cause reflow/shift
       of the video frame above it. Long titles will be cut off by the existing clamp on .film-upnext-title. */
    var actual = els.player.offsetWidth || Math.round(w);
    var lockW = actual + 'px';

    if (els.actionBar) {
      els.actionBar.style.setProperty('width', '100%', 'important');
      els.actionBar.style.setProperty('max-width', lockW, 'important');
      els.actionBar.style.setProperty('margin-left', 'auto', 'important');
      els.actionBar.style.setProperty('margin-right', 'auto', 'important');
    }

    if (els.upnext) {
      els.upnext.style.setProperty('max-width', lockW, 'important');
      els.upnext.style.setProperty('width', lockW, 'important');
    }
    if (els.upnextBar) {
      els.upnextBar.style.setProperty('max-width', lockW, 'important');
      els.upnextBar.style.setProperty('width', lockW, 'important');
    }
    if (els.upnextPreview) {
      els.upnextPreview.style.maxWidth = '100%';
    }
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

  /* === Reliable resize handling to fix race conditions in player sizing on first load and layout changes === */
  var resizeDebounce = null;
  function setupReliableSizing() {
    // Window resize
    window.addEventListener('resize', function () {
      if (resizeDebounce) clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(syncPlayerSize, 100);
    });

    // ResizeObserver on key containers for layout changes (upnext show/hide, fonts, etc) without race
    if (typeof ResizeObserver !== 'undefined') {
      try {
        var ro = new ResizeObserver(function () {
          if (resizeDebounce) clearTimeout(resizeDebounce);
          resizeDebounce = setTimeout(syncPlayerSize, 60);
        });
        if (els.stage) ro.observe(els.stage);
        if (els.player) ro.observe(els.player);
        if (els.upnext) ro.observe(els.upnext);
      } catch (e) { /* observer optional */ }
    }

    // Extra safety call after full load
    window.addEventListener('load', function () {
      setTimeout(syncPlayerSize, 150);
      setTimeout(syncPlayerSize, 450);
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
    setupReliableSizing();

    if (!isTheatrePc()) {
      showError("Theatre mode is desktop-only. Use the film hub player on mobile.");
      return;
    }

    var videoId = resolveVideoId();
    if (!videoId) {
      showError("No film selected. Open Theatre mode from the film hub.");
      return;
    }

    /* Data load uses no-store + explicit cache bust from meta to stay fresh with daily video registry updates. */
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

      /* Force lights-on on every full page load / refresh (including when the URL is
         reloaded while the user was previously in lights-down). This matches the
         documented default behavior ("Default arrival ... is ALWAYS lights-on") and
         prevents the "video shrinks very small randomly" symptom that occurred when
         the lights-down class + its different layout/sizing was applied during the
         very first player mount and syncPlayerSize passes. In-session toggles and
         cross-video "keep lights" handoff still respect the stored preference. */
      try {
        sessionStorage.removeItem(THEATRE_LIGHTS_KEY);
      } catch (_) {}
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