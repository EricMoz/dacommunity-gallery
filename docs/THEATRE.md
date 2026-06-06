# Film Theatre mode

Immersive full-screen watch experience for select community films. Distinct from the in-hub modal player — curtains, vignette, popcorn cue, and **Lights down** dim the chrome so the video dominates.

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
| `enabled` | Show Theatre mode links in hub + modal |
| `route` | Canonical path under `/film/` (optional; default `theatre/?v=<id>`) |

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

- Modal link: **🍿 Theatre mode** when `theatre.enabled`
- Series row CTA under grids that include a theatre-enabled title
- `theatreHref(video)` builds route from `theatre.route` or generic `theatre/?v=`

---

## Adding a new theatre title

1. Add `theatre` block to the video in `videos.json`.
2. Add slug entry in `theatre_registry.json` (`theme`, empty `extras`).
3. Either set `route` to a dedicated folder (`/film/my-drop/`) cloning `mozvane/index.html`, or rely on `/film/theatre/?v=<id>` only.
4. QA: hub modal link, series CTA, mobile player, Lights down, reduced motion.

---

## QA checklist

- [ ] `/film/mozvane/` — player loads, popcorn line, Lights down works
- [ ] `/film/theatre/?v=mozvane-quick-stop` — same experience
- [ ] Film hub → Mozvane → modal → Theatre mode link
- [ ] Mozvane series row → “Theatre mode · full screen” under grid
- [ ] Mobile: 16:9 player fills width; curtains don’t crush content
- [ ] `prefers-reduced-motion`: no popcorn pulse