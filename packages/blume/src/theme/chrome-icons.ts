/**
 * The handful of built-in glyphs Blume's own chrome renders from **client-side**
 * scripts (copy/check buttons, search result rows). These stay hand-inlined and
 * dependency-free so they can be bundled into client JS — the full icon
 * resolver (`./icons.ts`) pulls in library data far too large to ship to the
 * browser, so it must never be imported from a client script.
 *
 * Author-facing content icons (Cards, Steps, sidebar, `icon:` frontmatter) do
 * NOT come from here — they resolve from the bundled icon libraries at build
 * time via `resolveIcon` and inline as zero-JS SVG.
 *
 * Values are Lucide inner-SVG markup; the client `svg()` helpers wrap them in an
 * `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" …>`.
 */
export const chromeIcons: Record<string, string> = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sparkles:
    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M3 5h4"/><path d="M19 17v4"/><path d="M17 19h4"/>',
};
