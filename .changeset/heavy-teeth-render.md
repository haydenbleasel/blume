---
"blume": patch
---

Upgrade Takumi to v2 via takumi-js. Emoji in titles now render as Twemoji glyphs, fetched once per glyph per build. The OG card palette accepts any CSS color, matching `theme.accent` — a color the renderer can't parse now fails the build instead of silently falling back. `renderOgImage` (exported from `blume/og`) now returns a `Uint8Array` rather than a `Buffer`.
