/**
 * Home page — Community Highlights rail (film catalog snippets).
 * Same pool as film hub Featured (videos.json featuredIds), randomized each visit.
 * Card shells are static in index.html; this file only fills them (no layout jump).
 */
(function () {
  "use strict";

  var MAX_HIGHLIGHTS = 6;

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

  function getBuildStamp() {
    try {
      var meta = document.querySelector('meta[name="site-build"]');
      if (meta && meta.getAttribute("content")) {
        return meta.getAttribute("content");
      }
    } catch (e) {}
    return "dev-" + Math.floor(Date.now() / 1000).toString(36);
  }

  function fillHighlightCard(card, video) {
    var category = video.series || "Film";
    var title = video.title || video.id;
    var duration = video.duration || "";
    card.href = "film/?v=" + encodeURIComponent(video.id);
    card.classList.remove("is-pending");
    card.removeAttribute("aria-hidden");
    card.removeAttribute("tabindex");
    card.setAttribute(
      "aria-label",
      category + ": " + title + ". Watch on film hub."
    );
    card.setAttribute("role", "listitem");

    var img = card.querySelector(".highlight-card-thumb img");
    if (img) {
      img.src = video.thumbnail || "";
      img.alt = "";
      img.loading = "lazy";
      img.width = 320;
      img.height = 180;
    }

    var thumb = card.querySelector(".highlight-card-thumb");
    if (thumb) {
      var play = thumb.querySelector(".highlight-card-play");
      if (!play) {
        play = document.createElement("span");
        play.className = "highlight-card-play";
        play.setAttribute("aria-hidden", "true");
        thumb.appendChild(play);
      }
      var durEl = thumb.querySelector(".highlight-card-duration");
      if (duration) {
        if (!durEl) {
          durEl = document.createElement("span");
          durEl.className = "highlight-card-duration";
          thumb.appendChild(durEl);
        }
        durEl.textContent = duration;
      } else if (durEl) {
        durEl.remove();
      }
    }

    var catEl = card.querySelector(".highlight-card-category");
    if (catEl) catEl.textContent = category;
    var titleEl = card.querySelector(".highlight-card-title");
    if (titleEl) titleEl.textContent = title;
  }

  function resetHighlightCard(card) {
    card.href = "film/";
    card.classList.add("is-pending");
    card.setAttribute("aria-hidden", "true");
    card.setAttribute("tabindex", "-1");
    card.removeAttribute("aria-label");
    var img = card.querySelector(".highlight-card-thumb img");
    if (img) {
      img.removeAttribute("src");
      img.alt = "";
    }
    var durEl = card.querySelector(".highlight-card-duration");
    if (durEl) durEl.remove();
    var catEl = card.querySelector(".highlight-card-category");
    if (catEl) catEl.innerHTML = "&nbsp;";
    var titleEl = card.querySelector(".highlight-card-title");
    if (titleEl) titleEl.innerHTML = "&nbsp;";
  }

  async function init() {
    var rail = document.getElementById("home-highlights-rail");
    var track = document.getElementById("home-highlights-track");
    if (!rail || !track) return;

    var shells = Array.prototype.slice.call(
      track.querySelectorAll(".highlight-card")
    );
    if (!shells.length) return;

    try {
      var url =
        new URL("data/videos.json", window.location.href).href +
        "?v=" +
        encodeURIComponent(getBuildStamp()) +
        "&m=" +
        Date.now().toString(36);
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
        rail.setAttribute("aria-busy", "false");
        return;
      }

      var countEl = document.getElementById("film-video-count");
      if (countEl && catalog.videos) {
        countEl.textContent = catalog.videos.length + " videos on-site";
      }

      rail.hidden = false;
      // Fill existing shells only — never wipe the track (keeps Collections pinned).
      shells.forEach(function (shell, i) {
        if (i < cards.length) fillHighlightCard(shell, cards[i]);
        else {
          resetHighlightCard(shell);
          shell.hidden = true;
        }
      });
      rail.setAttribute("aria-busy", "false");
    } catch (err) {
      console.warn("Home highlights:", err);
      rail.hidden = true;
      rail.setAttribute("aria-busy", "false");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
