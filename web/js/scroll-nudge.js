/**
 * PC scroll nudge (bottom-right, >=900px). Scrolls ~14% viewport.
 * Hidden near page end or when detail / film / share modal is open.
 */
(function () {
  function isDetailOpen() {
    var d = document.getElementById("detail-panel");
    return !!(d && d.classList.contains("open"));
  }

  function isFilmModalOpen() {
    var m = document.getElementById("film-modal");
    if (!m || m.hidden) return false;
    return true;
  }

  function isShareOpen() {
    var s = document.getElementById("share-modal");
    if (s && !s.hidden && s.getAttribute("aria-hidden") !== "true") return true;
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
