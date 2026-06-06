/**
 * daCAT Film — Theatre mode (immersive full-screen watch).
 * Resolves video from body[data-video-id] or ?v=; theme from theatre_registry.json.
 */
(function () {
  "use strict";

  var VIDEOS_URL = new URL("../../data/videos.json", window.location.href).href;
  var REGISTRY_URL = new URL("../../data/theatre_registry.json", window.location.href).href;

  var els = {
    title: document.getElementById("theatre-title"),
    series: document.getElementById("theatre-series"),
    meta: document.getElementById("theatre-meta"),
    popcorn: document.getElementById("theatre-popcorn"),
    player: document.getElementById("theatre-player"),
    loading: document.getElementById("theatre-loading"),
    error: document.getElementById("theatre-error"),
    ytLink: document.getElementById("theatre-yt"),
    lightsBtn: document.getElementById("theatre-lights"),
  };

  function $(id) {
    return document.getElementById(id);
  }

  function resolveVideoId() {
    var fromBody = document.body.getAttribute("data-video-id");
    if (fromBody) return fromBody.trim();
    return (new URLSearchParams(window.location.search).get("v") || "").trim();
  }

  function findVideo(catalog, id) {
    return (catalog.videos || []).find(function (v) {
      return v.id === id;
    });
  }

  function findRegistryEntry(registry, video) {
    if (!registry || !video || !video.theatre) return null;
    var slug = video.theatre.slug;
    if (!slug || !registry.theatres) return null;
    return registry.theatres[slug] || null;
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
        "Grab popcorn — lights down.";
      els.popcorn.textContent = "\uD83C\uDF7F " + cue;
    }
    document.title =
      (video.title || "Film") + " · Theatre mode · daCAT";
  }

  function embedUrl(youtubeId) {
    return (
      "https://www.youtube-nocookie.com/embed/" +
      encodeURIComponent(youtubeId) +
      "?rel=0&modestbranding=1"
    );
  }

  function showError(msg) {
    if (els.loading) els.loading.hidden = true;
    if (els.error) {
      els.error.hidden = false;
      els.error.textContent = msg;
    }
  }

  function mountPlayer(video) {
    if (!els.player) return;
    els.player.innerHTML =
      '<iframe src="' +
      embedUrl(video.youtubeId) +
      '" title="' +
      (video.title || "YouTube player").replace(/"/g, "") +
      '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>';
    if (els.loading) els.loading.hidden = true;
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

  function bindLights() {
    if (!els.lightsBtn) return;
    els.lightsBtn.addEventListener("click", function () {
      var on = document.body.classList.toggle("film-theatre-lights-down");
      els.lightsBtn.setAttribute("aria-pressed", on ? "true" : "false");
      els.lightsBtn.textContent = on ? "Lights up" : "Lights down";
    });
  }

  async function init() {
    bindLights();
    var videoId = resolveVideoId();
    if (!videoId) {
      showError("No film selected. Open Theatre mode from the film hub.");
      return;
    }

    try {
      var res = await fetch(VIDEOS_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      var catalog = await res.json();
      var video = findVideo(catalog, videoId);
      if (!video) throw new Error("Video not found in catalog.");

      if (!video.theatre || video.theatre.enabled === false) {
        showError("Theatre mode is not enabled for this title yet.");
        return;
      }

      var registry = null;
      try {
        var regRes = await fetch(REGISTRY_URL, { cache: "no-store" });
        if (regRes.ok) registry = await regRes.json();
      } catch (_) {
        /* registry optional at runtime */
      }

      var entry = findRegistryEntry(registry, video);
      fillCopy(video, entry);
      mountPlayer(video);
    } catch (err) {
      console.error("Theatre mode:", err);
      showError("Could not load this theatre presentation. Try again from the film hub.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();