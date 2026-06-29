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
 *   already Blume's default) is dropped silently; `"---Section---"` separators
 *   and `"[Text](url)"` links have no folder-meta home and are dropped with a
 *   warning.
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

/** Map a parsed Fumadocs `meta.json` object onto a Blume `FolderMeta`. */
export const translateFumadocsMeta = (
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

  const { pages, warnings: pageWarnings } = filterPages(source.pages);
  if (pages.length > 0) {
    meta.pages = pages;
  }
  warnings.push(...pageWarnings);

  return { meta, warnings };
};
