/**
 * Minimal PWA service worker — offline shell + cached catalog.
 * Gallery JSON uses network-first so listings stay current when online.
 * CACHE name is bumped by scripts/bump_deploy_version.py on each Pages deploy.
 */
const CACHE = "dacat-gallery-v20260605-4";
const SHELL = [
  "./",
  "./dacommunity/",
  "./dacommunity/index.html",
  "./css/styles.css",
  "./js/app.js",
  "./js/pwa-register.js",
  "./manifest.webmanifest",
  "./assets/brand/dacat-icon-64.png",
  "./assets/brand/dacat-mascot.png",
  "./data/gallery_catalog.json",
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
        keys.filter(function (k) { return k !== CACHE; }).map(function (k) {
          return caches.delete(k);
        })
      );
    })
  );
  self.clients.claim();
});

function isDataJson(url) {
  return /\/data\/gallery_(data|meta|wallet_index)\.json/i.test(url.pathname);
}

/** HTML/CSS/JS must be network-first so deploy bumps reach users (avoid stale SW cache). */
function isMutableShell(url) {
  return /\.(html|js|css)$/i.test(url.pathname);
}

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (isDataJson(url) || isMutableShell(url)) {
    event.respondWith(networkFirstData(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      return (
        cached ||
        fetch(event.request).then(function (res) {
          if (!res || res.status !== 200 || res.type === "opaque") return res;
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(event.request, copy); });
          return res;
        })
      );
    })
  );
});

function networkFirstData(request) {
  return fetch(request)
    .then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(request, copy); });
      }
      return res;
    })
    .catch(function () {
      return caches.match(request);
    });
}