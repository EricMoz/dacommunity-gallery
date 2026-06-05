/**
 * Register service worker from any page under the site root.
 */
(function () {
  if (!("serviceWorker" in navigator)) return;
  if (window.location.protocol === "file:") return;

  var path = window.location.pathname || "/";
  var root = "/";
  var idx = path.indexOf("/dacommunity/");
  if (idx >= 0) {
    root = path.slice(0, idx + 1);
  } else if (path.indexOf("/collections/") >= 0) {
    root = path.slice(0, path.indexOf("/collections/") + 1);
  } else if (path.indexOf("/film/") >= 0) {
    root = path.slice(0, path.indexOf("/film/") + 1);
  } else if (path.indexOf("/analytics/") >= 0) {
    root = path.slice(0, path.indexOf("/analytics/") + 1);
  } else if (path.indexOf("/badges/") >= 0) {
    root = path.slice(0, path.indexOf("/badges/") + 1);
  } else if (!path.endsWith("/")) {
    root = path.slice(0, path.lastIndexOf("/") + 1);
  }

  window.addEventListener("load", function () {
    var buildMeta = document.querySelector('meta[name="site-build"]');
    var build = buildMeta && buildMeta.getAttribute("content");
    var swUrl = root + "sw.js" + (build ? "?v=" + encodeURIComponent(build) : "");
    navigator.serviceWorker.register(swUrl, { scope: root }).catch(function () {});
  });
})();