# Film Theatre mode

Immersive full-screen watch experience for **every film on desktop** (769px+). Distinct from the in-hub modal player — minimal chrome, vignette, **Lights down** (near-black), and a niche flying-popcorn background when lights are up.

**Live examples:** [Mozvane theatre](https://ericmoz.github.io/dacommunity-gallery/film/mozvane/) · generic route `/film/theatre/?v=<videoId>`

---

## Data contract

### `web/data/videos.json` — per video

```json
"theatre": {
  "slug": "mozvane",
  "enabled": true,
  "route": "mozvane/"
}
```

| Field | Purpose |
|-------|---------|
| `slug` | Key into `theatre_registry.json` |
| `enabled` | Set `false` to opt a title out of theatre (default: all catalog videos on desktop) |
| `route` | Canonical path under `/film/` for dedicated drops (optional; default `theatre/?v=<id>`) |

### `web/data/theatre_registry.json` — per theatre (backend / theme)

```json
"mozvane": {
  "videoId": "mozvane-quick-stop",
  "canonicalRoute": "mozvane/",
  "theme": {
    "accent": "#ffcc00",
    "curtains": true,
    "vignette": true,
    "popcornCue": "Grab popcorn — lights down."
  },
  "extras": {}
}
```

`extras` is reserved for future per-community customizations (intro reels, seat animations, sponsor stings, etc.) — **no UI reads it yet**.

---

## Routes

| URL | Resolver |
|-----|----------|
| `/film/mozvane/` | `body[data-video-id="mozvane-quick-stop"]` |
| `/film/theatre/?v=mozvane-quick-stop` | `?v=` query param |

Both load `web/js/theatre.js` + `theatre_registry.json` for theme.

---

## Film hub integration (`film.js`)

- **Desktop only** (`min-width: 769px`): modal link **🍿 Theatre mode** for every catalog video unless `theatre.enabled === false`
- Series row CTA only for titles with a dedicated `theatre.route` (e.g. Mozvane)
- `theatreHref(video)` builds route from `theatre.route` or generic `theatre/?v=`
- Mobile: hub modal player only; theatre URLs show a desktop-only message

---

## Adding a new theatre title

1. Add `theatre` block to the video in `videos.json`.
2. Add slug entry in `theatre_registry.json` (`theme`, empty `extras`).
3. Either set `route` to a dedicated folder (`/film/my-drop/`) cloning `mozvane/index.html`, or rely on `/film/theatre/?v=<id>` only.
4. QA: hub modal link, series CTA, mobile player, Lights down, reduced motion.

---

## Lights + up-next (desktop only)

- **First visit:** prominent **Lights down** dock below the player (pulses once per session); shrinks to a corner pill after you dim
- **Lights down:** page goes black around the player — **video stays fully visible**; minimal **Random** up-next bar bottom-left; auto-advance countdown on video end
- **Lights up:** full up-next bar with **Random / Series** toggle (shares `dacat-film-upnext-mode` with film hub modal); popcorn field drifts in background
- `prefers-reduced-motion`: static kernels, no drift/pulse/flash

## QA checklist

- [ ] Desktop: any film modal → **🍿 Theatre mode** → `/film/theatre/?v=<id>` loads
- [ ] `/film/mozvane/` — dedicated route + registry theme
- [ ] Lights down → near black; Lights up → flash + popcorn background returns
- [ ] Mozvane series row → dedicated “Theatre mode · full screen” CTA only
- [ ] Mobile: no modal theatre link; `/film/theatre/` shows desktop-only copy
- [ ] `prefers-reduced-motion`: no popcorn drift or lights flash