/**
 * Curated inline SVG icon set (Lucide-style, MIT). Stored as inner SVG markup
 * so icons render as zero-JS inline SVG. The set is intentionally small to keep
 * payloads bounded; more icons can be added as components need them.
 */
export const icons: Record<string, string> = {
  "arrow-left": '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  "arrow-up-right": '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  "badge-alert":
    '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.78 4.78 4 4 0 0 1-6.74 0 4 4 0 0 1-4.78-4.78 4 4 0 0 1 0-6.75Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 14.14 14.14"/>',
  "book-open":
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  "book-open-cover":
    '<path d="M12 7v14"/><path d="M3 18a2 2 0 0 1 2-2h7V5H5a2 2 0 0 0-2 2Z"/><path d="M21 18a2 2 0 0 0-2-2h-7V5h7a2 2 0 0 1 2 2Z"/>',
  "brand-x": '<path d="m4 4 11.7 16H20L8.3 4Z"/><path d="M4 20 20 4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  "circle-x":
    '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  "external-link":
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22V15"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  gear: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
  github:
    '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.3-.8 2.1-.36.16-.78.24-1.2.24-1.4 0-2.4-.7-3-2-.3-.6-.8-.9-1.2-.9-.4 0-.8.2-.8.5 0 .5.7.8 1 1.2.7 1.5 2 2.4 4 2.4.43 0 .84-.04 1.2-.13V22"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  js: '<path d="M8 8v7a2 2 0 1 1-4 0"/><path d="M16 15a2 2 0 1 0 2-2 2 2 0 1 1 2-2"/><path d="M20 8v.01"/>',
  key: '<path d="M21 2 11.4 11.6"/><circle cx="7.5" cy="16.5" r="5.5"/><path d="m15 7 2 2"/><path d="m12 10 2 2"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  lightbulb:
    '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  linkedin:
    '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/><rect width="4" height="12" x="2" y="9"/><circle cx="4" cy="4" r="2"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  "message-circle": '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  "panel-left":
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  "panel-left-close":
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  "panel-right":
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  "panel-right-close":
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>',
  paperclip:
    '<path d="m16 6-8.41 8.41a2 2 0 0 0 2.83 2.83L18.83 8.83a4 4 0 0 0-5.66-5.66L4.76 11.59a6 6 0 0 0 8.49 8.49L21.66 11.66"/>',
  "puzzle-piece":
    '<path d="M15.39 4.39a2.1 2.1 0 0 0-2.97 0L12 4.82l-.42-.43a2.1 2.1 0 1 0-2.97 2.97l.43.42L7.6 9.22H4.75A1.75 1.75 0 0 0 3 10.97v8.28C3 20.22 3.78 21 4.75 21h8.28c.97 0 1.75-.78 1.75-1.75V16.4l1.44-1.44.42.43a2.1 2.1 0 1 0 2.97-2.97l-.43-.42.43-.42a2.1 2.1 0 1 0-2.97-2.97l-.42.43-1.44-1.44.61-.61a2.1 2.1 0 0 0 0-2.97Z"/>',
  python:
    '<path d="M12 2h4a4 4 0 0 1 4 4v3H8a4 4 0 0 0-4 4v1"/><path d="M12 22H8a4 4 0 0 1-4-4v-3h12a4 4 0 0 0 4-4v-1"/><path d="M9 6h.01"/><path d="M15 18h.01"/>',
  rocket:
    '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  rss: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sparkles:
    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M3 5h4"/><path d="M19 17v4"/><path d="M17 19h4"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  "text-align-start":
    '<path d="M4 6h16"/><path d="M4 10h10"/><path d="M4 14h16"/><path d="M4 18h10"/>',
  "thumbs-up":
    '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  "triangle-alert":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

const iconAliases: Record<string, string> = {
  "alien-8bit": "sparkles",
  "arrow-up-right-from-square": "external-link",
  "book-open-reader": "book-open",
  "circle-info": "info",
  close: "x",
  "external-link-alt": "external-link",
  "fa-github": "github",
  "fa-linkedin": "linkedin",
  "fa-x-twitter": "brand-x",
  "file-lines": "file",
  javascript: "js",
  "panel-left-open": "panel-left",
  "panel-right-open": "panel-right",
  times: "x",
  "x-twitter": "brand-x",
};

const libraryPrefixes = [
  "fa-brands",
  "fa-duotone",
  "fa-light",
  "fa-regular",
  "fa-sharp-solid",
  "fa-solid",
  "fa-thin",
  "fa",
  "fab",
  "fad",
  "fal",
  "far",
  "fas",
  "fat",
  "lucide",
  "tabler",
  "ti",
];

const normalizedIconName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/gu, "-");

const isString = (value: string | null | undefined): value is string =>
  typeof value === "string";

const withoutLibraryPrefix = (name: string): string => {
  let normalized = normalizedIconName(name).replaceAll(/^icon-/gu, "");
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of libraryPrefixes) {
      if (normalized.startsWith(`${prefix}-`)) {
        normalized = normalized.slice(prefix.length + 1);
        changed = true;
      }
      if (normalized.startsWith(`${prefix}:`)) {
        normalized = normalized.slice(prefix.length + 1);
        changed = true;
      }
    }
  }
  return normalized;
};

export interface ResolvedIcon {
  name: string;
  markup: string;
}

/** Resolve common Mintlify Font Awesome/Lucide/Tabler names to Blume icons. */
export const resolveIcon = (
  name: string,
  iconType?: string
): ResolvedIcon | null => {
  const normalized = normalizedIconName(name);
  const stripped = withoutLibraryPrefix(name);
  const type = iconType ? normalizedIconName(iconType) : null;
  const candidates = [
    normalized,
    stripped,
    type ? `${type}-${stripped}` : null,
    iconAliases[normalized],
    iconAliases[stripped],
  ].filter(isString);

  for (const candidate of candidates) {
    const markup = icons[candidate];
    if (markup) {
      return { markup, name: candidate };
    }
  }
  return null;
};

/** Whether a name resolves to a known built-in icon. */
export const hasIcon = (name: string, iconType?: string): boolean =>
  resolveIcon(name, iconType) !== null;
