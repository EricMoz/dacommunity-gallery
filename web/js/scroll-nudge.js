/**
 * PC glass scroll-nudge — shared by Universe, Film hub, and Gallery archive.
 * Click smooth-scrolls ~14% of the viewport. Hidden when overlays block UX
 * (NFT detail, film modal) or when little scroll room remains.
 */
(function () {
  function isDetailOpen() {
    var d = document.getElementById("detail-panel");
    return !!(d && d.classList.contains("open"));
  }

  function isFilmModalOpen() {
    var m = document.getElementById("film-modal");
    if (!m) return false;
    if (m.hidden || m.getAttribute("aria-hidden") === "true") return false;
    return true;
  }

  function isShareOpen() {
    var s = document.getElementById("share-modal");
    if (s && !s.hidden && s.getAttribute("aria-hidden") !== "true") return true;
    if (document.getElementById("social-share-modal")) return true;
    return false;
  }

  function sync(btn) {
    if (!btn) return;
    var wide = window.innerWidth >= 900;
    var blocked = isDetailOpen() || isFilmModalOpen() || isShareOpen();
    var room =
      document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
    var show = wide && !blocked && room > 80;
    btn.classList.toggle("is-away", !show);
  }

  function bind(btn) {
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";

    btn.addEventListener("click", function () {
      if (btn.classList.contains("is-away")) return;
      btn.classList.add("is-pulse");
      window.setTimeout(function () {
        btn.classList.remove("is-pulse");
      }, 420);
      var dy = Math.round(window.innerHeight * 0.14);
      window.scrollBy({ top: dy, left: 0, behavior: "smooth" });
      window.setTimeout(function () {
        sync(btn);
      }, 500);
    });

    function onSync() {
      sync(btn);
    }
    window.addEventListener("scroll", onSync, { passive: true });
    window.addEventListener("resize", onSync, { passive: true });

    // Film modal / detail may open without our knowledge — observe attribute flips
    var filmModal = document.getElementById("film-modal");
    if (filmModal && typeof MutationObserver !== "undefined") {
      new MutationObserver(onSync).observe(filmModal, {
        attributes: true,
        attributeFilter: ["hidden", "class", "aria-hidden"],
      });
    }
    var detail = document.getElementById("detail-panel");
    if (detail && typeof MutationObserver !== "undefined") {
      new MutationObserver(onSync).observe(detail, {
        attributes: true,
        attributeFilter: ["class", "aria-hidden"],
      });
    }

    window.setTimeout(onSync, 0);
    window.setTimeout(onSync, 800);
    onSync();
  }

  function boot() {
    var nodes = document.querySelectorAll(".gallery-scroll-nudge, #gallery-scroll-nudge, #site-scroll-nudge");
    if (!nodes.length) {
      var one = document.getElementById("gallery-scroll-nudge") || document.getElementById("site-scroll-nudge");
      if (one) bind(one);
      return;
    }
    for (var i = 0; i < nodes.length; i++) bind(nodes[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Gallery app.js can call this after openDetail/closeDetail if loaded
  window.syncSiteScrollNudge = function () {
    var btn =
      document.getElementById("gallery-scroll-nudge") ||
      document.getElementById("site-scroll-nudge") ||
      document.querySelector(".gallery-scroll-nudge");
    sync(btn);
  };
})();
