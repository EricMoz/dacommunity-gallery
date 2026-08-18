/**
 * Service worker registration + safe force-refresh for everyone.
 *
 * Why mobile got stuck:
 * - Directory URLs (/ and /film/) were cached by older SWs
 * - Registering sw.js?v=<build> made update checks flaky
 * - Scope was sometimes set under /film/ instead of the site root
 *
 * Safe force path (no data loss — only browser caches for this origin):
 * 1) Register a single stable SW at the site root (no ?v= on the SW URL)
 * 2) Fetch VERSION.txt with no-store; if it disagrees with <meta name="site-build">,
 *    unregister all SWs, delete Cache Storage, hard-reload once
 */
(function () {
  if (!("serviceWorker" in navigator)) return;
  if (window.location.protocol === "file:") return;

  /** Site root: /dacommunity-gallery/ on github.io, / on custom domains. */
  function siteRoot() {
    var host = location.hostname || "";
    if (host.endsWith("github.io")) {
      var parts = (location.pathname || "/").split("/").filter(Boolean);
      if (parts.length) return "/" + parts[0] + "/";
    }
    return "/";
  }

  var root = siteRoot();
  var buildMeta = document.querySelector('meta[name="site-build"]');
  var pageBuild = (buildMeta && buildMeta.getAttribute("content")) || "";

  function clearOriginCaches() {
    if (!window.caches || !caches.keys) return Promise.resolve();
    return caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (k) {
          return caches.delete(k);
        })
      );
    });
  }

  function unregisterAllWorkers() {
    return navigator.serviceWorker.getRegistrations().then(function (regs) {
      return Promise.all(
        regs.map(function (r) {
          return r.unregister();
        })
      );
    });
  }

  /**
   * Hard reload with cache-bypass query.
   * Keyed by *remote* build so a new deploy can heal even if an earlier
   * attempt still received a stale HTML shell (e.g. edge cache on /film/).
   * Allow up to 2 attempts per remote stamp, then stop (avoid loops).
   */
  function forceReloadTo(remoteBuild) {
    var target = remoteBuild || String(Date.now());
    var attemptKey = "dacat-heal-to-" + target;
    var attempts = parseInt(sessionStorage.getItem(attemptKey) || "0", 10);
    if (attempts >= 2) return;
    sessionStorage.setItem(attemptKey, String(attempts + 1));
    var u = new URL(window.location.href);
    u.searchParams.set("_cb", target);
    u.searchParams.set("_r", String(attempts + 1));
    window.location.replace(u.href);
  }

  /**
   * Compare live VERSION.txt to this document's meta stamp.
   * If HTML is stale (common on mobile SW / partial CDN), wipe SW/caches and reload.
   */
  function checkRemoteBuildAndHeal() {
    var url = root + "VERSION.txt?_=" + Date.now();
    return fetch(url, { cache: "no-store", credentials: "same-origin" })
      .then(function (res) {
        if (!res || !res.ok) return null;
        return res.text();
      })
      .then(function (text) {
        if (!text) return;
        var remote = String(text).trim().split(/\s+/)[0];
        if (!remote || !pageBuild) return;
        if (remote === pageBuild) {
          // Same stamp as VERSION — still heal if this HTML loads an older app.js?v=
          // (seen on /dacommunity/ stuck at 20260817-1 while home was 20260818-2)
          var scripts = document.querySelectorAll("script[src*='app.js']");
          for (var i = 0; i < scripts.length; i++) {
            var src = scripts[i].getAttribute("src") || "";
            var m = src.match(/[?&]v=([^&]+)/);
            if (m && m[1] && m[1] !== remote) {
              return unregisterAllWorkers()
                .then(clearOriginCaches)
                .then(function () {
                  forceReloadTo(remote + "-app");
                });
            }
          }
          return;
        }
        // Stale HTML shell vs fresh deploy — safe cleanup + reload
        return unregisterAllWorkers()
          .then(clearOriginCaches)
          .then(function () {
            forceReloadTo(remote);
          });
      })
      .catch(function () {
        /* offline or blocked — leave user alone */
      });
  }

  function registerWorker() {
    // Stable URL (no ?v=) so the browser always revalidates the same SW script
    var swUrl = root + "sw.js";
    return navigator.serviceWorker
      .register(swUrl, { scope: root })
      .then(function (reg) {
        if (reg && reg.update) reg.update();

        // When a new SW takes control, reload once so CSS/JS stamps apply
        var refreshing = false;
        navigator.serviceWorker.addEventListener("controllerchange", function () {
          if (refreshing) return;
          if (sessionStorage.getItem("sw-ctrl-" + pageBuild) === "1") return;
          sessionStorage.setItem("sw-ctrl-" + pageBuild, "1");
          refreshing = true;
          window.location.reload();
        });

        // Ask waiting worker to activate immediately if present
        if (reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }
        if (reg.installing) {
          reg.installing.addEventListener("statechange", function () {
            if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
          });
        }
        return reg;
      })
      .catch(function () {});
  }

  // Reload once when a newly activated SW announces itself
  navigator.serviceWorker.addEventListener("message", function (event) {
    if (!event.data || event.data.type !== "DACAT_SW_ACTIVATED") return;
    if (sessionStorage.getItem("sw-activated-reload") === "1") return;
    sessionStorage.setItem("sw-activated-reload", "1");
    window.location.reload();
  });

  /**
   * If a prior deploy left a failed gallery_meta in Cache Storage, drop caches
   * once per session when VERSION is current — live meta is usually already ok.
   */
  function clearStaleDataCachesOnce() {
    try {
      if (sessionStorage.getItem("dacat-meta-cache-cleared") === "1") return;
      sessionStorage.setItem("dacat-meta-cache-cleared", "1");
    } catch (e) {
      return;
    }
    if (!window.caches || !caches.keys) return;
    caches.keys().then(function (keys) {
      keys.forEach(function (k) {
        caches.open(k).then(function (cache) {
          cache.keys().then(function (reqs) {
            reqs.forEach(function (req) {
              if (req && req.url && /gallery_meta\.json/i.test(req.url)) {
                cache.delete(req);
              }
            });
          });
        });
      });
    });
  }

  // Run ASAP (not only on load) so stale shells heal quickly
  checkRemoteBuildAndHeal();
  clearStaleDataCachesOnce();

  window.addEventListener("load", function () {
    registerWorker().then(function () {
      checkRemoteBuildAndHeal();
    });
  });
})();
