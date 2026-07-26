/**
 * Minimal PWA service worker — brand assets only offline.
 *
 * Force-update contract (safe for all users):
 * - HTML / directory navigations are network-only (never written to Cache Storage)
 * - CSS/JS/data are network-first with no-store on the network request
 * - On activate: drop every old cache, claim clients, tell pages to reload once
 * - Responds to SKIP_WAITING so new deploys activate immediately
 *
 * CACHE name is bumped by scripts/bump_deploy_version.py each deploy.
 */
const CACHE = "dacat-gallery-v20260726-10";
const SHELL = [
  "./manifest.webmanifest",
  "./assets/brand/dacat-icon-64.png",
  "./assets/brand/dacat-mascot.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL).catch(function () {});
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        // Delete ALL caches (including same-name leftovers from older logic)
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      })
      .then(function () {
        return caches.open(CACHE).then(function (cache) {
          return cache.addAll(SHELL).catch(function () {});
        });
      })
      .then(function () {
        return self.clients.claim();
      })
      .then(function () {
        return self.clients.matchAll({ type: "window" }).then(function (clients) {
          clients.forEach(function (client) {
            client.postMessage({ type: "DACAT_SW_ACTIVATED", cache: CACHE });
          });
        });
      })
  );
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function isDataJson(url) {
  return /\/data\/(gallery_(data|meta|catalog|wallet_index)|videos|VERSION|BUILD)\.(json|txt)$/i.test(
    url.pathname
  ) || /\/VERSION\.txt$/i.test(url.pathname) || /\/BUILD\.json$/i.test(url.pathname);
}

function isAssetShell(url) {
  return /\.(js|css)$/i.test(url.pathname);
}

function isHtmlDocument(request, url) {
  if (request.mode === "navigate") return true;
  if (/\.html$/i.test(url.pathname)) return true;
  if (url.pathname.endsWith("/")) return true;
  var last = url.pathname.split("/").pop() || "";
  if (last && last.indexOf(".") === -1) return true;
  return false;
}

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Build stamp + HTML: always network, never store (unstick mobile shells)
  if (isHtmlDocument(event.request, url) || /\/VERSION\.txt$/i.test(url.pathname)) {
    event.respondWith(networkOnly(event.request));
    return;
  }

  if (isDataJson(url) || isAssetShell(url)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

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

function networkOnly(request) {
  return fetch(request, { cache: "no-store" }).catch(function () {
    return caches.match(request).then(function (cached) {
      return (
        cached ||
        new Response("Offline — reconnect for the latest site build.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        })
      );
    });
  });
}

function networkFirst(request) {
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
