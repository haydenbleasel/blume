---
"blume": patch
---

Add `seo.og.fonts` to load Google Font families into the Open Graph card renderer. Takumi's built-in font covers only Latin, so a non-Latin page or site title (CJK, and so on) rendered as tofu with no way to fix it. List the families by name — bare strings, or `{ name, weight, style }` for weight/style — and Blume fetches them from Google Fonts at build via Takumi's `googleFonts` helper, registering only the glyph subsets each title uses. Latin text renders unchanged.
