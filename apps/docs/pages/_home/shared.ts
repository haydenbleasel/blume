// Shared homepage UI constants: the inline Lucide-style icon set (the shipped
// icon set is intentionally small, and the landing page wants a few extras) and
// the copy glyph. Imported by the homepage section components and index.astro.

export const icons = {
  ai: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  api: '<path d="M7 4a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2"/><path d="M17 4a2 2 0 0 1 2 2v3a2 2 0 0 1 2 2 2 2 0 0 1-2 2v3a2 2 0 0 1-2 2"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  cloud:
    '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><path d="m9 13 2 2 4-4"/>',
  components:
    '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  config:
    '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  eject:
    '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  fast: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  fileCode:
    '<path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/>',
  fileText:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  migrate:
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sparkle:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
};

export const copyIcon =
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>';

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
      items: ["Introduction", "Quickstart", "Authentication"],
      label: "Get started",
    },
    { items: ["Messages", "Templates", "Webhooks"], label: "Sending" },
    { items: ["Logs", "Search", "Analytics"], label: "Platform" },
  ],
};

// The single-line install box (x.ai-style): a `$` prompt, the command, and a
// copy button. Shared by the hero and the install CTA so they stay identical.
// Buttons use the page-level delegated `data-blume-copy-install` handler in
// index.astro.
export const installCommand = "npm i blume";
export const installBox = `<div class="mx-auto flex w-full max-w-xs items-center gap-3 rounded-blume border border-border bg-background py-2 pr-2 pl-4"><span aria-hidden="true" class="select-none font-mono text-muted-foreground text-sm">$</span><code class="flex-1 truncate text-left font-mono text-foreground text-sm">${installCommand}</code><button aria-label="Copy install command" class="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" data-blume-copy-install data-command="${installCommand}" type="button"><svg class="size-4" fill="none" height="16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24" width="16">${copyIcon}</svg></button></div>`;
