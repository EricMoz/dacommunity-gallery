/**
 * Home page — Community Highlights rail (film catalog snippets).
 */
(function () {
  "use strict";

  var HIGHLIGHTS = [
    { id: "chronicles-trailer-1", category: "daCAT Chronicles", label: "Comic Trailer #1" },
    { id: "podcast-ep1", category: "Podcast", label: "Episode 1" },
    { id: "dabeezy-rebirth", category: "daBeezy", label: "Episode 1: Rebirth" },
    { id: "shiro-fishing", category: "daCAT & Shiro", label: "Ep 1 · Fishing Trip" },
    { id: "crossover-kizuna", category: "Crossovers", label: "Kizuna vs DaCAT" },
    { id: "mozvane-quick-stop", category: "Mozvane", label: "Mozvane (~5 min)" },
  ];

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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

      var cards = [];
      HIGHLIGHTS.forEach(function (spec) {
        var video = byId[spec.id];
        if (video) cards.push({ spec: spec, video: video });
      });

      if (!cards.length) {
        rail.hidden = true;
        return;
      }

      rail.hidden = false;
      track.innerHTML = "";
      cards.forEach(function (entry) {
        var spec = entry.spec;
        var video = entry.video;
        var link = document.createElement("a");
        link.className = "highlight-card";
        link.href = "film/?v=" + encodeURIComponent(video.id);
        link.setAttribute("role", "listitem");
        link.setAttribute(
          "aria-label",
          spec.category + ": " + spec.label + ". Watch on film hub."
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
          escapeHtml(spec.category) +
          "</span>" +
          '<span class="highlight-card-title">' +
          escapeHtml(spec.label) +
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