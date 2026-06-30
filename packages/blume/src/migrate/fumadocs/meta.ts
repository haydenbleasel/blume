import type { FolderMeta } from "../../core/schema.ts";

/**
 * Translate a Fumadocs folder `meta.json` into a Blume `FolderMeta` (`meta.ts`).
 * Unlike Nextra, Fumadocs declares a folder's own title/icon/ordering in *that
 * folder's* `meta.json`, so the mapping is self-contained. Fumadocs-only
 * concepts with no Blume equivalent are dropped and reported:
 *
 * - `defaultOpen` -> `collapsed` (inverted) + `display: "group"` (collapsible).
 * - `root: true` -> `display: "page"` (the closest analogue to a page-tree root).
 * - `description` -> dropped (folders carry no description in Blume).
 * - `pages` entries: plain slugs are kept as ordering; `"..."` (the rest marker,
 *   already Blume's default) is dropped silently; `"...folder"` (the *extract*
 *   operator, which inlines a folder's children) keeps the folder's place in the
 *   ordering as a plain `"folder"` key and warns that it renders as a normal
 *   group rather than flattened; `"---Section---"` separators and `"[Text](url)"`
 *   links have no folder-meta home and are dropped with a warning.
 *
 * When a `pages` array carries `---Section---` separators, the migrator instead
 * takes the *structural* path ({@link parseFumadocsPages} + the group-folder
 * reshape in `index.ts`), which rebuilds each section as a Blume group folder
 * rather than flattening it through `filterPages`.
 */

interface FumadocsMeta {
  defaultOpen?: unknown;
  description?: unknown;
  icon?: unknown;
  pages?: unknown;
  root?: unknown;
  title?: unknown;
}

const SEPARATOR = /^---(?<label>.*)---$/u;
const LINK = /^(?:\[[^\]]*\])?\[(?<text>[^\]]*)\]\((?<href>[^)]*)\)$/u;
const REST = "...";
/** Fumadocs *extract* operator: `...folder` inlines that folder's children. */
const EXTRACT = /^\.\.\.(?<folder>.+)$/u;

interface PagesResult {
  pages: string[];
  warnings: string[];
}

const filterPages = (raw: unknown): PagesResult => {
  if (!Array.isArray(raw)) {
    return { pages: [], warnings: [] };
  }

  const pages: string[] = [];
  const warnings: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const value = entry.trim();
    if (value === REST || value === "") {
      continue;
    }
    const extract = EXTRACT.exec(value);
    if (extract) {
      // Blume has no "flatten a folder's children inline" sidebar primitive, but
      // the folder is a sibling here, so keep its position in the ordering and
      // let it render as a normal group.
      const folder = extract.groups?.folder?.trim() ?? "";
      if (folder) {
        pages.push(folder);
        warnings.push(
          `Sidebar extract "...${folder}" became a normal "${folder}" group (its pages are not flattened into the parent).`
        );
      }
      continue;
    }
    const separator = SEPARATOR.exec(value);
    if (separator) {
      const label = separator.groups?.label?.trim();
      warnings.push(
        `Dropped sidebar separator "${label || value}" — recreate it with a sidebar group if needed.`
      );
      continue;
    }
    const link = LINK.exec(value);
    if (link) {
      warnings.push(
        `Dropped sidebar link "${link.groups?.text}" (${link.groups?.href}) — add it to navbar.links manually.`
      );
      continue;
    }
    pages.push(value);
  }

  return { pages, warnings };
};

export interface FumadocsMetaConversion {
  meta: FolderMeta;
  warnings: string[];
}

/** Render a Blume `meta.ts` module source for a `FolderMeta`. */
export const renderMetaModule = (meta: FolderMeta): string =>
  `import { defineMeta } from "blume";\n\nexport default defineMeta(${JSON.stringify(meta, null, 2)});\n`;

