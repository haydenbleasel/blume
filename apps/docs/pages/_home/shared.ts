// Shared homepage UI constants: an icon set sourced from the canonical Lucide
// library via Blume's build-time resolver (server-only — every consumer here is
// `.astro` frontmatter), plus the fictional sample brand and the install
// command. Imported by the homepage section components. Each `icons` value is
// ready-to-inline, self-styled SVG inner markup; the section templates wrap it
// in an `<svg viewBox="0 0 24 24">` root.

import { resolveIcon } from "blume/theme/icons.ts";

// Resolve a Lucide name to its inline body, or empty markup if it ever drops
// out of the set (keeps the homepage rendering rather than throwing at build).
// Exported so the homepage section components can resolve one-off glyphs (e.g.
// the mock-browser chrome) instead of hand-inlining SVG paths.
export const glyph = (name: string): string => resolveIcon(name)?.body ?? "";

// Homepage glyphs, keyed by their role here and mapped to Lucide icon names.
export const icons = {
  ai: glyph("sparkles"),
  api: glyph("braces"),
  changelog: glyph("history"),
  chat: glyph("message-square"),
  check: glyph("check"),
  cloud: glyph("cloud-check"),
  components: glyph("box"),
  config: glyph("settings-2"),
  eject: glyph("chevrons-left-right"),
  fast: glyph("zap"),
  fileCode: glyph("file-code-2"),
  fileText: glyph("file-text"),
  globe: glyph("globe"),
  image: glyph("image"),
  moon: glyph("moon"),
  plug: glyph("plug"),
  search: glyph("search"),
  sparkle: glyph("sparkle"),
  star: glyph("star"),
  sun: glyph("sun"),
};

// A fictional brand ("Comet", a transactional email & SMS API) used by the
// homepage mock browser windows (ProductPreview + FeatureBrowser) so they read
// as a real docs site built with Blume rather than a mock of Blume's own docs.
// Single source of truth for the name, logo, and docs/API information
// architecture so both windows stay branded identically. The logo is a filled
// `currentColor` spark that inherits `text-accent` in the chrome.
export const sampleBrand = {
  api: [
    {
      items: [
        { method: "POST", path: "/messages", summary: "Send message" },
        { method: "GET", path: "/messages/{id}", summary: "Get message" },
        { method: "DELETE", path: "/messages/{id}", summary: "Delete message" },
      ],
      label: "Messages",
    },
    {
      items: [
        { method: "GET", path: "/templates", summary: "List templates" },
        { method: "POST", path: "/templates", summary: "Create template" },
      ],
      label: "Templates",
    },
  ],
  logo: '<svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 1.5l2.45 6.4a3 3 0 0 0 1.65 1.65L22.5 12l-6.4 2.45a3 3 0 0 0-1.65 1.65L12 22.5l-2.45-6.4a3 3 0 0 0-1.65-1.65L1.5 12l6.4-2.45a3 3 0 0 0 1.65-1.65z"/></svg>',
  name: "Comet",
  nav: ["Docs", "API", "Changelog"],
  sidebar: [
    {
      items: ["Introduction", "Quickstart", "Authentication", "Components"],
      label: "Get started",
    },
    { items: ["Messages", "Templates", "Webhooks"], label: "Sending" },
    { items: ["Logs", "Search", "Analytics"], label: "Platform" },
  ],
};

// Render a prose string whose code spans are marked with backticks (`--flag`,
// `blume init`) as HTML: everything else is escaped, each span becomes a
// styled <code>. For the landing-page sections whose copy lives in data
// arrays, where inline <code> elements can't be authored directly.
const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const inlineCode = (text: string): string =>
  escapeHtml(text).replaceAll(
    /`(?<span>[^`]+)`/gu,
    '<code class="font-mono text-[0.925em] text-foreground">$<span></code>'
  );

// The command shown in the install box (rendered by InstallBox.astro), shared
// with the hero and install CTA so they stay identical.
export const installCommand = "npx blume init";

// Copy-to-clipboard for the install boxes; briefly swaps the glyph for a check.
// One delegated handler covers every box on a page. Inlined by each landing
// page that renders an <InstallBox> (home and /cli) — page-specific, since the
// docs chrome's copy buttons are separate.
export const installCopyScript = `(()=>{const CHECK='<svg class="size-4" fill="none" height="16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24" width="16"><path d="M20 6 9 17l-5-5"/></svg>';document.addEventListener("click",async(e)=>{const b=e.target.closest("[data-blume-copy-install]");if(!b){return;}try{await navigator.clipboard.writeText(b.dataset.command);}catch{return;}const o=b.innerHTML;b.innerHTML=CHECK;setTimeout(()=>{b.innerHTML=o;},1500);});})();`;
