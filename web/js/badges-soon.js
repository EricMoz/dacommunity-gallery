/**
 * Badges coming-soon — procedural starfield (mobile-visible twinkle layer).
 * Respects prefers-reduced-motion; no-op when .badges-starfield is absent.
 */
(function () {
  "use strict";

  var STAR_COUNT = 48;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function init() {
    var field = document.querySelector(".badges-starfield");
    if (!field || field.dataset.ready === "1") return;
    field.dataset.ready = "1";

    var frag = document.createDocumentFragment();
    for (var i = 0; i < STAR_COUNT; i++) {
      var star = document.createElement("span");
      star.className = "badges-star";
      var size = 2 + Math.random() * 3.5;
      var left = Math.random() * 100;
      var top = Math.random() * 100;
      var delay = Math.random() * 6;
      var dur = 2.2 + Math.random() * 3.5;
      var opacity = 0.45 + Math.random() * 0.55;
      star.style.cssText =
        "left:" +
        left +
        "%;top:" +
        top +
        "%;width:" +
        size +
        "px;height:" +
        size +
        "px;opacity:" +
        opacity +
        ";animation-duration:" +
        dur +
        "s;animation-delay:-" +
        delay +
        "s;";
      if (Math.random() > 0.82) star.classList.add("badges-star--bright");
      frag.appendChild(star);
    }
    field.appendChild(frag);

    if (!reduced) {
      var orbits = document.querySelectorAll(".orbit-badge");
      orbits.forEach(function (el, idx) {
        el.style.animationDelay = "-" + idx * 2.1 + "s";
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();