/**
 * Translate a folder's own title/icon/display fields — everything in a Fumadocs
 * `meta.json` *except* the `pages` ordering. Split out from
 * {@link translateFumadocsMeta} so the structural path (which reshapes `pages`
 * into group folders) can reuse the self fields without the flat `pages` array.
 */
export const translateFumadocsSelfMeta = (
  value: unknown
): FumadocsMetaConversion => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { meta: {}, warnings: [] };
  }

  const source = value as FumadocsMeta;
  const meta: FolderMeta = {};
  const warnings: string[] = [];

  if (typeof source.title === "string") {
    meta.title = source.title;
  }
  if (typeof source.icon === "string") {
    meta.icon = source.icon;
  }
  if (source.root === true) {
    meta.display = "page";
  } else if (typeof source.defaultOpen === "boolean") {
    meta.display = "group";
    meta.collapsed = !source.defaultOpen;
  }
  if (typeof source.description === "string") {
    warnings.push(
      "Dropped folder `description` — Blume folders have no description field."
    );
  }

  return { meta, warnings };
};

/** Map a parsed Fumadocs `meta.json` object onto a Blume `FolderMeta`. */
export const translateFumadocsMeta = (
  value: unknown
): FumadocsMetaConversion => {
  const { meta, warnings } = translateFumadocsSelfMeta(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { pages, warnings: pageWarnings } = filterPages(
      (value as FumadocsMeta).pages
    );
    if (pages.length > 0) {
      meta.pages = pages;
    }
    warnings.push(...pageWarnings);
  }
  return { meta, warnings };
};

// ---------------------------------------------------------------------------
// Structural pages (separators -> sections)
// ---------------------------------------------------------------------------

/**
 * One entry in a Fumadocs `pages` array, after classification: a `ref` (a plain
 * page or folder name), an `extract` (`...folder`, whose children Fumadocs
 * inlines), or a `link` (`[Text](url)`).
 */
export type FumadocsPageItem =
  | { kind: "extract"; name: string }
  | { kind: "link"; href: string; text: string }
  | { kind: "ref"; name: string };

/** A run of items under one `---Label---` separator. */
export interface FumadocsSection {
  items: FumadocsPageItem[];
  label: string;
}

export interface FumadocsPagesStructure {
  /** Whether any `---Section---` separator was present. */
  hasSections: boolean;
  /** Items before the first separator; they stay at the folder's top level. */
  lead: FumadocsPageItem[];
  sections: FumadocsSection[];
}

/**
 * Parse a Fumadocs `pages` array into its structural shape: the lead items
 * (before any separator) and the sections each `---Label---` introduces. Unlike
 * {@link filterPages}, separators are preserved (as section boundaries) so the
 * migrator can rebuild them as Blume group folders. The rest marker (`"..."`) is
 * dropped — Blume appends unlisted pages by default.
 */
export const parseFumadocsPages = (raw: unknown): FumadocsPagesStructure => {
  const lead: FumadocsPageItem[] = [];
  const sections: FumadocsSection[] = [];
  if (!Array.isArray(raw)) {
    return { hasSections: false, lead, sections };
  }

  let current: FumadocsSection | null = null;
  const push = (item: FumadocsPageItem): void => {
    (current ? current.items : lead).push(item);
  };

  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const value = entry.trim();
    if (value === REST || value === "") {
      continue;
    }
    const separator = SEPARATOR.exec(value);
    if (separator) {
      current = {
        items: [],
        label: separator.groups?.label?.trim() || "Section",
      };
      sections.push(current);
      continue;
    }
    const extract = EXTRACT.exec(value);
    if (extract) {
      const name = extract.groups?.folder?.trim();
      if (name) {
        push({ kind: "extract", name });
      }
      continue;
    }
    const link = LINK.exec(value);
    if (link) {
      push({
        href: link.groups?.href ?? "",
        kind: "link",
        text: link.groups?.text ?? "",
      });
      continue;
    }
    push({ kind: "ref", name: value });
  }

  return { hasSections: sections.length > 0, lead, sections };
};
