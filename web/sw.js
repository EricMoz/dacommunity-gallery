/**
 * Minimal PWA service worker — offline brand assets only.
 * HTML / CSS / JS / data always prefer the network so deploy bumps reach mobile.
 * CACHE name is bumped by scripts/bump_deploy_version.py on each Pages deploy.
 */
const CACHE = "dacat-gallery-v20260713-4";
/* Precache only stable brand assets — never pin HTML/CSS/JS (they go stale). */
const SHELL = [
  "./manifest.webmanifest",
  "./assets/brand/dacat-icon-64.png",
  "./assets/brand/dacat-mascot.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL).catch(function () {
        /* partial cache ok on first visit */
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) {
            return k !== CACHE;
          })
          .map(function (k) {
            return caches.delete(k);
          })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function isDataJson(url) {
  return /\/data\/(gallery_(data|meta|catalog|wallet_index)|videos)\.json/i.test(
    url.pathname
  );
}

/** CSS/JS with optional ?v= stamps */
function isAssetShell(url) {
  return /\.(js|css)$/i.test(url.pathname);
}

/**
 * HTML documents including directory indexes (/ and /film/).
 * These previously fell through to cache-first and stuck mobile on old builds.
 */
function isHtmlDocument(request, url) {
  if (request.mode === "navigate") return true;
  if (/\.html$/i.test(url.pathname)) return true;
  // GitHub Pages serves index.html for trailing-slash paths
  if (url.pathname.endsWith("/")) return true;
  var last = url.pathname.split("/").pop() || "";
  // No file extension → treat as document navigation
  if (last && last.indexOf(".") === -1) return true;
  return false;
}

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Pages/HTML: always network, do not write into SW cache (fixes sticky mobile shells)
  if (isHtmlDocument(event.request, url)) {
    event.respondWith(networkOnlyHtml(event.request));
    return;
  }

  // Data + CSS/JS: network-first, may cache for offline fallback
  if (isDataJson(url) || isAssetShell(url)) {
    event.respondWith(networkFirstData(event.request));
    return;
  }

  // Images etc.: cache-first
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      return (
        cached ||
        fetch(event.request).then(function (res) {
          if (!res || res.status !== 200 || res.type === "opaque") return res;
          var copy = res.clone();
          caches.open(CACHE).then(function (c) {
            c.put(event.request, copy);
          });
          return res;
        })
      );
    })
  );
});

function networkOnlyHtml(request) {
  return fetch(request, { cache: "no-store" }).catch(function () {
    return caches.match(request).then(function (cached) {
      return (
        cached ||
        new Response("Offline — reconnect to load the latest site build.", {
          status: 503,
          statusText: "Offline",
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        })
      );
    });
  });
}

function networkFirstData(request) {
  return fetch(request, { cache: "no-store" })
    .then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) {
          c.put(request, copy);
        });
      }
      return res;
    })
    .catch(function () {
      return caches.match(request);
    });
}
