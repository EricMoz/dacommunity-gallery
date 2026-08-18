/**
 * Home page — Community Highlights rail (film catalog snippets).
 * Same pool as film hub Featured (videos.json featuredIds), randomized each visit.
 */
(function () {
  /* highlights-shuffle build 20260818-8 */
  "use strict";

  var MAX_HIGHLIGHTS = 6;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Fisher–Yates — same idea as film hub Featured random order. */
  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function resolveFeaturedIds(catalog) {
    var ids = [];
    if (catalog.featuredIds && catalog.featuredIds.length) {
      ids = catalog.featuredIds.slice();
    } else {
      ids = (catalog.videos || [])
        .filter(function (v) {
          return v.featuredPick;
        })
        .sort(function (a, b) {
          return (a.featuredOrder || 99) - (b.featuredOrder || 99);
        })
        .map(function (v) {
          return v.id;
        });
    }
    return shuffle(ids).slice(0, MAX_HIGHLIGHTS);
  }

  async function init() {
    var rail = document.getElementById("home-highlights-rail");
    var track = document.getElementById("home-highlights-track");
    if (!rail || !track) return;

    try {
      var url = new URL("data/videos.json", window.location.href).href;
      var res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      var catalog = await res.json();
      var byId = {};
      (catalog.videos || []).forEach(function (v) {
        byId[v.id] = v;
      });

      var ids = resolveFeaturedIds(catalog);
      var cards = [];
      ids.forEach(function (id) {
        var video = byId[id];
        if (video) cards.push(video);
      });

      if (!cards.length) {
        rail.hidden = true;
        return;
      }

      var countEl = document.getElementById("film-video-count");
      if (countEl && catalog.videos) {
        countEl.textContent = catalog.videos.length + " videos on-site";
      }

      rail.hidden = false;
      track.innerHTML = "";
      cards.forEach(function (video) {
        var category = video.series || "Film";
        var title = video.title || video.id;
        var link = document.createElement("a");
        link.className = "highlight-card";
        link.href = "film/?v=" + encodeURIComponent(video.id);
        link.setAttribute("role", "listitem");
        link.setAttribute(
          "aria-label",
          category + ": " + title + ". Watch on film hub."
        );
        var duration = video.duration || "";
        link.innerHTML =
          '<span class="highlight-card-thumb">' +
          '<img src="' +
          escapeHtml(video.thumbnail) +
          '" alt="" loading="lazy" width="320" height="180" />' +
          '<span class="highlight-card-play" aria-hidden="true"></span>' +
          (duration
            ? '<span class="highlight-card-duration">' + escapeHtml(duration) + "</span>"
            : "") +
          "</span>" +
          '<span class="highlight-card-body">' +
          '<span class="highlight-card-category">' +
          escapeHtml(category) +
          "</span>" +
          '<span class="highlight-card-title">' +
          escapeHtml(title) +
          "</span>" +
          "</span>";
        track.appendChild(link);
      });
    } catch (err) {
      console.warn("Home highlights:", err);
      rail.hidden = true;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
