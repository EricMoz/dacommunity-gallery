/**
 * PC glass scroll-nudge — Universe, Film hub, Gallery archive.
 * Click smooth-scrolls ~14% of the viewport.
 * Hidden when NFT detail / film modal / share sheet is open, or near page end.
 */
(function () {
  function isDetailOpen() {
    var d = document.getElementById("detail-panel");
    return !!(d && d.classList.contains("open"));
  }

  function isFilmModalOpen() {
    var m = document.getElementById("film-modal");
    // Closed when HTML hidden attribute is present (film.js sets m.hidden = true)
    if (!m || m.hidden) return false;
    return true;
  }

  function isShareOpen() {
    var s = document.getElementById("share-modal");
    if (s && !s.hidden && s.getAttribute("aria-hidden") !== "true") return true;
    // Dynamic film/gallery sheet only exists while open (removed on close)
    var social = document.getElementById("social-share-modal");
    if (social && !social.hidden) return true;
    return false;
  }

  function remainingScroll() {
    var doc = document.documentElement;
    var body = document.body;
    var scrollHeight = Math.max(
      doc.scrollHeight,
      body ? body.scrollHeight : 0
    );
    return scrollHeight - window.scrollY - window.innerHeight;
  }

  function sync(btn) {
    if (!btn) return;
    var wide = window.innerWidth >= 900;
    var blocked = isDetailOpen() || isFilmModalOpen() || isShareOpen();
    // Film catalog paints late — use a low threshold so the chip appears once content exceeds the viewport
    var room = remainingScroll();
    var show = wide && !blocked && room > 48;
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

    // Film grid / home sections paint async — recheck after layout settles
    var main =
      document.querySelector(".film-hub-main") ||
      document.querySelector(".site-home") ||
      document.getElementById("app") ||
      document.body;
    if (main && typeof ResizeObserver !== "undefined") {
      try {
        new ResizeObserver(onSync).observe(main);
      } catch (e) {}
    }

    [0, 300, 800, 1600, 3200].forEach(function (ms) {
      window.setTimeout(onSync, ms);
    });
    onSync();
  }

  function boot() {
    var nodes = document.querySelectorAll(
      ".gallery-scroll-nudge, #gallery-scroll-nudge, #site-scroll-nudge"
    );
    if (!nodes.length) {
      var one =
        document.getElementById("gallery-scroll-nudge") ||
        document.getElementById("site-scroll-nudge");
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

  window.syncSiteScrollNudge = function () {
    var btn =
      document.getElementById("gallery-scroll-nudge") ||
      document.getElementById("site-scroll-nudge") ||
      document.querySelector(".gallery-scroll-nudge");
    sync(btn);
  };
})();
